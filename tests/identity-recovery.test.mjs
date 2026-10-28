import test, {after} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {loadContract as loadPinnedContract} from '../scripts/identity-recovery/contract.mjs';
import {withLocalRedis} from '../scripts/identity-recovery/local-redis.mjs';
import {candidate,recordSpans} from '../scripts/identity-recovery/candidate.mjs';
// Legacy prepared tooling intentionally stays pinned to the approved pre-bridge blob.
// Verify that deleting ONLY the pure bridge reproduces that exact blob; keep every
// original validator/Step-B assertion against this byte-verified synthetic fixture.
const bridge = '\n// Expose the exact existing validators without invoking the market handler.\nhandler.openTradesValidation = Object.freeze({\n  parseOpenTrades,\n  validateProposedTradeSignals\n});\n';
const currentSource=await readFile(new URL('../api/market.js',import.meta.url),'utf8');
assert.ok(currentSource.endsWith(bridge),'Only the approved bridge may be removed for the legacy fixture');
const preBridge=Buffer.from(currentSource.slice(0,-bridge.length));
assert.equal(createHash('sha1').update(`blob ${preBridge.length}\0`).update(preBridge).digest('hex'),'bee16f7b799c1a754cd0950661fb037608835412');
const fixture=await mkdtemp(join(tmpdir(),'legacy-identity-contract-'));
after(()=>rm(fixture,{recursive:true,force:true}));
await mkdir(join(fixture,'api'));await mkdir(join(fixture,'scripts','identity-recovery'),{recursive:true});
await writeFile(join(fixture,'api','market.js'),preBridge);
for(const name of ['contract.mjs','candidate.mjs','local-redis.mjs','step-b.mjs'])await copyFile(new URL('../scripts/identity-recovery/'+name,import.meta.url),join(fixture,'scripts','identity-recovery',name));
const {loadContract,matrix,report,canonical}=await import(pathToFileURL(join(fixture,'scripts','identity-recovery','contract.mjs')));
const {evaluate,stepB}=await import(pathToFileURL(join(fixture,'scripts','identity-recovery','step-b.mjs')));
test('legacy prepared tooling fails closed on the new bridge source SHA',async()=>{
 await assert.rejects(loadPinnedContract(),error=>error.code==='ERR_ASSERTION'&&error.message.includes('SOURCE_SHA_GATE'));
});
const trade={tradeId:'a',setupKey:'s',initialPlan:{frozen:true},outcome:{status:'Active'}};
test('three exact validators: original matrix plus all non-string identity types',async t=>{
 const contract=await loadContract();
 await withLocalRedis(async redis=>{
  for(const [name,rows,expected]of matrix())await t.test(name,async()=>{
   const result=await evaluate(JSON.stringify(rows),contract,redis);
   assert.equal(result.PARSE,expected);assert.equal(result.JS,expected);assert.equal(result.LUA,expected);assert.equal(result.ALL_THREE_AGREE,true);
  });
  const raw=JSON.stringify([{...trade,extra:'x'.repeat(600000)}]);
  const echo=await redis.command(['EVAL','return ARGV[1]','0',raw]);assert.equal(echo.value.toString(),raw);assert.equal((await evaluate(raw,contract,redis)).ALL_THREE_PASS,true);
 });
});
test('offline report bounds identity types and reasons without disclosing values',async()=>{
 const c=await loadContract();const r=report(JSON.stringify([{...trade,tradeId:12345,setupKey:{secret:'never-print'}}]),c);
 assert.deepEqual(r.NON_STRING_TRADE_ID_ENTRIES,[{index:0,type:'number'}]);assert.deepEqual(r.NON_STRING_SETUP_KEY_ENTRIES,[{index:0,type:'object'}]);
 assert.equal(r.PARSE_REASON,'INVALID_TRADE_ID_TYPE');assert.equal(r.automaticRepairEligible,false);assert.ok(!JSON.stringify(r).includes('never-print'));assert.ok(!JSON.stringify(r).includes('12345'));
 assert.equal(report('{',c).PARSE_REASON,'INVALID_JSON');assert.equal(report('{}',c).PARSE_REASON,'INVALID_ROOT');
});
test('field classification: frozen, mutable, unknown, missing versus null',async()=>{
 const c=await loadContract();const r=report(JSON.stringify([trade,{...trade,initialPlan:{frozen:false},outcome:{status:'Pending'},origin:{x:1},extra:null}]),c);
 for(const g of r.duplicateGroups){assert.deepEqual(g.frozenDifferingFieldNames,['initialPlan']);assert.deepEqual(g.mutableDifferingFieldNames,['outcome']);assert.deepEqual(g.unknownDifferingFieldNames,['extra','origin']);assert.equal(g.allCanonicalEqual,false);}assert.equal(r.automaticRepairEligible,false);
 const identical=report(JSON.stringify([trade,trade]),c);assert.equal(identical.canonicalIdenticalCandidate,true);assert.equal(identical.automaticRepairEligible,false);
});
test('candidate preserves exact record lexemes and original survivor order',()=>{
 const a=' { "tradeId":"a", "setupKey":"s", "initialPlan":{}, "outcome":{"status":"Active"}, "extra": ["x,]\\\"",1e2] } ';
 const b=JSON.stringify({...trade,tradeId:'b',setupKey:'b'});const raw='[\n'+a+', '+a+', '+b+'\n]';
 const rule={kind:'REMOVE_EXPLICIT_CANONICAL_IDENTICAL_DUPLICATES',removals:[{removeIndex:1,keepIndex:0}]};
 const actual=candidate(raw,rule),original=recordSpans(raw);assert.deepEqual(recordSpans(actual),[original[0],original[2]]);assert.equal(canonical(JSON.parse(actual)),canonical([JSON.parse(a),JSON.parse(b)]));
 assert.throws(()=>candidate(raw,{...rule,removals:[{removeIndex:2,keepIndex:0}]}));
 assert.throws(()=>candidate(raw,{...rule,removals:[{removeIndex:1,keepIndex:0},{removeIndex:0,keepIndex:1}]}));
});
test('offline Step B uses all three validators for current and approved hypothetical',async()=>{
 const r=await stepB(JSON.stringify([trade,trade]),{kind:'REMOVE_EXPLICIT_CANONICAL_IDENTICAL_DUPLICATES',removals:[{removeIndex:1,keepIndex:0}]});
 assert.deepEqual(r.CURRENT,{PARSE:'REJECT',JS:'REJECT',LUA:'REJECT',ALL_THREE_PASS:false,ALL_THREE_AGREE:true});assert.equal(r.HYPOTHETICAL.ALL_THREE_PASS,true);
});
test('zero and false receive type rejection diagnostics; missing and empty retain reasons',async()=>{
 const c=await loadContract();for(const k of ['tradeId','setupKey'])for(const v of [0,false])assert.equal(c.parse(JSON.stringify([{...trade,[k]:v}])).reason,k==='tradeId'?'INVALID_TRADE_ID_TYPE':'INVALID_SETUP_KEY_TYPE');
});

