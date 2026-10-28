import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import market from '../api/market.js';
import handler, {diagnose,buildHypothetical} from '../api/open-trades-diagnostic.js';
const secret='test-only-private-secret-'.repeat(3);
const record=(id='PRIVATE_ID',setup='PRIVATE_SETUP')=>({tradeId:id,setupKey:setup,symbol:'PRIVATE_SYMBOL',direction:'PRIVATE_DIRECTION',
 initialPlan:{entryPrice:987654321.987,createdAt:'2026-10-22T00:00:00Z',exitStrategy:{version:'tp1-50-reanalyse-v1'}},
 outcome:{status:'Active',lastPriceCheckedAt:'2026-10-23T00:00:00Z',exits:[{price:876543210.987}]},
 capturedAt:'2026-10-24T00:00:00Z',signalId:'PRIVATE_SIGNAL',price:765432109.987});
const encode=rows=>JSON.stringify(rows);
const raw=()=>encode([record(),record()]);
const keys=['rawSha256','rawByteLength','recordCount','nonStringTradeIdCount','nonStringTradeIdEntries','nonStringSetupKeyCount','nonStringSetupKeyEntries','missingTradeIdCount','missingTradeIdIndexes','missingSetupKeyCount','missingSetupKeyIndexes','duplicateTradeIdGroupCount','duplicateSetupKeyGroupCount','duplicateTradeIdGroups','duplicateSetupKeyGroups','parseOpenTradesStatus','parseOpenTradesReason','jsValidatorStatus','jsValidatorReason','automaticRepairCandidate'];
const groupKeys=['identityType','identitySha256','indexes','count','allCanonicalEqual','canonicalSha256ByIndex','frozenDifferingFieldNames','mutableDifferingFieldNames','unknownDifferingFieldNames'];
async function invoke({method='GET',auth=`Bearer ${secret}`,result=raw(),failure=false,configured=true,responseOK=true,envelopeError=false,missingRedisConfig=false,missingResult=false}={}){
 const saved={...process.env},previous=globalThis.fetch,calls=[];
 Object.assign(process.env,{SM1M_API_SECRET:secret,UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'PRIVATE_REDIS_TOKEN'});
 if(!configured)delete process.env.SM1M_API_SECRET;
 if(missingRedisConfig){delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.KV_REST_API_URL;}
 globalThis.fetch=async(url,options)=>{calls.push({url,...options});if(failure)throw Error('PRIVATE_PROVIDER_ERROR');return {ok:responseOK,json:async()=>envelopeError?{error:'PRIVATE_PROVIDER_ERROR'}:missingResult?{}:{result}};};
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
 try{await handler({method,headers:{authorization:auth},query:{key:'OTHER',refresh:'true'},body:{command:'SET',key:'OTHER',repair:true}},res);return {res,calls};}
 finally{globalThis.fetch=previous;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
}
test('auth and method failures perform zero Redis commands',async()=>{
 for(const options of [{auth:''},{auth:'Bearer wrong'},{configured:false},{missingRedisConfig:true},...['POST','PUT','DELETE','PATCH','HEAD'].map(method=>({method}))]){
  const {res,calls}=await invoke(options);assert.ok([401,405,503].includes(res.code));assert.equal(calls.length,0);
 }
});
test('exactly one logical fixed-key GET; no caller forwarding, mutations, redirects or retry',async()=>{
 const {res,calls}=await invoke();assert.equal(res.code,200);assert.equal(calls.length,1);assert.equal(calls[0].method,'POST');assert.equal(calls[0].redirect,'error');
 assert.deepEqual(JSON.parse(calls[0].body),['GET','sergey-ai:open-trades:v1']);assert.equal(res.headers['Cache-Control'],'private, no-store');
 assert.deepEqual(Object.keys(res.body).sort(),keys.sort());
 for(const g of [...res.body.duplicateTradeIdGroups,...res.body.duplicateSetupKeyGroups]){assert.deepEqual(Object.keys(g).sort(),groupKeys.sort());for(const h of g.canonicalSha256ByIndex)assert.deepEqual(Object.keys(h).sort(),['index','sha256']);}
});
test('all transport/missing-key failures are bounded and never retry',async()=>{
 for(const options of [{failure:true},{responseOK:false},{envelopeError:true},{result:null},{missingResult:true},{result:42}]){
  const {res,calls}=await invoke(options);assert.equal(res.code,503);assert.deepEqual(res.body,{error:'DIAGNOSTIC_UNAVAILABLE'});assert.equal(calls.length,1);
 }
});
test('response contains no raw data, values, timestamps, config or old projection',async()=>{
 const {res}=await invoke(),text=JSON.stringify(res.body);
 for(const value of ['PRIVATE_ID','PRIVATE_SETUP','PRIVATE_SYMBOL','PRIVATE_DIRECTION','PRIVATE_SIGNAL','987654321.987','876543210.987','765432109.987','2026-10-22','2026-10-23','2026-10-24','PRIVATE_REDIS_TOKEN','redis.invalid',secret,'tp1-50-reanalyse-v1'])assert.ok(!text.includes(value),value);
 for(const key of ['raw','records','timestamps','versions','progress','initialPlan','outcome','price','symbol'])assert.equal(Object.hasOwn(res.body,key),false);
});
test('exact bridge object identities and frozen read-only surface',async()=>{
 const original=await readFile(new URL('../api/market.js',import.meta.url),'utf8');
 const c=vm.createContext({process:{env:{}},console:{error(){},log(){}},fetch(){assert.fail('network');}});
 vm.runInContext(original.replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler'),c);
 assert.equal(vm.runInContext('handler.openTradesValidation.parseOpenTrades === parseOpenTrades',c),true);
 assert.equal(vm.runInContext('handler.openTradesValidation.validateProposedTradeSignals === validateProposedTradeSignals',c),true);
 assert.equal(Object.isFrozen(market.openTradesValidation),true);assert.deepEqual(Object.keys(market.openTradesValidation),['parseOpenTrades','validateProposedTradeSignals']);
});
test('real market and diagnostic module import has zero network side effects',()=>{
 const url=new URL('../api/market.js',import.meta.url).href,diagnostic=new URL('../api/open-trades-diagnostic.js',import.meta.url).href;
 const script=`import assert from 'node:assert/strict';import http from 'node:http';import https from 'node:https';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';let calls=0;const blocked=()=>{calls++;throw Error('NETWORK_FORBIDDEN');};globalThis.fetch=blocked;http.request=http.get=https.request=https.get=net.connect=net.createConnection=net.Socket.prototype.connect=blocked;syncBuiltinESMExports();process.env.UPSTASH_REDIS_REST_URL='https://redis.invalid';process.env.UPSTASH_REDIS_REST_TOKEN='synthetic';const m=await import(${JSON.stringify(url)});await import(${JSON.stringify(diagnostic)});assert.equal(calls,0);assert.ok(Object.isFrozen(m.default.openTradesValidation));console.log('IMPORT_ZERO_NETWORK');`;
 assert.equal(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'}).trim(),'IMPORT_ZERO_NETWORK');
});
test('canonical-identical duplicates qualify only after exact hypothetical validation',()=>{
 const result=diagnose(raw());assert.equal(result.automaticRepairCandidate,true);assert.equal(result.parseOpenTradesStatus,'REJECT');assert.equal(result.jsValidatorStatus,'REJECT');
 assert.equal(result.duplicateTradeIdGroupCount,1);assert.equal(result.duplicateSetupKeyGroupCount,1);
 const original=market.openTradesValidation;
 for(const failed of ['parseOpenTrades','validateProposedTradeSignals']){
  const validation={...original,[failed](value,...args){const rows=typeof value==='string'?JSON.parse(value):value;if(rows.length===1)throw Error(failed==='parseOpenTrades'?'Invalid or duplicate open trade':'Invalid or duplicate proposed trade signal');return original[failed](value,...args);}};
  assert.equal(diagnose(raw(),validation).automaticRepairCandidate,false);
 }
});
test('first occurrence survives; survivors retain object references and order',()=>{
 const a=record('a','a'),b=record('b','b'),c=record('c','c');const rows=[a,b,structuredClone(a),c,structuredClone(b)];
 const survivors=buildHypothetical(rows);assert.equal(survivors.length,3);assert.equal(survivors[0],a);assert.equal(survivors[1],b);assert.equal(survivors[2],c);assert.equal(rows.length,5);assert.equal(diagnose(encode(rows)).automaticRepairCandidate,true);
 assert.throws(()=>buildHypothetical([a,{...a,price:1}]));
});
const frozen=['tradeId','setupKey','setupId','symbol','direction','initialPlan','entryZone','stopLoss','takeProfit1','takeProfit2','takeProfit3','outcome','action','tradeAllowed','tradeReadiness','opportunityScore','opportunityGrade','confidence','grade','riskReward','researchSnapshot','entryDecision'];
for(const field of frozen)test(`FROZEN ${field}: difference rejects automatic candidate`,()=>{
 const a=record(),b=structuredClone(a);b[field]=field==='tradeId'?'different-id':field==='setupKey'?'different-setup':{changed:true};const r=diagnose(encode([a,b]));const group=[...r.duplicateTradeIdGroups,...r.duplicateSetupKeyGroups][0];assert.ok(group.frozenDifferingFieldNames.includes(field));assert.equal(r.automaticRepairCandidate,false);
});
for(const field of ['capturedAt','signalId','price'])test(`MUTABLE ${field}: no winner rule, candidate false`,()=>{
 const a=record(),r=diagnose(encode([a,{...a,[field]:'different-observation'}]));assert.deepEqual(r.duplicateTradeIdGroups[0].mutableDifferingFieldNames,[field]);assert.equal(r.automaticRepairCandidate,false);
});
for(const field of ['instrumentType','recommendationConfidence','origin','unexpectedExtra'])test(`UNKNOWN ${field}: candidate false`,()=>{
 const a=record(),r=diagnose(encode([a,{...a,[field]:{secret:'PRIVATE_EXTRA'}}]));assert.deepEqual(r.duplicateTradeIdGroups[0].unknownDifferingFieldNames,[field]);assert.equal(r.automaticRepairCandidate,false);assert.ok(!JSON.stringify(r).includes('PRIVATE_EXTRA'));
});
test('nested frozen difference is classified at its frozen container',()=>{
 for(const field of ['initialPlan','outcome','researchSnapshot','entryDecision']){const a={...record(),[field]:{nested:{x:1}}},b=structuredClone(a);b[field].nested.x=2;const r=diagnose(encode([a,b]));assert.deepEqual(r.duplicateTradeIdGroups[0].frozenDifferingFieldNames,[field]);assert.equal(r.automaticRepairCandidate,false);}
});
for(const field of ['tradeId','setupKey'])for(const value of [123,0,false,true,null,[],{}])test(`${field} ${JSON.stringify(value)} rejects with bounded identity type`,()=>{
 const r=diagnose(encode([{...record(),[field]:value}])),prefix=field==='tradeId'?'TradeId':'SetupKey';assert.equal(r[`nonString${prefix}Count`],1);assert.deepEqual(Object.keys(r[`nonString${prefix}Entries`][0]).sort(),['index','type']);assert.equal(r.automaticRepairCandidate,false);assert.equal(r.parseOpenTradesStatus,'REJECT');assert.equal(r.jsValidatorStatus,'REJECT');
});
for(const field of ['tradeId','setupKey'])for(const mode of ['absent','empty','null'])test(`missing ${field}: ${mode}`,()=>{
 const a=record();if(mode==='absent')delete a[field];else a[field]=mode==='empty'?'':null;const r=diagnose(encode([a])),prefix=field==='tradeId'?'TradeId':'SetupKey';assert.equal(r[`missing${prefix}Count`],1);assert.deepEqual(r[`missing${prefix}Indexes`],[0]);assert.equal(r.automaticRepairCandidate,false);
});
for(const input of ['{','{}','null','42','"PRIVATE_ROOT"'])test(`malformed JSON/root ${input} has null unprovable counters`,()=>{
 const r=diagnose(input);for(const key of ['recordCount','nonStringTradeIdCount','nonStringSetupKeyCount','missingTradeIdCount','missingSetupKeyCount','duplicateTradeIdGroupCount','duplicateSetupKeyGroupCount'])assert.equal(r[key],null,key);assert.equal(r.automaticRepairCandidate,false);assert.equal(r.parseOpenTradesStatus,'REJECT');assert.equal(r.jsValidatorStatus,'REJECT');assert.ok(!JSON.stringify(r).includes('PRIVATE_ROOT'));
});
test('multiple groups, duplicate tradeId alone and duplicate setupKey alone',()=>{
 const a=record('a','a'),b=record('b','b');const r=diagnose(encode([a,b,a,b]));assert.equal(r.duplicateTradeIdGroupCount,2);assert.equal(r.duplicateSetupKeyGroupCount,2);assert.deepEqual(r.duplicateTradeIdGroups.map(g=>g.indexes),[[0,2],[1,3]]);assert.equal(r.automaticRepairCandidate,true);
 const x=diagnose(encode([a,{...a,setupKey:'other'}]));assert.equal(x.duplicateTradeIdGroupCount,1);assert.equal(x.duplicateSetupKeyGroupCount,0);assert.equal(x.automaticRepairCandidate,false);
 const y=diagnose(encode([a,{...a,tradeId:'other'}]));assert.equal(y.duplicateTradeIdGroupCount,0);assert.equal(y.duplicateSetupKeyGroupCount,1);assert.equal(y.automaticRepairCandidate,false);
});
test('other validation defects cannot hide behind an identical duplicate',()=>{
 for(const change of [r=>r.initialPlan=null,r=>r.outcome={status:'Closed'},r=>r.outcome=null]){const a=record();change(a);assert.equal(diagnose(encode([a,a])).automaticRepairCandidate,false);}
 assert.equal(diagnose(encode([record(),record(),{...record('b','b'),initialPlan:null}])).automaticRepairCandidate,false);
});
test('canonical hashing sorts nested keys, preserves array order, distinguishes missing/null',()=>{
 const a={...record(),extra:{z:2,a:[{b:1,a:2}]}},b={extra:{a:[{a:2,b:1}],z:2},...record()};const raw=encode([a,b]),r=diagnose(raw);assert.equal(r.automaticRepairCandidate,true);const g=r.duplicateTradeIdGroups[0];assert.equal(g.allCanonicalEqual,true);assert.equal(g.identitySha256,createHash('sha256').update(JSON.stringify(a.tradeId)).digest('hex'));assert.equal(g.canonicalSha256ByIndex[0].sha256,g.canonicalSha256ByIndex[1].sha256);
 assert.equal(r.rawSha256,createHash('sha256').update(raw).digest('hex'));assert.equal(r.rawByteLength,Buffer.byteLength(raw));
 const n=diagnose(encode([record(),{...record(),extra:null}]));assert.deepEqual(n.duplicateTradeIdGroups[0].unknownDifferingFieldNames,['extra']);
 const order=diagnose(encode([{...record(),extra:[1,2]},{...record(),extra:[2,1]}]));assert.equal(order.automaticRepairCandidate,false);
});
test('unexpected validator errors never expose error values',()=>{
 const r=diagnose(raw(),{parseOpenTrades(){throw Error('PRIVATE_EXECUTION');},validateProposedTradeSignals(){throw Error('PRIVATE_EXECUTION');}});assert.equal(r.parseOpenTradesStatus,'EXECUTION_ERROR');assert.equal(r.jsValidatorStatus,'EXECUTION_ERROR');assert.equal(r.parseOpenTradesReason,'VALIDATOR_EXECUTION_ERROR');assert.equal(r.automaticRepairCandidate,false);assert.ok(!JSON.stringify(r).includes('PRIVATE_EXECUTION'));
});
test('empty and unique valid ledgers pass validators without being repair candidates',()=>{
 for(const rows of [[],[record()],[record('a','a'),record('b','b')]]){const r=diagnose(encode(rows));assert.equal(r.parseOpenTradesStatus,'PASS');assert.equal(r.jsValidatorStatus,'PASS');assert.equal(r.automaticRepairCandidate,false);assert.equal(r.parseOpenTradesReason,null);assert.equal(r.jsValidatorReason,null);}
});
