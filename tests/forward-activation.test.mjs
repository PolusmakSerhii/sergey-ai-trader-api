import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import handler,{activateShadow} from '../api/forward-activation.js';
import {REGISTRY_KEY,REGISTRY_LUA,VERSION,RUN_ID,createSourceRegistry} from '../lib/forward-validation/source-registry.js';
const exec=promisify(execFile);
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;}});
const secret='test-private-'.repeat(4),token='test-redis-'.repeat(4);
const meta=at=>({registryVersion:VERSION,runId:RUN_ID,protocolVersion:'1.1',activatedAt:at,activationSourceBoundary:at});

test('activation endpoint and real primitives: isolated Unix Redis, no external requests',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'forward-activation-')),socket=join(dir,'redis.sock');
 const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
 const redis=async cmd=>{const {stdout}=await exec('redis-cli',['-s',socket,'--json',...cmd.map(String)],{maxBuffer:12*1024*1024});if(stdout.startsWith('error:'))throw Error('LOCAL_REDIS');return JSON.parse(stdout);};
 const originalFetch=global.fetch,oldEnv={...process.env};
 const calls=[];
 const fetchMock=async(url,options)=>{
  assert.equal(url,'https://redis.invalid');assert.equal(options.headers.Authorization,`Bearer ${token}`);
  assert.equal(options.redirect,'error');assert.equal(options.headers['Content-Type'],'application/json');assert.ok(options.signal);
  const cmd=JSON.parse(options.body);calls.push(cmd);return {ok:true,json:async()=>({result:await redis(cmd)})};
 };
 const invoke=async(extra={})=>{const res=response();await handler({method:'POST',headers:{authorization:`Bearer ${secret}`},...extra},res);return res;};
 const clear=async()=>{await redis(['FLUSHDB']);calls.length=0;};
 const state=async()=>JSON.parse(await redis(['GET',REGISTRY_KEY]));
 const partial=async()=>{const at=new Date(Date.now()+30000).toISOString();assert.equal((await createSourceRegistry(redis).activate(meta(at))).status,'ACTIVATED');return at;};
 try{
  let ready=false;for(let i=0;i<100;i++){try{await redis(['PING']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,20));}}assert.ok(ready);
  Object.assign(process.env,{SM1M_API_SECRET:secret,UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:token});global.fetch=fetchMock;
  await t.test('unauthorized rejected without storage access',async()=>{const r=await invoke({headers:{}});assert.equal(r.code,401);assert.equal(calls.length,0);assert.equal(r.headers['Cache-Control'],'private, no-store');});
  await t.test('GET rejected without storage access',async()=>{const r=await invoke({method:'GET'});assert.equal(r.code,405);assert.equal(calls.length,0);});
  await t.test('fresh activation readbacks precede Registry then Epoch; fixed metadata, server TIME',async()=>{
   await clear();const r=await invoke({body:{activatedAt:'2000-01-01T00:00:00.000Z',epochId:'evil'},query:{activatedAt:'2099-01-01T00:00:00.000Z'}});
   assert.equal(r.code,200);assert.equal(r.body.status,'ACTIVATED');assert.equal(r.headers['Cache-Control'],'private, no-store');
   assert.deepEqual(calls.slice(0,3).map(x=>x[0]),['GET','GET','TIME']);
   const writes=calls.filter(x=>x[0]==='EVAL');assert.equal(writes.length,2);assert.equal(writes[0][1],REGISTRY_LUA);assert.notEqual(writes[1][1],REGISTRY_LUA);
   const s=await state(),a=JSON.parse(s.activation),e=s.epoch.activation;assert.deepEqual(a,meta(a.activatedAt));
   assert.deepEqual(e,{epochVersion:'forward-source-epoch-v1',registryVersion:VERSION,runId:RUN_ID,protocolVersion:'1.1',epochId:'sm1m-shadow-forward-v1',status:'ACTIVE',activatedAt:a.activatedAt,sourceLowerBound:a.activatedAt});
   assert.ok(Date.parse(a.activatedAt)>Date.now());assert.equal(r.body.activatedAt,a.activatedAt);assert.ok(!JSON.stringify(r).includes(secret));assert.ok(!JSON.stringify(r).includes(token));
  });
  await t.test('exact replay returns existing activation without TIME or writes',async()=>{const before=await redis(['GET',REGISTRY_KEY]);calls.length=0;const r=await invoke();assert.equal(r.body.status,'ALREADY_ACTIVE');assert.deepEqual(calls.map(c=>c[0]),['GET','GET']);assert.equal(await redis(['GET',REGISTRY_KEY]),before);});
  await t.test('Redis TIME determines boundary, not local/client clock',async()=>{
   await clear();const future=Date.now()+3600000;const r=await activateShadow(c=>c[0]==='TIME'?Promise.resolve([String(Math.floor(future/1000)),'123000']):redis(c));
   assert.equal(r.status,'ACTIVATED');assert.equal(r.activatedAt,new Date(Math.floor(future/1000)*1000+123+30000).toISOString());
  });
  await t.test('lost Registry acknowledgement readback confirms write then continues',async()=>{await clear();const r=await activateShadow(async c=>{const value=await redis(c);if(c[0]==='EVAL'&&c[1]===REGISTRY_LUA)throw Error(token);return value;});assert.equal(r.status,'ACTIVATED');});
  await t.test('Registry timeout before commit does not attempt Epoch',async()=>{await clear();let writes=0;const r=await activateShadow(async c=>{if(c[0]==='EVAL'){writes++;throw Error(token);}return redis(c);});assert.equal(r.status,'UNRESOLVED');assert.equal(writes,1);assert.equal(await state(),null);});
  await t.test('Epoch failure preserves Registry; next invocation resumes exact boundary',async()=>{
   await clear();const r=await activateShadow(async c=>{if(c[0]==='EVAL'&&c[1]!==REGISTRY_LUA)throw Error(token);return redis(c);});
   assert.equal(r.status,'PARTIAL');const s=await state();assert.equal(s.epoch,undefined);const at=s.activationAt;
   const resumed=await activateShadow(redis);assert.equal(resumed.status,'ACTIVATED');assert.equal(resumed.activatedAt,at);assert.equal((await state()).activation,s.activation);
  });
  await t.test('lost Epoch acknowledgement resolved by readback',async()=>{await clear();const r=await activateShadow(async c=>{const value=await redis(c);if(c[0]==='EVAL'&&c[1]!==REGISTRY_LUA)throw Error(token);return value;});assert.equal(r.status,'ACTIVATED');});
  await t.test('partial past boundary is never moved or retried',async()=>{
   await clear();await partial();const s=await state(),at='2020-01-01T00:00:00.000Z';s.activationAt=at;s.activation=JSON.stringify(meta(at));await redis(['SET',REGISTRY_KEY,JSON.stringify(s)]);
   const before=await redis(['GET',REGISTRY_KEY]);const r=await activateShadow(redis);assert.equal(r.status,'PARTIAL');assert.equal(r.reasonCode,'BOUNDARY_ELAPSED');assert.equal(await redis(['GET',REGISTRY_KEY]),before);
  });
  await t.test('expired during Epoch write fails closed without moving Registry',async()=>{
   await clear();await partial();const r=await activateShadow(async c=>{if(c[0]==='EVAL')return -1;return redis(c);});assert.equal(r.status,'PARTIAL');assert.equal(r.reasonCode,'EPOCH_CONFLICT');assert.equal((await state()).epoch,undefined);
  });
  await t.test('incompatible Registry fails closed without writes',async()=>{await clear();await partial();const s=await state();s.activation=JSON.stringify({...meta(s.activationAt),runId:'other'});await redis(['SET',REGISTRY_KEY,JSON.stringify(s)]);const before=await redis(['GET',REGISTRY_KEY]);const r=await activateShadow(redis);assert.equal(r.status,'CONFLICT');assert.equal(await redis(['GET',REGISTRY_KEY]),before);});
  await t.test('incompatible existing Epoch fails closed; no secrets echoed',async()=>{await clear();await activateShadow(redis);const s=await state();s.epoch.activation.epochId=token;await redis(['SET',REGISTRY_KEY,JSON.stringify(s)]);const r=await activateShadow(redis);assert.equal(r.status,'CONFLICT');assert.ok(!JSON.stringify(r).includes(token));});
  await t.test('malformed registry/failed readback never treated as absent',async()=>{await clear();await redis(['SET',REGISTRY_KEY,'invalid']);const r=await activateShadow(redis);assert.equal(r.status,'UNRESOLVED');assert.equal(await redis(['GET',REGISTRY_KEY]),'invalid');});
  await t.test('transport errors contain no credential details',async()=>{global.fetch=async()=>{throw Error(secret+token);};try{const r=await invoke();assert.equal(r.code,503);assert.equal(r.body.status,'UNRESOLVED');assert.ok(!JSON.stringify(r).includes(secret));assert.ok(!JSON.stringify(r).includes(token));}finally{global.fetch=fetchMock;}});
  await t.test('failed readback after Registry write blocks further activation',async()=>{
   await clear();let written=false;const r=await activateShadow(async c=>{if(written&&c[0]==='GET')throw Error('unknown');const v=await redis(c);if(c[0]==='EVAL')written=true;return v;});assert.equal(r.status,'UNRESOLVED');assert.ok(await state());assert.equal((await state()).epoch,undefined);
  });
  await t.test('invalid clock fails closed',async()=>{await clear();const r=await activateShadow(c=>c[0]==='TIME'?Promise.resolve(['bad','0']):redis(c));assert.equal(r.reasonCode,'CLOCK_UNAVAILABLE');assert.equal(await state(),null);});
  await t.test('storage bound preserves existing Registry',async()=>{await clear();await partial();const s=await state();s.receipts=50000;await redis(['SET',REGISTRY_KEY,JSON.stringify(s)]);const before=await redis(['GET',REGISTRY_KEY]);const r=await activateShadow(redis);assert.equal(r.status,'PARTIAL');assert.equal(r.reasonCode,'BLOCKED_STORAGE');assert.equal(await redis(['GET',REGISTRY_KEY]),before);});
  await t.test('concurrent first calls cannot move the winning boundary',async()=>{
   await clear();const results=await Promise.all([activateShadow(redis),activateShadow(redis)]);
   assert.ok(results.some(r=>['ACTIVATED','ALREADY_ACTIVE'].includes(r.status)));const s=await state();
   assert.equal(s.epoch.activation.activatedAt,s.activationAt);assert.equal((await activateShadow(redis)).status,'ALREADY_ACTIVE');
  });
  await t.test('concurrent different Epoch boundary is reported as conflict',async()=>{
   await clear();await partial();let changed=false;
   const r=await activateShadow(async c=>{
    if(c[0]==='EVAL'&&!changed){changed=true;const s=await state(),at=new Date(Date.parse(s.activationAt)+1000).toISOString();
     s.epoch={activation:{epochVersion:'forward-source-epoch-v1',registryVersion:VERSION,runId:RUN_ID,protocolVersion:'1.1',epochId:'sm1m-shadow-forward-v1',status:'ACTIVE',activatedAt:at,sourceLowerBound:at},sequence:0,sealedThrough:null,seals:[]};
     await redis(['SET',REGISTRY_KEY,JSON.stringify(s)]);
    }return redis(c);
   });assert.equal(r.status,'CONFLICT');assert.equal(r.reasonCode,'CONCURRENT_ACTIVATION');
  });
  await t.test('no storage configuration fails closed',async()=>{delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.KV_REST_API_URL;try{const r=await invoke();assert.equal(r.code,503);assert.equal(r.body.reasonCode,'STORAGE_UNAVAILABLE');}finally{process.env.UPSTASH_REDIS_REST_URL='https://redis.invalid';}});
 }finally{
  global.fetch=originalFetch;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv);
  server.kill();await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));await rm(dir,{recursive:true,force:true});
 }
});
