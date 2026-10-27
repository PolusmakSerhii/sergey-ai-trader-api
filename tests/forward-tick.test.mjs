import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {Readable} from 'node:stream';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHandler,runTick,DESTINATION,SIGNED_BODY,config} from '../api/forward-tick.js';
const {Receiver}=await import(process.env.SM1M_QSTASH_TEST_MODULE||'@upstash/qstash');
const key='test-qstash-current-key',next='test-qstash-next-key',secret='test-secret-do-not-expose';
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
function sign({sub=DESTINATION,body=SIGNED_BODY,signingKey=key,expired=false}={}){
 const now=Math.floor(Date.now()/1000),jwt=encode({alg:'HS256',typ:'JWT'})+'.'+encode({iss:'Upstash',sub,iat:now,nbf:now-5,exp:now+(expired?-1:60),body:createHash('sha256').update(body).digest('base64url')});
 return jwt+'.'+createHmac('sha256',signingKey).update(jwt).digest('base64url');
}
const res=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;}});
const req=({body=SIGNED_BODY,signature=sign(),url='/api/forward-tick',method='POST',headers={}}={})=>Object.assign(Readable.from([body]),{method,url,headers:{'upstash-signature':signature,...headers}});

test('real QStash signature and fixed transport contract',async t=>{
 const old={...process.env},fetch=global.fetch;let called=0;
 Object.assign(process.env,{QSTASH_CURRENT_SIGNING_KEY:key,QSTASH_NEXT_SIGNING_KEY:next,UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:secret});
 global.fetch=async()=>{throw Error('NO NETWORK');};
 const handler=createHandler({receiverClass:async()=>Receiver,tick:async()=>{called++;return {status:'IDLE'};}});
 try{
  for(const [name,options,code]of [
   ['missing signature',{signature:undefined},401],['invalid signature',{signature:'bad'},401],
   ['wrong signed destination',{signature:sign({sub:'https://sergey-ai-trader-api.vercel.app/api/market'})},401],
   ['wrong request destination',{url:'/api/forward-worker'},403],['query rejected',{url:'/api/forward-tick?x=1'},403],
   ['wrong signed body',{signature:sign({body:''})},401],['wrong actual body',{body:'{"x":1}'},400],
   ['whitespace body',{body:' {}'},400],['expired signature',{signature:sign({expired:true})},401],
   ['Bearer cannot replace signature',{signature:'',headers:{authorization:`Bearer ${secret}`}},401],['GET',{method:'GET'},405]]){
   await t.test(name,async()=>{const before=called,r=res(),request=req(options);if(name==='missing signature')delete request.headers['upstash-signature'];await handler(request,r);assert.equal(r.code,code);assert.equal(called,before);assert.equal(r.headers['Cache-Control'],'private, no-store');});
  }
  for(const signingKey of [key,next])await t.test(`valid signature with ${signingKey===key?'current':'next'} key`,async()=>{const r=res();await handler(req({signature:sign({signingKey})}),r);assert.equal(r.code,200);assert.equal(r.body.status,'IDLE');});
  await t.test('exception details never returned',async()=>{const h=createHandler({receiverClass:async()=>Receiver,tick:async()=>{throw Error(key+secret);}}),r=res();await h(req(),r);assert.equal(r.code,503);assert.ok(!JSON.stringify(r).includes(key));assert.ok(!JSON.stringify(r).includes(secret));});
  await t.test('Redis transport is server-only bounded POST',async()=>{global.fetch=async(url,o)=>{assert.equal(url,'https://redis.invalid');assert.equal(o.headers.Authorization,`Bearer ${secret}`);assert.equal(o.redirect,'error');assert.ok(o.signal);assert.deepEqual(JSON.parse(o.body),['TIME']);return {ok:true,json:async()=>({result:['1','0']})};};const h=createHandler({receiverClass:async()=>Receiver,tick:async({execute})=>{assert.deepEqual(await execute(['TIME']),['1','0']);return {status:'IDLE'};}}),r=res();await h(req(),r);assert.equal(r.code,200);assert.ok(!JSON.stringify(r).includes(secret));});
  await t.test('no signing configuration fails closed',async()=>{delete process.env.QSTASH_CURRENT_SIGNING_KEY;const r=res();await handler(req(),r);assert.equal(r.code,503);process.env.QSTASH_CURRENT_SIGNING_KEY=key;});
 }finally{global.fetch=fetch;for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);}
});

