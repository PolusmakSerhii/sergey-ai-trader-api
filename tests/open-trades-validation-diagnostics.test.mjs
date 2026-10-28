import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const source=await readFile(new URL('../api/market.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('function parseOpenTrades(raw)'),source.indexOf('function writeOpenTradesCAS('));
const valid=(id='private-id',setup='private-setup',status='Active')=>({tradeId:id,setupKey:setup,initialPlan:{price:123},outcome:{status}});
function parser(logs,throws=false){const c=vm.createContext({createHash,console:{error:(...args)=>{if(throws)throw Error('logger');logs.push(args);}}});vm.runInContext(fn,c);return c.parseOpenTrades;}
const cases=[
 ['numeric tradeId',[{...valid(),tradeId:123}],'INVALID_TRADE_ID_TYPE',0],
 ['numeric setupKey',[{...valid(),setupKey:123}],'INVALID_SETUP_KEY_TYPE',0],
 ['duplicate tradeId',[valid(),valid('private-id','other-setup')],'DUPLICATE_TRADE_ID',1,0],
 ['duplicate setupKey',[valid(),valid('other-id')],'DUPLICATE_SETUP_KEY',1,0],
 ['missing tradeId',[{...valid(),tradeId:''}],'MISSING_TRADE_ID',0],
 ['missing setupKey',[{...valid(),setupKey:null}],'MISSING_SETUP_KEY',0],
 ['missing initialPlan',[{...valid(),initialPlan:null}],'MISSING_INITIAL_PLAN',0],
 ['invalid status',[valid('private-id','private-setup','secret-status')],'INVALID_OUTCOME_STATUS',0],
 ['missing status',[{...valid(),outcome:null}],'INVALID_OUTCOME_STATUS',0],
 ['null record',[null],'MISSING_TRADE_ID',0]
];
for(const [name,rows,reason,index,duplicate]of cases)test(name,()=>{
 const logs=[],parse=parser(logs);assert.throws(()=>parse(JSON.stringify(rows)),{message:'Invalid or duplicate open trade'});
 assert.equal(logs.length,1);assert.equal(logs[0][0],'[open-trades-validation-failure]');const d=JSON.parse(logs[0][1]);
 assert.equal(d.reasonCode,reason);assert.equal(d.recordIndex,index);assert.equal(d.duplicateOfIndex,duplicate);
 assert.deepEqual(Object.keys(d).sort(),['reasonCode','recordIndex','outcomeStatus',...(duplicate===undefined?[]:['duplicateOfIndex']),...(rows[index]?.tradeId!=null?['tradeIdHash']:[]),...(rows[index]?.setupKey!=null?['setupKeyHash']:[])].sort());
 for(const [field,key]of [['tradeId','tradeIdHash'],['setupKey','setupKeyHash']])if(key in d)assert.equal(d[key],createHash('sha256').update(JSON.stringify(rows[index][field])).digest('hex').slice(0,16));
 assert.ok(['WaitingEntry','Pending','Active','OTHER','MISSING'].includes(d.outcomeStatus));
 for(const secret of ['private-id','private-setup','secret-status','initialPlan','price'])assert.ok(!logs[0][1].includes(secret));
});
test('valid statuses, null and empty ledger emit no diagnostic',()=>{
 const logs=[],parse=parser(logs),rows=['WaitingEntry','Pending','Active'].map((s,i)=>valid('id'+i,'setup'+i,s));
 assert.equal(JSON.stringify(parse(JSON.stringify(rows))),JSON.stringify(rows));assert.equal(parse(null).length,0);assert.equal(parse('[]').length,0);assert.equal(logs.length,0);
});
test('logger failure preserves exact validation exception',()=>assert.throws(()=>parser([],true)('[null]'),{message:'Invalid or duplicate open trade'}));
test('JSON and non-array errors retain existing behavior without diagnostic',()=>{const logs=[],parse=parser(logs);assert.throws(()=>parse('{'));assert.throws(()=>parse('{}'),{message:'Invalid open trades state'});assert.equal(logs.length,0);});
