import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../api/market.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
const c={Date,URL,process:{env:{}},console};vm.runInNewContext(source,c);
const rec=(id,origin,status='Closed',value=1,closed='2026-10-14T00:00:00Z',direction='Long')=>({tradeId:id,cohort:'forward',origin:{detectedAt:origin,direction},initialPlan:{createdAt:origin,exitStrategy:{version:'tp1-50-reanalyse-v1'}},outcome:{status,resultR:value,checkedAt:closed,exits:[]}});
for(const [time,expected] of [['2026-10-11T20:59:59.999Z','PRE-LIVE'],['2026-10-11T21:00:00.000Z','LIVE'],['2026-10-11T21:00:00.001Z','LIVE'],[null,'UNKNOWN'],['bad','UNKNOWN'],['2026-10-12T00:00:00','UNKNOWN']])test('UTC boundary '+time,()=>assert.equal(c.classifyLiveCohort(rec('x',time)).cohort,expected));
test('conflict invalid frozen and equivalent timestamps',()=>{
 const r=rec('x','2026-10-11T21:00:00Z');r.initialPlan.createdAt='2026-10-12T00:00:00+03:00';assert.equal(c.classifyLiveCohort(r).cohort,'LIVE');
 for(const time of ['bad','2026-10-13T00:00:00Z']){r.initialPlan.createdAt=time;assert.equal(c.classifyLiveCohort(r).cohort,'UNKNOWN');}
});
test('membership unaffected by activation partial exits HOLD CLOSE and completion',()=>{
 for(const [origin,expected] of [['2026-10-10T00:00:00Z','PRE-LIVE'],['2026-10-12T00:00:00Z','LIVE']]){
 const r=rec('x',origin);
 for(const status of ['WaitingEntry','Active','Closed']){r.outcome.status=status;r.outcome.realizedR=.5;r.outcome.remainingPosition=.5;r.outcome.lastReanalysis={decision:'HOLD'};assert.equal(c.classifyLiveCohort(r).cohort,expected);}
 }
});
test('canonical metrics chronological drawdown streak tie-break dedupe and exclusions',()=>{
 const origin='2026-10-12T00:00:00Z';
 const records=[rec('d',origin,'Closed',0,'2026-10-14T04:00:00Z'),rec('b',origin,'Stopped',-1,'2026-10-14T02:00:00Z','Short'),rec('a',origin,'Closed',2,'2026-10-14T02:00:00Z'),rec('c',origin,'Closed',-2,'2026-10-14T03:00:00Z'),rec('active',origin,'Active',100),rec('expired',origin,'Expired',100),rec('bad',origin,'Closed',null)];
 records.push(records[0]);const before=JSON.stringify(records);
 const s=c.summarizeLiveCohorts(records).LIVE;
 assert.equal(s.completed,4);assert.equal(s.active,1);assert.equal(s.wins,1);assert.equal(s.losses,2);assert.equal(s.breakEvens,1);assert.equal(s.netR,-1);assert.equal(s.averageR,-.25);assert.equal(s.expectancy,-.25);assert.equal(s.winRate,25);assert.equal(s.profitFactor,2/3);assert.equal(s.maxDrawdownR,3);assert.equal(s.maxLossStreak,2);assert.equal(s.currentLossStreak,0);assert.equal(s.directions.Short.count,1);assert.equal(s.directions.Long.count,3);
 assert.equal(JSON.stringify(records),before);
});
test('archive read adds summaries using one existing GET before pagination',async()=>{
 c.getRedisConfig=()=>({});const records=[rec('a','2026-10-10T00:00:00Z'),rec('b','2026-10-12T00:00:00Z')].map(r=>({...r,result:{classification:'Win',completedAt:r.outcome.checkedAt},initialPlanJSON:JSON.stringify(r.initialPlan),outcomeJSON:JSON.stringify(r.outcome)}));
 const commands=[];const data=await c.readValidationArchive({limit:1},async cmd=>{commands.push(cmd);return JSON.stringify({schemaVersion:1,validationStartAt:'2026-09-22T00:00:00Z',tradesById:Object.fromEntries(records.map(r=>[r.tradeId,r]))});});
 assert.equal(commands.length,1);assert.equal(commands[0][0],'GET');assert.equal(data.records.length,1);assert.equal(data.liveCohorts.summaries.LIVE.total,1);assert.equal(data.liveCohorts.summaries['PRE-LIVE'].total,1);
});
