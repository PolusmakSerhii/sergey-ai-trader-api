import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import handler, { diagnose } from '../api/open-trades-diagnostic.js';
const secret = 'test-only-private-secret-'.repeat(3);
const record = () => ({tradeId:'PRIVATE_ID',setupKey:'PRIVATE_SETUP',symbol:'PRIVATE_SYMBOL',direction:'PRIVATE_DIRECTION',
  initialPlan:{entryPrice:987654,createdAt:'2026-10-22T00:00:00Z',exitStrategy:{version:'tp1-50-reanalyse-v1'}},
  outcome:{status:'Active',lastPriceCheckedAt:'2026-10-23T00:00:00Z',reanalysisPending:true,
    exits:[{price:876543,checkedAt:'2026-10-22T01:00:00Z',evidence:{candle:{timestamp:1792627200000,close:765432}}}]}});
const raw = () => JSON.stringify([...Array.from({length:6},(_,i)=>({tradeId:`PRIVATE_OTHER_ID_${i}`,secret:'OTHER_RECORD_SECRET'})),record(),record(),{tradeId:'PRIVATE_NINTH_ID',secret:'NINTH_SECRET'}]);
async function invoke({method='GET',auth=`Bearer ${secret}`,result=raw(),failure=false,configured=true}={}) {
  const saved = {...process.env}, fetchBefore=globalThis.fetch, calls=[];
  process.env.SM1M_API_SECRET=secret;
  process.env.UPSTASH_REDIS_REST_URL='https://redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN='PRIVATE_REDIS_TOKEN';
  if(!configured) delete process.env.SM1M_API_SECRET;
  globalThis.fetch=async(url,options)=>{calls.push({url,...options});if(failure)throw Error('SECRET_TRANSPORT');return {ok:true,json:async()=>({result})};};
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
  try { await handler({method,headers:{authorization:auth},query:{key:'OTHER'},body:{command:'SET'}},res);return {res,calls}; }
  finally {globalThis.fetch=fetchBefore;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
}
test('auth absent, invalid and unconfigured reject before Redis',async()=>{
  for(const options of [{auth:''},{auth:'Bearer wrong'},{configured:false}]){const {res,calls}=await invoke(options);assert.ok([401,503].includes(res.code));assert.equal(calls.length,0);}
});
test('only GET, no writes for any rejected method',async()=>{
  for(const method of ['POST','PUT','DELETE','PATCH','HEAD']){const {res,calls}=await invoke({method});assert.equal(res.code,405);assert.equal(calls.length,0);}
});
test('exactly one fixed Redis GET; no query/body forwarding; no redirects',async()=>{
  const {res,calls}=await invoke();assert.equal(res.code,200);assert.equal(calls.length,1);
  assert.deepEqual(JSON.parse(calls[0].body),['GET','sergey-ai:open-trades:v1']);assert.equal(calls[0].redirect,'error');
  assert.equal(res.headers['Cache-Control'],'private, no-store');assert.deepEqual(res.body.records.map(r=>r.index),[6,7]);
});
test('deterministic hashes match diagnostic identity convention and exact raw bytes',()=>{
  const input=raw(),a=diagnose(input),hash=s=>createHash('sha256').update(s).digest('hex');
  assert.deepEqual(a,diagnose(input));assert.equal(a.rawSha256,hash(input));assert.equal(a.rawByteLength,Buffer.byteLength(input));
  assert.equal(a.records[0].tradeIdHash,hash(JSON.stringify('PRIVATE_ID')).slice(0,16));
  const parsed=JSON.parse(input);parsed[7].initialPlan={exitStrategy:parsed[7].initialPlan.exitStrategy,createdAt:parsed[7].initialPlan.createdAt,entryPrice:987654};
  assert.equal(diagnose(JSON.stringify(parsed)).comparison.initialPlan,'SAME');
});
test('sensitive fields and other records never returned',async()=>{
  const {res}=await invoke();const output=JSON.stringify(res.body);
  for(const value of ['PRIVATE_ID','PRIVATE_SETUP','PRIVATE_SYMBOL','PRIVATE_DIRECTION','987654','876543','765432','OTHER_RECORD_SECRET','NINTH_SECRET','PRIVATE_REDIS_TOKEN',secret])assert.ok(!output.includes(value),value);
  assert.equal(res.body.records[0].arrayCounts['outcome.exits'],1);
  assert.equal(res.body.records[0].timestamps['outcome.lastPriceCheckedAt'],'2026-10-23T00:00:00.000Z');
});
test('unsafe timestamp/version/status values sanitized; presence and comparison',()=>{
  const rows=JSON.parse(raw());rows[7].outcome.status='PRIVATE_STATUS';rows[7].outcome.checkedAt='PRIVATE_TIME';
  rows[7].revision='PRIVATE_REVISION';rows[7].setupKey='DIFFERENT_PRIVATE_SETUP';rows[7].extra=null;
  const output=diagnose(JSON.stringify(rows));assert.equal(output.records[1].outcome.status,'OTHER');
  assert.equal(output.records[1].timestamps['outcome.checkedAt'],'INVALID');assert.equal(output.comparison.setupKey,'DIFFERENT');
  assert.deepEqual(output.comparison.onlyIn7,['extra','revision']);assert.ok(!JSON.stringify(output).includes('PRIVATE_'));
});
test('malformed JSON, ledger, missing indexes and transport fail closed with no retry',async()=>{
  for(const result of ['{','{}','[]',null,JSON.stringify([0,0,0,0,0,0,null,{}])]){
    const {res,calls}=await invoke({result});assert.equal(res.code,503);assert.deepEqual(res.body,{error:'DIAGNOSTIC_UNAVAILABLE'});assert.equal(calls.length,1);
  }
  const {res,calls}=await invoke({failure:true});assert.equal(res.code,503);assert.equal(calls.length,1);assert.ok(!JSON.stringify(res.body).includes('SECRET_TRANSPORT'));
});

test('all-record fingerprint count, exact fields, full hashes and duplicate multiplicity',()=>{
 const input=raw(),rows=JSON.parse(input),out=diagnose(input);
 assert.equal(out.recordCount,9);assert.equal(out.recordFingerprints.length,9);
 for(const [i,f]of out.recordFingerprints.entries()){
  assert.deepEqual(Object.keys(f).sort(),['canonicalSha256','index','tradeIdSha256']);assert.equal(f.index,i);
  assert.match(f.canonicalSha256,/^[a-f0-9]{64}$/);assert.match(f.tradeIdSha256,/^[a-f0-9]{64}$/);
  assert.equal(f.tradeIdSha256,createHash('sha256').update(rows[i].tradeId).digest('hex'));
  assert.ok(!JSON.stringify(out).includes(rows[i].tradeId));
 }
 assert.equal(out.recordFingerprints[6].canonicalSha256,out.recordFingerprints[7].canonicalSha256);
 assert.equal(out.records6And7CanonicalEqual,true);
 assert.deepEqual(out.records.map(r=>r.canonicalSha256),[out.recordFingerprints[6].canonicalSha256,out.recordFingerprints[7].canonicalSha256]);
 assert.equal(Object.hasOwn(out,'raw'),false);assert.equal(Object.hasOwn(out,'ledger'),false);assert.equal(out.records.length,2);
});
test('canonical algorithm recursively sorts keys but preserves array order and all values',()=>{
 const rows=JSON.parse(raw());
 rows[6]={tradeId:'PRIVATE_CANONICAL',nested:{z:2,a:[{y:3,x:4},5]},outcome:{status:'Active'}};
 rows[7]={outcome:{status:'Active'},nested:{a:[{x:4,y:3},5],z:2},tradeId:'PRIVATE_CANONICAL'};
 const out=diagnose(JSON.stringify(rows));
 const expected='{"nested":{"a":[{"x":4,"y":3},5],"z":2},"outcome":{"status":"Active"},"tradeId":"PRIVATE_CANONICAL"}';
 assert.equal(out.records[0].canonicalSha256,createHash('sha256').update(expected).digest('hex'));
 assert.equal(out.records[0].canonicalSha256,out.records[1].canonicalSha256);assert.equal(out.records6And7CanonicalEqual,true);
 rows[7].nested.a.reverse();const changed=diagnose(JSON.stringify(rows));
 assert.notEqual(changed.records[0].canonicalSha256,changed.records[1].canonicalSha256);assert.equal(changed.records6And7CanonicalEqual,false);
});
test('full record hashes detect fields omitted from safe summaries without exposing values',()=>{
 const baseline=diagnose(raw());
 for(const change of [r=>r.price=123456789,r=>r.initialPlan.entryPrice++,r=>r.outcome.exits[0].price++,
  r=>r.outcome.extra={privateValue:'DO_NOT_RETURN'},r=>delete r.direction]){
  const rows=JSON.parse(raw());change(rows[7]);const out=diagnose(JSON.stringify(rows));
  assert.equal(out.records[0].canonicalSha256,baseline.records[0].canonicalSha256);
  assert.notEqual(out.records[1].canonicalSha256,baseline.records[1].canonicalSha256);
  assert.equal(out.records6And7CanonicalEqual,false);
  assert.equal(out.recordFingerprints[7].tradeIdSha256,baseline.recordFingerprints[7].tradeIdSha256);
  const fingerprints=JSON.stringify(out.recordFingerprints);
  for(const value of ['PRIVATE_ID','PRIVATE_SETUP','entryPrice','123456789','DO_NOT_RETURN'])assert.ok(!fingerprints.includes(value));
  assert.ok(!JSON.stringify(out).includes('DO_NOT_RETURN'));
 }
});
test('invalid all-record identities fail closed without partial output or extra Redis calls',async()=>{
 for(const bad of [null,{}, {tradeId:null},{tradeId:123},{tradeId:''}]){
  const rows=JSON.parse(raw());rows[0]=bad;const {res,calls}=await invoke({result:JSON.stringify(rows)});
  assert.equal(res.code,503);assert.deepEqual(res.body,{error:'DIAGNOSTIC_UNAVAILABLE'});
  assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0].body),['GET','sergey-ai:open-trades:v1']);
 }
});
