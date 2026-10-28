import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {INCIDENT,KEY,BACKUP_KEY,prepareRepair,validateOpenTrades,EXACT_LUA_GUARD} from '../api/open-trades-repair.js';
import {fixture,invoke,hash} from './helpers/open-trades-repair-fixture.mjs';
test('production incident constants frozen; synthetic data cannot pass production evidence',async()=>{
 assert.deepEqual(INCIDENT,{originalSha:'b987ae4ffc6e6c65683e7e5c2e482f6c737f9aa6766b47b805ed5585741da275',originalBytes:87415,originalCount:18,keepIndex:1,removeIndex:2,candidateCount:17,tradeIdSha:'2c5261655f0e84cb20b84a4a808a2571b20ec9e0e98afd60417821a4fc5c8779',setupKeySha:'66d59017a429a30dfa22e9d7b16fb7bc457f4baf54e9a1ae20ee04baf6259a5f',recordSha:'1f79e4d3c16b809417e722eac66f6449959172540b96d0bf50e6ec71f7014cbd'});
 assert.ok(Object.isFrozen(INCIDENT));assert.equal(KEY,'sergey-ai:open-trades:v1');assert.ok(BACKUP_KEY.includes(INCIDENT.originalSha));assert.throws(()=>prepareRepair('[]'),/SOURCE_CHANGED/);
});
test('exact frozen synthetic evidence: only index 2 removed, all survivor lexemes/order unchanged',async()=>{
 const f=await fixture(),prepared=f.api.prepareRepair(f.raw),rows=JSON.parse(prepared),before=f.api.recordSpans(f.raw),after=f.api.recordSpans(prepared);
 assert.equal(rows.length,17);assert.deepEqual(rows,f.rows.filter((_,i)=>i!==2));
 const retained=before.filter((_,i)=>i!==2);assert.deepEqual(after.map(s=>prepared.slice(s.start,s.end)),retained.map(s=>f.raw.slice(s.start,s.end)));
 assert.equal(prepared.slice(after[1].start,after[1].end),f.raw.slice(before[1].start,before[1].end));assert.ok(prepared.includes('1e2'));
 assert.doesNotThrow(()=>validateOpenTrades(rows));
});
for(const [name,overrides]of [['original SHA',{originalSha:'0'.repeat(64)}],['byte length',{originalBytes:87416}],['tradeId hash',{tradeIdSha:'0'.repeat(64)}],['setupKey hash',{setupKeySha:'0'.repeat(64)}],['canonical hash',{recordSha:'0'.repeat(64)}]])test(`${name} mismatch: no EVAL/mutation`,async()=>{const r=await invoke(await fixture({overrides}));assert.equal(r.res.code,409);assert.equal(r.calls.length,1);assert.equal(r.backup,null);});
const badCases=[
 ['record count',r=>r.pop()],['indexes',r=>{[r[2],r[4]]=[r[4],r[2]];}],
 ['canonical/frozen difference',r=>r[2].initialPlan.entryPrice++],['mutable difference',r=>r[2].price=1],['unknown difference',r=>r[2].unrecognized=true],['outcome difference',r=>r[2].outcome.status='Pending'],
 ['numeric identity',r=>r[1].tradeId=r[2].tradeId=123],['missing identity',r=>{delete r[1].setupKey;delete r[2].setupKey;}],
 ['extra tradeId duplicate',r=>r[4].tradeId=r[3].tradeId],['extra setupKey duplicate',r=>r[4].setupKey=r[3].setupKey],
 ['candidate validator defect',r=>r[8].initialPlan=null],['non-open candidate',r=>r[8].outcome.status='Closed']
];
for(const [name,mutate]of badCases)test(`${name}: validation rejects before EVAL`,async()=>{const f=await fixture({mutate}),r=await invoke(f);assert.equal(r.res.code,409);assert.equal(r.calls.length,1);assert.equal(r.backup,null);assert.equal(r.target,f.raw);});
test('auth, method, storage config and caller-controlled options fail before Redis',async()=>{
 const f=await fixture();for(const options of [{badAuth:true},{method:'GET'},{missingConfig:true},...['key','indexes','identity','replacement','expectedSha','candidate','repairRule','backupKey','rollback'].flatMap(key=>[{body:{[key]:'forbidden'}},{query:{[key]:'forbidden'}}])]){const r=await invoke(f,options);assert.ok([400,401,405,503].includes(r.res.code));assert.equal(r.calls.length,0);}
});
test('approved synthetic success: GET EVAL GET, exact backup, runtime candidate SHA, count17',async()=>{
 const f=await fixture(),r=await invoke(f);assert.equal(r.res.code,200);assert.equal(r.res.body.status,'REPAIRED_VERIFIED');assert.deepEqual(r.calls.map(c=>c[0]),['GET','EVAL','GET']);assert.equal(r.backup,f.raw);assert.equal(r.target,f.api.prepareRepair(f.raw));assert.equal(r.res.body.candidateSha256,hash(r.target));assert.equal(r.res.body.backupSha256,hash(f.raw));assert.equal(r.res.body.recordCount,17);assert.equal(r.res.body.retainedOriginalIndex,1);assert.equal(r.res.body.removedOriginalIndex,2);
 for(const forbidden of ['synthetic-id-','synthetic-setup-','PRIVATE_','entryPrice','Привіт'])assert.ok(!JSON.stringify(r.res.body).includes(forbidden));
});
test('preimage/backup failures have no verification GET or retry',async()=>{
 for(const result of [0,-1,-2,-3,-4]){const r=await invoke(await fixture(),{result});assert.equal(r.calls.length,2);assert.notEqual(r.res.code,200);assert.equal(r.res.body.retryAllowed,false);}
});
test('verification mismatch stops after one GET with no second mutation',async()=>{
 const r=await invoke(await fixture(),{changedReadback:true});assert.equal(r.res.body.status,'VERIFICATION_CHANGED_STOP');assert.equal(r.res.body.writeConfirmed,true);assert.equal(r.calls.length,3);assert.equal(r.calls.filter(c=>c[0]==='EVAL').length,1);
});
test('transport failure and lost acknowledgement never retry or claim no mutation',async()=>{
 for(const [failAt,status]of [[1,'SOURCE_READ_UNAVAILABLE'],[2,'CAS_RESULT_UNKNOWN'],[3,'VERIFICATION_UNAVAILABLE_STOP']]){const r=await invoke(await fixture(),{failAt});assert.equal(r.calls.length,failAt);assert.equal(r.res.body.status,status);assert.ok(!JSON.stringify(r.res.body).includes('PRIVATE_'));}
 const r=await invoke(await fixture(),{ackLost:true});assert.equal(r.calls.length,2);assert.equal(r.res.body.status,'CAS_RESULT_UNKNOWN');assert.equal(r.res.body.writeConfirmed,false);assert.ok(r.backup);assert.notEqual(r.target,r.backup);
});
test('Lua candidate guard is verbatim production guard, not a manually copied validator',async()=>{
 const source=await readFile(new URL('../api/market.js',import.meta.url),'utf8'),script=source.match(/const WRITE_OPEN_TRADES_SCRIPT = `([\s\S]*?)`;/)[1];assert.equal(EXACT_LUA_GUARD,script.slice(0,script.indexOf('local decoded, trades = pcall(cjson.decode, ARGV[2])')));
});

test('candidate-only parse/JS failure is fail-closed before EVAL',async()=>{
 for(const candidateFailure of ['parse','js']){const f=await fixture({candidateFailure}),r=await invoke(f);assert.equal(r.res.code,409);assert.equal(r.calls.length,1);assert.equal(r.target,f.raw);assert.equal(r.backup,null);}
});