test('orchestration and actual Lua lock on isolated Unix Redis',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sm1m-tick-')),socket=join(dir,'redis.sock'),exec=promisify(execFile);
 const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
 const redis=async c=>{const {stdout}=await exec('redis-cli',['-s',socket,'--json',...c.map(String)]);if(stdout.startsWith('error:'))throw Error('REDIS');return JSON.parse(stdout);};
 const lock='sergey-ai:forward-tick:v1:lock';
 const call=options=>runTick({execute:redis,loadLifecycle:async()=>({syntheticAdapter:true}),...options});
 try{
  let ready=false;for(let i=0;i<100;i++){try{await redis(['PING']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,20));}}assert.ok(ready);
  for(const w of ['COMPLETE','IDLE'])for(const l of ['COMPLETE','IDLE','BUSY','UNRESOLVED'])await t.test(`${w} worker then ${l} lifecycle; release`,async()=>{
   const order=[];const r=await call({worker:async()=>{order.push('worker');return {status:w};},lifecycle:async()=>{order.push('lifecycle');return {status:l};}});
   assert.deepEqual(order,['worker','lifecycle']);assert.equal(r.status,l);assert.equal(r.workerStatus,w);assert.equal(r.lifecycleStatus,l);assert.equal(await redis(['GET',lock]),null);
  });
  for(const status of ['BUSY','BLOCKED_MAPPING','UNRESOLVED','BLOCKED_STORAGE','CONFLICT','unknown'])await t.test(`worker ${status} stops without lifecycle/retry`,async()=>{
   let calls=0;const r=await call({worker:async()=>{calls++;return {status,reasonCode:secret};},loadLifecycle:async()=>{assert.fail('must not load');},lifecycle:async()=>assert.fail('must not run')});
   assert.equal(calls,1);assert.equal(r.status,status==='unknown'?'UNRESOLVED':status);assert.ok(!JSON.stringify(r).includes(secret));assert.equal(await redis(['GET',lock]),null);
  });
  for(const phase of ['worker','lifecycle'])await t.test(`${phase} exception releases lock without retry`,async()=>{
   let calls=0;const r=await call({worker:async()=>{if(phase==='worker'){calls++;throw Error(secret);}return {status:'COMPLETE'};},lifecycle:async()=>{calls++;throw Error(secret);}});
   assert.equal(r.status,'UNRESOLVED');assert.equal(r.phase,phase.toUpperCase());assert.equal(calls,1);assert.ok(!JSON.stringify(r).includes(secret));assert.equal(await redis(['GET',lock]),null);
  });
  await t.test('concurrent tick BUSY, no overlap; bounded lock',async()=>{
   let unblock,entered;const waiting=new Promise(r=>entered=r),gate=new Promise(r=>unblock=r);
   const first=call({worker:async()=>{entered();await gate;return {status:'IDLE'};},lifecycle:async()=>({status:'IDLE'})});
   await waiting;try{const ttl=await redis(['PTTL',lock]);assert.ok(ttl>120000&&ttl<=130000);const second=await call({worker:async()=>assert.fail('overlap')});assert.equal(second.status,'BUSY');assert.ok(await redis(['GET',lock]));}finally{unblock();}
   assert.equal((await first).status,'IDLE');assert.equal(await redis(['GET',lock]),null);
  });
  await t.test('cannot release a different owner lock',async()=>{const r=await call({worker:async()=>{await redis(['SET',lock,'other','PX','130000']);return {status:'UNRESOLVED'};}});assert.equal(r.reasonCode,'LOCK_RELEASE_UNCONFIRMED');assert.equal(await redis(['GET',lock]),'other');await redis(['DEL',lock]);});
  await t.test('lost acquire acknowledgement token-safe cleanup, no work',async()=>{const r=await call({execute:async c=>{const v=await redis(c);if(c[0]==='SET')throw Error(secret);return v;},worker:async()=>assert.fail('unknown lock')});assert.equal(r.status,'UNRESOLVED');assert.equal(await redis(['GET',lock]),null);});
  await t.test('release failure explicit, no retries',async()=>{let releases=0;const r=await call({execute:async c=>{if(c[0]==='EVAL'){releases++;throw Error(secret);}return redis(c);},worker:async()=>({status:'IDLE'}),lifecycle:async()=>({status:'IDLE'})});assert.equal(releases,1);assert.equal(r.status,'UNRESOLVED');assert.equal(r.reasonCode,'LOCK_RELEASE_UNCONFIRMED');await redis(['DEL',lock]);});
  await t.test('no lifecycle starts without remaining time budget',async()=>{let clock=0;const r=await call({now:()=>clock,worker:async()=>{clock=60001;return {status:'COMPLETE'};},lifecycle:async()=>assert.fail('deadline')});assert.equal(r.reasonCode,'TICK_DEADLINE');assert.equal(await redis(['GET',lock]),null);});
 }finally{server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));await rm(dir,{recursive:true,force:true});}
});

