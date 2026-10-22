import test from 'node:test';
import assert from 'node:assert/strict';
import {storageHealth,logStorageHealth} from '../lib/forward-validation/storage-health.js';
import {readObservations} from '../lib/forward-validation/observation-reader.js';
import {runTick} from '../api/forward-tick.js';
import {runWorker} from '../lib/forward-validation/worker.js';
const metrics=cycles=>({cycles,observations:0,payloadBytes:0,serializedBytes:0});
for(const [n,status] of [[0,'OK'],[6999,'OK'],[7000,'WARNING'],[8499,'WARNING'],[8500,'CRITICAL']])
 test(`threshold ${n}/10000`,()=>assert.equal(storageHealth(metrics(n)).status,status));
test('largest individual budget controls status',()=>{
 for(const [key,limit] of [['observations',50000],['payloadBytes',6291456],['serializedBytes',8388608]]){
  const h=storageHealth({...metrics(0),[key]:Math.ceil(limit*.85)});assert.equal(h.status,'CRITICAL');assert.equal(h.utilization.max,Math.ceil(limit*.85)/limit);
 }
});
test('missing invalid metrics remain unknown',()=>{
 for(const m of [null,{},metrics(NaN),metrics(-1),metrics(.5),metrics('2')])assert.equal(storageHealth(m).status,'UNKNOWN');
});
test('safe allowlist and envelope caveat',()=>{
 const h=storageHealth({...metrics(0),raw:'secret',symbols:['private'],credentials:'secret'});
 assert.ok(!JSON.stringify(h).includes('secret'));assert.ok(!JSON.stringify(h).includes('private'));assert.equal(h.envelopeAppendGuaranteed,false);
});
test('explicit F2 rejection remains blocked',()=>{assert.equal(storageHealth(null,true).status,'BLOCKED');assert.equal(storageHealth(metrics(1),true).status,'BLOCKED');});
test('reader reuses exactly one GET and reports empty metrics',async()=>{
 let calls=0,h;assert.deepEqual(await readObservations(async c=>{calls++;assert.equal(c[0],'GET');return null;},m=>h=m),[]);
 assert.equal(calls,1);assert.deepEqual(h,metrics(0));
});
test('reader exact serialized bytes and counters',async()=>{
 const raw=JSON.stringify({schemaVersion:'forward-observation-ledger-v1',cycles:{},count:0,observations:0,payloadBytes:0});let h;
 await readObservations(async()=>raw,m=>h=m);assert.equal(h.serializedBytes,Buffer.byteLength(raw));assert.equal(h.cycles,0);
});
test('corrupt reader does not report OK',async()=>{let h=storageHealth(null);await assert.rejects(()=>readObservations(async()=>'{',m=>h=storageHealth(m)));assert.equal(h.status,'UNKNOWN');});
test('hard F2 byte overflow reports BLOCKED without weakening validation',async()=>{let h;await assert.rejects(()=>readObservations(async()=>'x'.repeat(8388609),m=>h=storageHealth(m,m.blocked)));assert.equal(h.status,'BLOCKED');});
test('monitor callback cannot break reader',async()=>{assert.deepEqual(await readObservations(async()=>null,()=>{throw Error('monitor');}),[]);});
test('real worker BUSY still exposes metrics from existing F2 read',async()=>{
 let h,reads=0;const result=await runWorker({execute:async c=>{if(c[0]==='GET'){reads++;return null;}if(c[0]==='EVAL')return ['BUSY'];throw Error('unexpected');},onStorage:m=>h=m});
 assert.equal(result.status,'BUSY');assert.equal(reads,1);assert.deepEqual(h,metrics(0));
});
for(const status of ['COMPLETE','IDLE','BUSY','BLOCKED_MAPPING','UNRESOLVED','BLOCKED_STORAGE'])test(`tick preserves ${status}`,async()=>{
 let life=0,gets=0;const r=await runTick({execute:async c=>{if(c[0]==='GET')gets++;return c[0]==='SET'?'OK':1;},worker:async({onStorage})=>{onStorage(metrics(8500));return {status};},loadLifecycle:async()=>({}),lifecycle:async()=>{life++;return {status:'IDLE'};}});
 assert.equal(life,['COMPLETE','IDLE'].includes(status)?1:0);assert.equal(r.status,life?'IDLE':status);assert.equal(r.storage.status,'CRITICAL');assert.equal(gets,0);
});
test('outer lock BUSY reports UNKNOWN, no extra read',async()=>{let n=0;const r=await runTick({execute:async()=>{n++;return null;},worker:async()=>assert.fail()});assert.equal(r.status,'BUSY');assert.equal(r.storage.status,'UNKNOWN');assert.equal(n,1);});
test('worker failure never fabricates health',async()=>{const r=await runTick({execute:async c=>c[0]==='SET'?'OK':1,worker:async()=>{throw Error('secret');}});assert.equal(r.status,'UNRESOLVED');assert.equal(r.storage.status,'UNKNOWN');assert.ok(!JSON.stringify(r).includes('secret'));});
test('structured log uses one severity-appropriate call',()=>{
 for(const [status,level]of [['OK','log'],['WARNING','warn'],['CRITICAL','error'],['BLOCKED','error'],['UNKNOWN','warn']]){
  const old=console[level];let count=0;console[level]=(...args)=>{count++;assert.equal(args[0],'[forward-f2-storage]');assert.equal(JSON.parse(args[1]).status,status);};
  try{logStorageHealth({status});assert.equal(count,1);}finally{console[level]=old;}
 }
});
