import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {withLocalRedis} from '../scripts/identity-recovery/local-redis.mjs';
import {LUA_SHA256} from '../lib/open-trades-repair-lua.js';
import {fixture,hash} from './helpers/open-trades-repair-fixture.mjs';

test('SHA256 known vectors and byte padding boundaries on real local Redis',()=>withLocalRedis(async redis=>{
 const vectors=['','abc','Привіт 😀','abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',...[55,56,63,64,65,127,128,129,87415].map(n=>'x'.repeat(n))];
 for(const value of vectors){const reply=await redis.command(['EVAL',LUA_SHA256+'return sha256(ARGV[1])','0',value]);assert.equal(reply.value?.toString(),hash(value),reply.error);}
}));
test('incident backup-first exact Lua on isolated Redis Unix socket, TCP disabled',async t=>{
 const f=await fixture(),prepared=f.api.prepareRepair(f.raw),key=f.api.KEY,backup=f.api.BACKUP_KEY,sentinel='synthetic:sentinel';
 await withLocalRedis(async redis=>{
  const command=redis.command;
  const get=async k=>(await command(['GET',k])).value?.toString()??null;
  const run=(raw=f.raw,candidate=prepared,script=f.api.CAS_SCRIPT,keys=[key,backup])=>command(['EVAL',script,'2',...keys,raw,candidate]);
  const reset=async()=>{await command(['DEL',key,backup,sentinel]);await command(['SET',key,f.raw]);await command(['SET',sentinel,'synthetic-sentinel']);};
  const sets=async()=>{const text=(await command(['INFO','commandstats'])).value.toString();return Number(text.match(/(?:^|\r?\n)cmdstat_set:calls=(\d+)/)?.[1]||0);};
  const unchanged=async()=>{assert.equal(await get(key),f.raw);assert.equal(await get(sentinel),'synthetic-sentinel');};
  const shim=mode=>`local actualRedis=redis
local redis={call=function(command,...)
 local args={...}
 if command=='SET' and args[1]==KEYS[2] and ${JSON.stringify(mode)}=='NX_FAILURE' then return false end
 if command=='GET' and args[1]==KEYS[2] and ${JSON.stringify(mode)}=='BACKUP_VERIFY_FAILURE' then return 'synthetic-corruption' end
 if command=='SET' and args[1]==KEYS[1] and ${JSON.stringify(mode)}=='TARGET_WRITE_FAILURE' then error('SYNTHETIC_TARGET_ERROR') end
 return actualRedis.call(command,unpack(args))
end}
`+f.api.CAS_SCRIPT;
  try{
   await t.test('CAS mismatch: zero SET, all stores unchanged',async()=>{await reset();const before=await sets();assert.equal((await run(f.raw+' ')).value,0);assert.equal(await sets(),before);await unchanged();assert.equal(await get(backup),null);});
   await t.test('original SHA and length checked inside Lua before any SET',async()=>{
    for(const raw of [f.raw+' ',f.raw.replace('synthetic-id-0','synthetic-id-X')]){await reset();await command(['SET',key,raw]);const before=await sets();assert.equal((await run(raw)).value,-2);assert.equal(await sets(),before);assert.equal(await get(key),raw);assert.equal(await get(backup),null);}
   });
   await t.test('candidate status/count/identity corruption and lexical normalization reject before SET',async()=>{
    const rows=JSON.parse(prepared);const bads=[JSON.stringify(rows),JSON.stringify(rows.slice(1)),JSON.stringify(rows.map((r,i)=>i===0?{...r,outcome:{status:'Closed'}}:r)),JSON.stringify(rows.map((r,i)=>i===0?{...r,tradeId:123}:r)),JSON.stringify(rows.map((r,i)=>i===1?{...r,setupKey:rows[0].setupKey}:r))];
    for(const bad of bads){await reset();const before=await sets();assert.equal((await run(f.raw,bad)).value,-2);assert.equal(await sets(),before);await unchanged();assert.equal(await get(backup),null);}
   });
   await t.test('independent Lua rejects original invariant defects before either SET',async()=>{
    for(const mutate of [r=>r.pop(),r=>r[2].initialPlan.entryPrice++,r=>r[2].price=1,r=>r[2].unknown=true,r=>r[2].outcome.status='Pending',r=>r[1].tradeId=r[2].tradeId=123,r=>{delete r[1].setupKey;delete r[2].setupKey;},r=>r[4].tradeId=r[3].tradeId]){
     const g=await fixture({mutate});const spans=g.api.recordSpans(g.raw);const candidate=g.raw.slice(0,spans[2].start)+g.raw.slice(spans[3].start);
     await command(['DEL',key,backup,g.api.BACKUP_KEY]);await command(['SET',key,g.raw]);const before=await sets();
     const result=await command(['EVAL',g.api.CAS_SCRIPT,'2',key,g.api.BACKUP_KEY,g.raw,candidate]);assert.equal(result.value,-2);assert.equal(await sets(),before);assert.equal(await get(key),g.raw);assert.equal(await get(g.api.BACKUP_KEY),null);
    }
   });
   await t.test('wrong keys rejected before any SET',async()=>{await reset();const before=await sets();assert.equal((await run(f.raw,prepared,f.api.CAS_SCRIPT,['synthetic:other',backup])).value,-2);assert.equal(await sets(),before);await unchanged();});
   await t.test('backup exists: never overwrite, target unchanged',async()=>{await reset();await command(['SET',backup,'existing-private-backup']);const before=await sets();assert.equal((await run()).value,-1);assert.equal(await sets(),before);assert.equal(await get(backup),'existing-private-backup');await unchanged();});
   await t.test('backup NX failure: target SET unreachable',async()=>{await reset();const before=await sets();assert.equal((await run(f.raw,prepared,shim('NX_FAILURE'))).value,-3);assert.equal(await sets(),before);assert.equal(await get(backup),null);await unchanged();});
   await t.test('backup verification failure: backup remains, target unchanged',async()=>{await reset();const before=await sets();assert.equal((await run(f.raw,prepared,shim('BACKUP_VERIFY_FAILURE'))).value,-4);assert.equal(await sets()-before,1);assert.equal(await get(backup),f.raw);await unchanged();});
   await t.test('runtime error after backup: Redis Lua does not rollback backup; target unchanged',async()=>{await reset();const before=await sets();const result=await run(f.raw,prepared,shim('TARGET_WRITE_FAILURE'));assert.ok(result.error?.includes('SYNTHETIC_TARGET_ERROR'));assert.equal(await sets()-before,1);assert.equal(await get(backup),f.raw);await unchanged();});
   await t.test('success: two SETs, exact original backup and candidate target, no TTL',async()=>{
    await reset();const before=await sets();assert.equal((await run()).value,1);assert.equal(await sets()-before,2);assert.equal(await get(backup),f.raw);assert.equal(await get(key),prepared);assert.equal(hash(await get(backup)),f.evidence.originalSha);assert.equal((await command(['PTTL',backup])).value,-1);assert.equal((await command(['PTTL',key])).value,-1);assert.equal(await get(sentinel),'synthetic-sentinel');
   });
   await t.test('physical replay and later ABA cannot repair twice: permanent NX guard',async()=>{
    await reset();assert.equal((await run()).value,1);const before=await sets();assert.equal((await run()).value,0);assert.equal(await sets(),before);assert.equal(await get(key),prepared);
    await command(['SET',key,f.raw]);const abaBefore=await sets();assert.equal((await run()).value,-1);assert.equal(await sets(),abaBefore);assert.equal(await get(key),f.raw);assert.equal(await get(backup),f.raw);
   });
   await t.test('full existing endpoint GET/EVAL/GET against real isolated Redis',async()=>{
    await reset();const saved={...process.env},oldFetch=globalThis.fetch,commands=[];
    Object.assign(process.env,{SM1M_API_SECRET:'synthetic-owner-secret-'.repeat(4),UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'synthetic'});
    globalThis.fetch=async(_url,options)=>{const c=JSON.parse(options.body);commands.push(c[0]);const result=await command(c);return {ok:true,json:async()=>result.error?{error:'SYNTHETIC_REDIS_ERROR'}:{result:Buffer.isBuffer(result.value)?result.value.toString():result.value}};};
    const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    try{await f.api.default({method:'POST',headers:{authorization:`Bearer ${process.env.SM1M_API_SECRET}`},query:{},body:{}},res);assert.equal(res.code,200);assert.equal(res.body.recordCount,17);assert.deepEqual(commands,['GET','EVAL','GET']);assert.equal(await get(backup),f.raw);assert.equal(await get(key),prepared);}
    finally{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
   });
  }finally{await command(['DEL',key,backup,sentinel]);}
 });
});
test('rollback has no implementation/route: caller cannot activate it accidentally',async()=>{
 const source=await readFile(new URL('../api/open-trades-repair.js',import.meta.url),'utf8');assert.doesNotMatch(source,/export (?:async )?function rollback|ROLLBACK_SCRIPT|req\.(?:query|body)\??\.(?:mode|rollback)/);assert.match(source,/CALLER_OPTIONS_FORBIDDEN/);
});
