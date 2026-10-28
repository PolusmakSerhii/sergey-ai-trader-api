// Offline source harness. No imports from market.js, credentials, or production transport.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
export const CORE_SHA='bee16f7b799c1a754cd0950661fb037608835412';
export const KEY='sergey-ai:open-trades:v1';
export const sha256=raw=>createHash('sha256').update(raw).digest('hex');
export const typeOf=v=>v===null?'null':Array.isArray(v)?'array':['string','number','boolean','object','undefined'].includes(typeof v)?typeof v:'other';
export async function loadContract(){
 const bytes=await readFile(new URL('../../api/market.js',import.meta.url));
 assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),CORE_SHA,'SOURCE_SHA_GATE');
 const source=bytes.toString();
 // The established full-source VM harness; only module declarations are removed.
 assert.equal((source.match(/export default async function handler/g)||[]).length,1);
 const diagnostics=[];
 const c=vm.createContext({createHash,console:{error:(...args)=>diagnostics.push(args),log(){}},process:{env:{}},fetch(){throw Error('NETWORK_FORBIDDEN');}});
 vm.runInContext(source.replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler'),c,{timeout:5000});
 assert.equal(vm.runInContext('OPEN_TRADES_KEY',c),KEY,'KEY_GATE');
 const lua=vm.runInContext('WRITE_OPEN_TRADES_SCRIPT',c);
 assert.equal(lua,source.match(/const WRITE_OPEN_TRADES_SCRIPT = `([\s\S]*?)`;/)[1],'LUA_EXACT_EXTRACTION_GATE');
 const E=vm.runInContext('Error',c),S=vm.runInContext('SyntaxError',c);
 const reasons=new Set(['MISSING_TRADE_ID','INVALID_TRADE_ID_TYPE','MISSING_SETUP_KEY','INVALID_SETUP_KEY_TYPE','MISSING_INITIAL_PLAN','INVALID_OUTCOME_STATUS','DUPLICATE_TRADE_ID','DUPLICATE_SETUP_KEY']);
 function parse(raw){diagnostics.length=0;try{c.parseOpenTrades(raw);return {result:'PASS',reason:null};}catch(e){
  if(e.constructor===S)return {result:'REJECT',reason:'INVALID_JSON'};
  if(e.constructor!==E||!['Invalid open trades state','Invalid or duplicate open trade'].includes(e.message))return {result:'EXECUTION_ERROR',reason:null};
  if(e.message==='Invalid open trades state')return {result:'REJECT',reason:'INVALID_ROOT'};
  let reason=null;try{reason=JSON.parse(diagnostics.at(-1)?.[1]).reasonCode;}catch{}
  return {result:'REJECT',reason:reasons.has(reason)?reason:null};
 }}
 function js(raw){try{c.validateProposedTradeSignals(JSON.parse(raw),true);return 'PASS';}catch(e){if(e instanceof SyntaxError)return 'REJECT';return e.constructor===E&&['Invalid proposed trade signals','Invalid or duplicate proposed trade signal'].includes(e.message)?'REJECT':'EXECUTION_ERROR';}}
 const contract={parse,js,lua};
 for(const [,rows,expected]of matrix()){assert.equal(parse(JSON.stringify(rows)).result,expected,'PARSE_SELF_TEST');assert.equal(js(JSON.stringify(rows)),expected,'JS_SELF_TEST');}
 return contract;
}
export function matrix(){
 const t=(status='Active')=>({tradeId:'synthetic-id',setupKey:'synthetic-setup',initialPlan:{},outcome:{status}});
 const missing=k=>{const r=t();delete r[k];return [r];};
 return [['valid Active',[t()],'PASS'],['valid WaitingEntry',[t('WaitingEntry')],'PASS'],['valid Pending',[t('Pending')],'PASS'],['empty array',[],'PASS'],['object root',{},'REJECT'],['duplicate tradeId',[t(),{...t(),setupKey:'other'}],'REJECT'],['duplicate setupKey',[t(),{...t(),tradeId:'other'}],'REJECT'],['missing tradeId',missing('tradeId'),'REJECT'],['missing setupKey',missing('setupKey'),'REJECT'],['empty tradeId',[{...t(),tradeId:''}],'REJECT'],['empty setupKey',[{...t(),setupKey:''}],'REJECT'],['extra fields',[{...t(),extra:{synthetic:true}}],'PASS'],...['Active','TP1Hit','TP2Hit','TP3Hit','Stopped','Closed','Expired'].map(s=>[s,[t(s)],s==='Active'?'PASS':'REJECT']),['malformed outcome',[{...t(),outcome:null}],'REJECT'],['missing initialPlan',missing('initialPlan'),'REJECT'],['multiple unique',[t(),{...t(),tradeId:'other',setupKey:'other'}],'PASS'],...['tradeId','setupKey'].flatMap(k=>[1,0,false,true,null,[],{}].map(v=>[`${k} ${typeOf(v)} ${JSON.stringify(v)}`,[{...t(),[k]:v}],'REJECT']))];
}
export function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
// No proven winner for mutable differences is implemented here.
export const FROZEN=new Set(['tradeId','setupKey','initialPlan','researchSnapshot','entryDecision','tradeAllowed','tradeReadiness','opportunityScore','opportunityGrade','confidence','grade','action','riskReward','symbol','direction','setupId']);
export const MUTABLE=new Set(['outcome','capturedAt','signalId','price']);
export function report(raw,contract){
 const parsed=contract.parse(raw),js=contract.js(raw);let rows;try{rows=JSON.parse(raw);}catch{}
 const entries=k=>Array.isArray(rows)?rows.flatMap((r,index)=>typeof r?.[k]==='string'?[]:[{index,type:typeOf(r?.[k])}]):[];
 const ids=entries('tradeId'),setups=entries('setupKey'),groups=[];
 if(Array.isArray(rows))for(const field of ['tradeId','setupKey']){
  const map=new Map();rows.forEach((r,i)=>{if(typeof r?.[field]==='string'){const a=map.get(r[field])||[];a.push(i);map.set(r[field],a);}});
  for(const indexes of map.values())if(indexes.length>1){const records=indexes.map(i=>rows[i]);const names=[...new Set(records.flatMap(r=>Object.keys(r)))].sort();
   const differing=names.filter(k=>records.some(r=>Object.hasOwn(r,k)!==Object.hasOwn(records[0],k)||canonical(r[k])!==canonical(records[0][k])));
   groups.push({identityField:field,indexes,allCanonicalEqual:records.every(r=>canonical(r)===canonical(records[0])),frozenDifferingFieldNames:differing.filter(k=>FROZEN.has(k)),mutableDifferingFieldNames:differing.filter(k=>MUTABLE.has(k)),unknownDifferingFieldNames:differing.filter(k=>!FROZEN.has(k)&&!MUTABLE.has(k))});
  }
 }
 return {CORE_SHA,RAW_SHA256:sha256(raw),RECORD_COUNT:Array.isArray(rows)?rows.length:null,NON_STRING_TRADE_ID_COUNT:ids.length,NON_STRING_TRADE_ID_ENTRIES:ids,NON_STRING_SETUP_KEY_COUNT:setups.length,NON_STRING_SETUP_KEY_ENTRIES:setups,PARSE_OPEN_TRADES:parsed.result,PARSE_REASON:parsed.reason,JS_VALIDATOR:js,duplicateGroups:groups,canonicalIdenticalCandidate:groups.length>0&&groups.every(g=>g.allCanonicalEqual)&&!ids.length&&!setups.length,automaticRepairEligible:parsed.result==='PASS'&&js==='PASS'&&!ids.length&&!setups.length&&groups.every(g=>!g.frozenDifferingFieldNames.length&&!g.unknownDifferingFieldNames.length),repairRequiresApprovedStepAAndStepB:true};
}