// Test the generic transport with injected responses, never invoke Step A or repair.
test('approved transport is exact-command scoped, one-shot, no retry or redirects',async()=>{
 const {approvedTransport}=await import('../scripts/identity-recovery/approved-transport.mjs');
 const {KEY}=await import('../scripts/identity-recovery/contract.mjs');let calls=0;
 const read=approvedTransport({endpoint:'https://redis.invalid',token:'synthetic',mode:'STEP_A',fetchImpl:async(_url,options)=>{calls++;assert.equal(options.redirect,'error');assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),['GET',KEY]);return {ok:true,json:async()=>({result:'[]'})};}});
 assert.equal(await read(['GET',KEY]),'[]');await assert.rejects(read(['GET',KEY]));assert.equal(calls,1);
 const wrong=approvedTransport({endpoint:'https://redis.invalid',token:'synthetic',mode:'STEP_A',fetchImpl:async()=>assert.fail('wrong command reached transport')});await assert.rejects(wrong(['GET','other']));await assert.rejects(wrong(['GET',KEY]));
 let attempts=0;const failed=approvedTransport({endpoint:'https://redis.invalid',token:'synthetic',mode:'STEP_A',fetchImpl:async()=>{attempts++;throw Error('synthetic timeout');}});await assert.rejects(failed(['GET',KEY]));await assert.rejects(failed(['GET',KEY]));assert.equal(attempts,1);
});
