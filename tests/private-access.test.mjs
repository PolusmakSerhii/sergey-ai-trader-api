import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {requirePrivateApi,privateBackendOrigin,internalApiHeaders} from '../lib/private-access.js';
import news from '../api/news.js';
import chat from '../api/chat.js';
import okx from '../api/test-okx.js';
import coinglass from '../api/coinglass-test.js';
process.env.SM1M_API_SECRET='private-api-test-secret-'.repeat(3);
const source=(await readFile(new URL('../api/market.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
const res=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;},end(){}});
const req=(query={},headers={},method='GET')=>({method,headers,query});
function runtime(){const calls=[];const c=vm.createContext({process:{env:{}},URL,Date,AbortSignal,randomUUID,setTimeout,console:{error(){},log(){}},requirePrivateApi,privateBackendOrigin,internalApiHeaders,fetch(){calls.push('fetch');throw Error('Network forbidden');}});vm.runInContext(source,c);for(const name of ['runRedisCommand','registerLiveAnalysisTrade','writeRankingHistory','writeGlobalRankingCache','writeOpenTrades','recordCompletedTradeSignals','readAccountRisk','readValidationArchive'])c[name]=async()=>{calls.push(name);throw Error('unexpected side effect');};return {c,calls};}
for(const query of [{symbol:'TESTUSDT',instrumentType:'SWAP',confirmedAPlus:'true'},{mode:'scanner',globalRank:'true'},{mode:'scanner',global:'true'},{mode:'entry-setups'},{mode:'statistics'},{mode:'validation-archive'},{mode:'risk-manager'},{mode:'chart'},{mode:'ticker'},{mode:'symbols'},{mode:'order-flow'}])test(`unauthorized ${query.mode||'live registration'} denied before data/provider/persistence`,async()=>{for(const headers of [{},{authorization:'Bearer invalid'},{'x-sm1m-analysis-source':'scanner'}]){const {c,calls}=runtime(),r=res();await c.handler(req(query,headers,query.mode==='risk-manager'?'POST':'GET'),r);assert.equal(r.code,401);assert.deepEqual(calls,[]);}});
test('missing production secret fails closed',async()=>{const secret=process.env.SM1M_API_SECRET;delete process.env.SM1M_API_SECRET;try{const {c,calls}=runtime(),r=res();await c.handler(req({mode:'entry-setups'}),r);assert.equal(r.code,503);assert.deepEqual(calls,[]);}finally{process.env.SM1M_API_SECRET=secret;}});
test('authorized ranking reads existing cache and live request reaches normal validation',async()=>{const {c}=runtime();c.readGlobalRankingCache=async()=>({ok:true,ranking:[]});let r=res();const headers={authorization:`Bearer ${process.env.SM1M_API_SECRET}`};await c.handler(req({mode:'scanner',globalRank:'true'},headers),r);assert.equal(r.code,200);r=res();await c.handler(req({symbol:'BTCUSDT',instrumentType:'INVALID'},headers),r);assert.equal(r.code,400);});
test('QStash authorization requires successful existing signature verifier, not header presence',async()=>{for(const verified of [false,true]){const {c,calls}=runtime();let checks=0;c.verifyQStashRequest=async()=>{checks++;return verified;};const r=res();await c.handler(req({mode:'scanner',globalRank:'true',refresh:'true'},{'upstash-signature':'test'},'POST'),r);assert.equal(checks,1);if(!verified){assert.equal(r.code,401);assert.deepEqual(calls,[]);}else{assert.notEqual(r.code,401);}}});
test('internal token can only be sent to configured backend origin',()=>{assert.throws(()=>internalApiHeaders('https://evil.test'));assert.equal(internalApiHeaders(privateBackendOrigin()).Authorization,`Bearer ${process.env.SM1M_API_SECRET}`);assert.ok(!source.includes('const baseUrl = `${protocol}://${host}`'));assert.match(source,/headers: internalApiHeaders\(baseUrl\), redirect: "error"/);});
test('news/chat unauthorized cannot fetch; debug endpoints disabled',async()=>{const old=global.fetch;let calls=0;global.fetch=async()=>{calls++;throw Error('forbidden');};try{for(const handler of [news,chat]){const r=res();await handler(req({}, {},'POST'),r);assert.equal(r.code,401);}for(const handler of [okx,coinglass]){const r=res();await handler(req(),r);assert.equal(r.code,404);}assert.equal(calls,0);}finally{global.fetch=old;}});
test('real QStash SDK accepts signed refresh and rejects tampered signature',async t=>{
 let Receiver;try{({Receiver}=await import(process.env.SM1M_QSTASH_TEST_MODULE||'@upstash/qstash'));}catch(error){if(error.code==='ERR_MODULE_NOT_FOUND'){t.skip('Existing QStash dependency not installed locally');return;}throw error;}
 const {createHmac,createHash}=await import('node:crypto'),key='local-qstash-signing-key-only',now=Math.floor(Date.now()/1000);
 const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
 const unsigned=encode({alg:'HS256',typ:'JWT'})+'.'+encode({iss:'Upstash',sub:'https://sergey-ai-trader-api.vercel.app/api/market',iat:now,nbf:now-1,exp:now+60,body:createHash('sha256').update('').digest('base64url')});
 const signature=unsigned+'.'+createHmac('sha256',key).update(unsigned).digest('base64url');
 for(const valid of [true,false]){
  const {c}=runtime();c.Receiver=Receiver;c.process.env={QSTASH_CURRENT_SIGNING_KEY:key,QSTASH_NEXT_SIGNING_KEY:key};
  let writes=0;c.getRedisConfig=()=>({});c.runRedisCommand=async command=>command[0]==='SET'?'OK':1;
  c.writeGlobalRankingCache=async()=>{writes++;return true;};c.writeRankingHistory=async()=>{writes++;return true;};
  c.fetch=async(url,options)=>{assert.equal(options.headers.Authorization,`Bearer ${process.env.SM1M_API_SECRET}`);assert.equal(new URL(url).origin,privateBackendOrigin());return {ok:true,json:async()=>({ok:true,totalBatches:1,failed:0,globalBatchResults:[{symbol:'TESTUSDT',opportunityScore:80}]})};};
  const r=res();await c.handler(req({mode:'scanner',globalRank:'true',refresh:'true'},{host:'evil.test','upstash-signature':valid?signature:signature+'bad'},'POST'),r);
  assert.equal(r.code,valid?200:401);assert.equal(writes,valid?2:0);
 }
});