test('scoped duration and frozen scanner/worker/lifecycle unchanged',async()=>{
 const read=p=>readFile(new URL('../'+p,import.meta.url));
 const gitBlob=b=>createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
 for(const [p,hash]of [['api/market.js','20f7dbb8e662acef14e1bfd81ac946b5ea8b5c4a'],['lib/forward-validation/worker.js','c27af96a3efe4d5a7d77648ebbae2ed84c889fc0'],['lib/forward-validation/lifecycle-worker.js','73c1f25b3df0846da8f5a2b0577c99cd41253172']])assert.equal(gitBlob(await read(p)),hash);
 const v=JSON.parse(await read('vercel.json'));assert.deepEqual(v.functions,{'api/forward-tick.js':{maxDuration:120}});assert.equal(v.crons,undefined);
 assert.deepEqual(v.headers,[{source:'/api/(.*)',headers:[{key:'Content-Security-Policy',value:"default-src 'none'; frame-ancestors 'none'"},{key:'Permissions-Policy',value:'camera=(), geolocation=(), microphone=()'},{key:'Referrer-Policy',value:'no-referrer'},{key:'X-Content-Type-Options',value:'nosniff'},{key:'X-Frame-Options',value:'DENY'}]}]);
 assert.equal(config.api.bodyParser,false);
});


test('safe worker diagnostics preserve HTTP and lifecycle gating',async t=>{
 const old={...process.env},info=console.info,fetch=global.fetch;
 Object.assign(process.env,{QSTASH_CURRENT_SIGNING_KEY:key,QSTASH_NEXT_SIGNING_KEY:next,UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:secret});
 global.fetch=async()=>assert.fail('no network');
 try{
  for(const status of ['BLOCKED_MAPPING','COMPLETE','IDLE','BUSY','UNRESOLVED'])await t.test(status,async()=>{
   const logs=[],order=[];console.info=(...args)=>logs.push(args);
   const h=createHandler({receiverClass:async()=>Receiver,tick:()=>runTick({
    execute:async c=>c[0]==='SET'?'OK':1,
    worker:async()=>{order.push('worker');return {status,reasonCodes:['INVALID_GEOMETRY',secret,'INVALID_GEOMETRY',{},'UNEXPECTED'],reasonCode:'PROCESSING_INCOMPLETE',
     sourceCycleId:secret,payload:{secret},observation:{secret},frozenCandidate:{secret},analysisContext:{secret},message:secret};},
    loadLifecycle:async()=>({}),lifecycle:async()=>{order.push('lifecycle');return {status:'IDLE'};}
   })});
   const r=res();await h(req(),r);
   assert.equal(r.code,['COMPLETE','IDLE','BUSY'].includes(status)?200:503);
   assert.equal(r.body.workerStatus,status);
   assert.deepEqual(r.body.workerReasonCodes,['INVALID_GEOMETRY','PROCESSING_INCOMPLETE']);
   assert.equal(r.body.workerSourceCycleHash,null);
   assert.deepEqual(order,['COMPLETE','IDLE'].includes(status)?['worker','lifecycle']:['worker']);
   const diagnostic=logs.filter(x=>x[0]==='[forward-worker-result]');
   assert.equal(diagnostic.length,['COMPLETE','IDLE'].includes(status)?0:1);
   if(diagnostic.length)assert.deepEqual(JSON.parse(diagnostic[0][1]),{status,reasonCodes:['INVALID_GEOMETRY','PROCESSING_INCOMPLETE'],sourceCycleHash:null});
   const printed=JSON.stringify([r.body,logs]);
   for(const forbidden of [secret,'UNEXPECTED','frozenCandidate','analysisContext','observation','sourceCycleId'])assert.ok(!printed.includes(forbidden));
  });
  await t.test('diagnostic logging failure cannot change worker result',async()=>{
   console.info=()=>{throw Error(secret);};
   const result=await runTick({execute:async c=>c[0]==='SET'?'OK':1,worker:async()=>({status:'BLOCKED_MAPPING',reasonCodes:['MISSING_FROZEN_PLAN']})});
   assert.equal(result.status,'BLOCKED_MAPPING');assert.deepEqual(result.workerReasonCodes,['MISSING_FROZEN_PLAN']);
  });
 }finally{console.info=info;global.fetch=fetch;for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);}
});
