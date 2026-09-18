import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../api/market.js',import.meta.url),'utf8');
const start=source.indexOf('const liveOpportunity = calculateScannerOpportunity(executionAnalysis);');
const end=source.indexOf('res.status(200).json',start);
const responseStart=source.indexOf('technical: {',end);
const responseEnd=source.indexOf('\n   },',responseStart);
const response=source.slice(responseStart,responseEnd)+'\n}';
for(const result of [{score:88,grade:'A+',confirmedAPlus:true},{score:86,grade:'A',confirmedAPlus:false}]){
 test(`live response preserves ${result.score}/${result.grade}/${result.confirmedAPlus} from one calculation`,async ()=>{
  assert.ok(start>0 && responseEnd>responseStart);
  let calls=0;const input={};const context={req:{headers:{}},instrumentType:"SWAP",symbol:"TESTUSDT",registerLiveAnalysisTrade:async()=>null,executionAnalysis:input,calculateScannerOpportunity:value=>{assert.equal(value,input);calls++;return result;}};
  for(const line of response.split('\n')){const name=line.trim().replace(/,$/,'');if(/^[a-zA-Z][a-zA-Z0-9]*$/.test(name))context[name]=null;}
  await vm.runInNewContext('(async()=>{'+source.slice(start,end)+';globalThis.response={'+response+'};})()',context);
  assert.equal(calls,1);assert.equal(context.response.technical.opportunityScore,result.score);
  assert.equal(context.response.technical.opportunityGrade,result.grade);
  assert.equal(context.response.technical.confirmedAPlus,result.confirmedAPlus);
 });
}
