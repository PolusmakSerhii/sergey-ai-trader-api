import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { prepareRepair, validateOpenTrades, CAS_SCRIPT } from '../api/open-trades-repair.js';
const source = await readFile(new URL('../api/open-trades-repair.js', import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v !== null && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const rows = () => { const r=Array.from({length:12},(_,i)=>({tradeId:`test-${i}`,setupKey:`setup-${i}`,initialPlan:{price:100},outcome:{status:'Active'}}));r.splice(7,0,structuredClone(r[6]));return r; };
// Synthetic test-only module: replace frozen incident hashes in memory, never in production file.
async function fixture(records=rows(),recordHash=hash(canonical(records[6]))) {
  const raw=JSON.stringify(records);
  const code=source.replace("'../lib/private-access.js'",JSON.stringify(new URL('../lib/private-access.js',import.meta.url).href))
    .replace('df4846a7a65455d772d82c09f6c0da674dd71f469198450b5243d4d0892eff96',hash(raw))
    .replace('505800de226d1b229c4a66ce0e9c4a282f7a600e2641cb08022b87e2ffd107c5',recordHash);
  return {raw,module:await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)};
}
async function invoke(f,options={}) {
  const old={...process.env},previous=global.fetch,calls=[];let stored=f.raw;
  Object.assign(process.env,{SM1M_API_SECRET:'test-only-secret-'.repeat(4),UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'hidden-token'});
  global.fetch=async(url,o)=>{
    assert.equal(url,'https://redis.invalid');assert.equal(o.redirect,'error');assert.ok(o.signal);
    const c=JSON.parse(o.body);calls.push(c);
    if(options.failAt===calls.length)throw Error('hidden-token raw-secret');
    if(c[0]==='GET')return {ok:true,json:async()=>({result:calls.length===3&&options.changedReadback?'[]':stored})};
    assert.deepEqual(c.slice(0,4),['EVAL',CAS_SCRIPT,'1','sergey-ai:open-trades:v1']);
    if(options.casMismatch)return {ok:true,json:async()=>({result:0})};
    assert.equal(c[4],stored);stored=c[5];return {ok:true,json:async()=>({result:1})};
  };
  const res={setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;}};
  try{await f.module.default({method:options.method||'POST',headers:{authorization:options.badAuth?'Bearer wrong':`Bearer ${process.env.SM1M_API_SECRET}`},body:{key:'other',index:6},query:{key:'other'}},res);return {res,calls,stored};}
  finally{global.fetch=previous;for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);}
}
test('production incident constants fixed; arbitrary raw rejected',()=>{
  assert.throws(()=>prepareRepair(JSON.stringify(rows())),/SOURCE_CHANGED/);
  assert.match(source,/df4846a7a65455d772d82c09f6c0da674dd71f469198450b5243d4d0892eff96/);
  assert.match(source,/505800de226d1b229c4a66ce0e9c4a282f7a600e2641cb08022b87e2ffd107c5/);
});
test('auth and method reject before storage',async()=>{const f=await fixture();for(const o of [{badAuth:true},{method:'GET'}]){const r=await invoke(f,o);assert.equal(r.calls.length,0);assert.ok([401,405].includes(r.res.code));}});
test('success only removes original index 7 and preserves order; GET CAS GET',async()=>{
 const f=await fixture(),r=await invoke(f);assert.equal(r.res.code,200);assert.equal(r.res.body.status,'REPAIRED_VERIFIED');
 assert.deepEqual(JSON.parse(r.stored),rows().filter((_,i)=>i!==7));assert.deepEqual(r.calls.map(c=>c[0]),['GET','EVAL','GET']);
 assert.equal(r.res.body.preparedRawSha256,hash(r.stored));assert.ok(!JSON.stringify(r.res.body).includes('test-6'));
});
test('changed source and replay produce zero writes',async()=>{const f=await fixture();for(const raw of ['[]',f.module.prepareRepair(f.raw)]){const r=await invoke({...f,raw});assert.equal(r.res.code,409);assert.equal(r.res.body.status,'SOURCE_CHANGED');assert.equal(r.calls.length,1);}});
test('invalid incident preconditions never reach CAS',async()=>{
 for(const modify of [r=>r.pop(),r=>r[7].initialPlan.price++,r=>r[6].outcome.status='Pending',r=>r[1].tradeId=r[0].tradeId,r=>r[1].setupKey=r[0].setupKey,r=>delete r[1].initialPlan]){
 const records=rows();modify(records);const r=await invoke(await fixture(records));assert.equal(r.res.code,409);assert.equal(r.res.body.status,'VALIDATION_FAILED');assert.equal(r.calls.length,1);
 }
 const r=await invoke(await fixture(rows(),'0'.repeat(64)));assert.equal(r.calls.length,1);assert.equal(r.res.code,409);
});
test('CAS race returns 409 without verification or retry',async()=>{const r=await invoke(await fixture(),{casMismatch:true});assert.equal(r.res.body.status,'CAS_MISMATCH');assert.equal(r.res.code,409);assert.equal(r.calls.length,2);});
test('transport ambiguity never retries or claims rollback',async()=>{for(const [n,status] of [[1,'SOURCE_READ_UNAVAILABLE'],[2,'CAS_RESULT_UNKNOWN'],[3,'VERIFICATION_UNAVAILABLE']]){const r=await invoke(await fixture(),{failAt:n});assert.equal(r.calls.length,n);assert.equal(r.res.body.status,status);assert.equal(r.res.code,503);assert.ok(!JSON.stringify(r.res.body).includes('hidden-token'));}});
test('readback changed reports committed write but not verified success',async()=>{const r=await invoke(await fixture(),{changedReadback:true});assert.equal(r.res.code,409);assert.equal(r.res.body.status,'VERIFICATION_CHANGED');assert.equal(r.res.body.writeConfirmed,true);});
test('semantic validation matches required truthiness, status and uniqueness',()=>{
 for(const k of ['tradeId','setupKey','initialPlan']){const r=rows().slice(0,6);r[0][k]=null;assert.throws(()=>validateOpenTrades(r));}
 for(const status of ['WaitingEntry','Pending','Active']){const r=rows().slice(0,6);r[0].outcome.status=status;assert.doesNotThrow(()=>validateOpenTrades(r));}
 const r=rows().slice(0,6);r[0].outcome.status='Closed';assert.throws(()=>validateOpenTrades(r));
});
