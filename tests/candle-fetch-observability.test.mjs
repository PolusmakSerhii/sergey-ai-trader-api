import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const current=readFileSync(new URL('../api/market.js',import.meta.url),'utf8');
const original=execFileSync('git',['show','47aa9fce15c32db04dd23801a52fe6c2c37b4a33:api/market.js'],{encoding:'utf8'});
const from=Date.parse('2026-11-14T00:00:00Z'), minute=60000;
const row=(i,patch={})=>Object.assign([String(from+i*minute),'100','101','99','100','1','1','1','1'],patch);
const response=(data,status=200,code='0')=>({ok:status>=200&&status<300,status,json:async()=>({code,data})});
function runtime(source,fixture,loggerThrows=false){
 const logs=[],calls=[];
 const ctx=vm.createContext({process:{env:{}},Date,URL,AbortSignal,console:{warn:s=>{logs.push(JSON.parse(s));if(loggerThrows)throw Error('logger failed');}},fetch:async(url,opts)=>{calls.push({url:String(url),aborted:opts.signal.aborted});return fixture(calls.length);}});
 vm.runInContext(source.replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler'),ctx);
 return {ctx,logs,calls};
}
async function compare(fixture,expected,{minutes=2,loggerThrows=false}={}){
 const a=runtime(original,fixture),b=runtime(current,fixture,loggerThrows);
 const args=['TESTUSDT',new Date(from).toISOString(),new Date(from+minutes*minute).toISOString()];
 const before=await a.ctx.fetchOKXRecentPriceRange(...args),after=await b.ctx.fetchOKXRecentPriceRange(...args);
 assert.equal(JSON.stringify(after),JSON.stringify(before));assert.deepEqual(b.calls,a.calls);
 assert.deepEqual(b.logs.map(x=>x.failureClass),expected?[expected]:[]);
 for(const log of b.logs){assert.equal(log.event,'okx_candle_fetch_failure');assert.equal(log.instrumentId,'TEST-USDT-SWAP');assert.equal(log.bar,'1m');assert.ok(Object.keys(log).every(k=>['event','failureClass','instrumentId','bar','windowStart','windowEnd','timestamp','httpStatus','errorName','errorCode'].includes(k)));}
 return {before,after,...b};
}
for(const [status,cls]of [[403,'HTTP_403'],[429,'HTTP_429'],[500,'HTTP_5XX'],[503,'HTTP_5XX'],[401,'HTTP_OTHER']])test(`HTTP ${status}: null + safe class + parity`,async()=>{const r=await compare(()=>response([],status),cls);assert.equal(r.after,null);assert.equal(r.logs[0].httpStatus,status);});
for(const [name,code,cls]of [['TimeoutError',null,'TIMEOUT'],['AbortError',null,'TIMEOUT'],['Error','ENOTFOUND','DNS'],['Error','EAI_AGAIN','DNS'],['TypeError','ECONNRESET','NETWORK'],['Error','ECONNREFUSED','NETWORK'],['Error','UND_ERR_CONNECT_TIMEOUT','TIMEOUT'],['Error',null,'UNKNOWN']])test(`${name}/${code}: exception parity`,()=>compare(()=>{throw Object.assign(Error('SECRET_BODY URL token'),{name,cause:{code},headers:{Authorization:'SECRET'}})},cls));
test('malformed JSON remains null',()=>compare(()=>({ok:true,status:200,json:async()=>{throw Error('SECRET_BODY')}}),'MALFORMED_RESPONSE'));
for(const payload of [null,{},[],{code:'0',data:{} }])test(`malformed payload ${JSON.stringify(payload)}`,()=>compare(()=>({ok:true,status:200,json:async()=>payload}),'MALFORMED_RESPONSE'));
test('API rejection remains null; body not logged',()=>compare(()=>({ok:true,status:200,json:async()=>({code:'51000',msg:'SECRET_BODY',data:[]})}),'API_REJECTION'));
test('invalid candle keeps identical empty range',async()=>{const r=await compare(()=>response([row(0,{2:'invalid'})]),'INCOMPLETE_OR_INVALID_DATA');assert.notEqual(r.after,null);assert.equal(r.after.candles,0);});
test('mixed invalid/valid retains identical partial range',()=>compare(n=>response(n===1?[row(1),row(0,{3:'-1'})]:[]),'INCOMPLETE_OR_INVALID_DATA'));
test('empty page retains identical empty range',()=>compare(()=>response([]),'INCOMPLETE_OR_INVALID_DATA'));
test('unconfirmed candle retains prior filtering',()=>compare(()=>response([row(0,{8:'0'})]),'INCOMPLETE_OR_INVALID_DATA'));
test('complete success is silent',()=>compare(()=>response([row(1),row(0)]),null));
test('three-page success preserves URLs, order and request cap',()=>compare(n=>response(Array.from({length:100},(_,i)=>row(300-n*100+i)).reverse()),null,{minutes:300}));
test('logger throws on HTTP rejection: remains null',()=>compare(()=>response([],403),'HTTP_403',{loggerThrows:true}));
test('logger throws on incomplete data: same range',()=>compare(()=>response([]),'INCOMPLETE_OR_INVALID_DATA',{loggerThrows:true}));
test('secrets, arbitrary error name/code, body, stack and headers never copied',async()=>{const r=await compare(()=>{throw {name:'SECRET_NAME',code:'SECRET_CODE',message:'SECRET_MESSAGE',stack:'SECRET_STACK',headers:{Authorization:'SECRET_HEADER'},body:'SECRET_BODY'}},'UNKNOWN');assert.doesNotMatch(JSON.stringify(r.logs),/SECRET/);});
test('zero-duration complete window is silent',()=>compare(()=>{throw Error('must not fetch')},null,{minutes:0}));
test('lifecycle and everything outside fetch function remain byte-identical',()=>{const strip=s=>s.replace(/async function fetchOKXRecentPriceRange\([\s\S]*?(?=\nfunction isValidLifecycleCandle)/,'FETCH');assert.equal(strip(current),strip(original));});
