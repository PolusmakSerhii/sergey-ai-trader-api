import {createHash} from 'node:crypto';
import {readFile, writeFile, lstat} from 'node:fs/promises';
import {resolve, join, dirname, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createEngine} from './engine.mjs';

export const IDENTITY = Object.freeze({
  seal: '2e4abdc57f0147fd3bcb8c89ae15be2d3c9d4cff0b45bd68df0e5bf10f6b5d13',
  root: '9f67bd59f7d3f599b2e99874a5fc35912858d2396b6c45d98ebce29b29e53f24',
  engine: '5c79833481e6333639ab24b42f2aff5a114a18c9dc00d752c38b3629020ee5e8',
  amendment3Md: 'd5079214df71c73d837b3d752494d73f794b366a7435d5fdedb68144b7dbb5b0',
  amendment3Json: '7b4c171a5ffcb78d09ce6f0e4bf150fb377c2ac9d73aa04d5603ed1755439089'
});
export const UNIVERSE = Object.freeze(['BTC-USDT-SWAP','ETH-USDT-SWAP','SOL-USDT-SWAP']);
const M=60000,H=60*M,D=24*H,FIRST=Date.parse('2024-11-01T17:00:00Z'),LAST=Date.parse('2025-10-31T17:00:00Z');
const RESEARCH='market-entry-mechanics-v1.0',SCHEMA='development-outcomes-v1';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat=(ok,message)=>{if(!ok)throw Error(message);};
const finite=x=>typeof x==='number'&&Number.isFinite(x);
export function developmentSchedule(){return Array.from({length:365},(_,day)=>UNIVERSE.map(instrument=>({instrument,observationAt:FIRST+day*D,episodeId:`${RESEARCH}:${instrument}:${new Date(FIRST+day*D).toISOString()}`}))).flat();}
export function assertDevelopment(instrument,t){requireThat(UNIVERSE.includes(instrument)&&Number.isSafeInteger(t)&&t>=FIRST&&t<=LAST&&(t-FIRST)%D===0,'DEVELOPMENT_ONLY');}
const ordered=records=>[...records].sort((a,b)=>a.observationAt-b.observationAt||UNIVERSE.indexOf(a.instrument)-UNIVERSE.indexOf(b.instrument));
function exactUniverse(records){
  const sorted=ordered(records),expected=developmentSchedule();
  requireThat(sorted.length===1095,'EXPECTED_1095_EPISODES');
  sorted.forEach((r,i)=>requireThat(r.instrument===expected[i].instrument&&r.observationAt===expected[i].observationAt&&r.episodeId===expected[i].episodeId,'EPISODE_UNIVERSE_MISMATCH'));
  return sorted;
}
async function regularRead(path){requireThat((await lstat(path)).isFile()&&!(await lstat(path)).isSymbolicLink(),'REGULAR_FILE_REQUIRED');return readFile(path);}
async function safeArtifact(root,path){
  requireThat(typeof path==='string'&&!isAbsolute(path)&&path.split('/').every(s=>s&&s!=='.'&&s!=='..')&&!path.includes('\\'),'UNSAFE_INPUT_PATH');
  let p=root;for(const part of path.split('/')){p=join(p,part);requireThat(!(await lstat(p)).isSymbolicLink(),'SYMLINK_INPUT');}return regularRead(p);
}
// Expected hashes can be replaced only by unit-test callers using synthetic fixtures.
// The real-run entry point below always supplies the immutable production-research constants.
export async function verifySealedInputs(sealPath,expected=IDENTITY){
  const bytes=await regularRead(sealPath);requireThat(sha(bytes)===expected.seal,'SEAL_HASH_MISMATCH');
  const seal=JSON.parse(bytes),root=dirname(resolve(sealPath));
  requireThat(seal.sealed===true&&seal.collectionComplete===true&&seal.episodeCount===1095&&seal.developmentStart==='2024-11-01'&&seal.developmentEnd==='2025-10-31'&&seal.observationTimeUTC==='17:00:00'&&JSON.stringify(seal.universe)===JSON.stringify(UNIVERSE),'SEAL_UNIVERSE');
  requireThat(Array.isArray(seal.inputInventory),'INPUT_INVENTORY');
  let prev='';const normalized=new Map();
  for(const row of seal.inputInventory){
    requireThat(typeof row.path==='string'&&row.path>prev&&/^[a-f0-9]{64}$/.test(row.sha256),'INVENTORY_ORDER_OR_DUPLICATE');prev=row.path;
    const data=await safeArtifact(root,row.path);requireThat(sha(data)===row.sha256,'ARTIFACT_HASH_MISMATCH:'+row.path);
    if(/^normalized\/(BTC|ETH|SOL)-USDT-SWAP_(1m|1D)\.jsonl$/.test(row.path))normalized.set(row.path,data);
  }
  const hash=sha(seal.inputInventory.map(r=>r.path+'\t'+r.sha256+'\n').join(''));
  requireThat(hash===expected.root&&hash===seal.inputRootSha256,'INPUT_ROOT_MISMATCH');
  exactUniverse(developmentSchedule());
  return {seal,normalized,provenance:{sealSha256:expected.seal,inputRootSha256:hash,sealPath:resolve(sealPath)}};
}
export async function loadFrozenEngine(){
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  requireThat(sha(await readFile(new URL('./engine.mjs',import.meta.url)))===IDENTITY.engine,'ENGINE_HASH_MISMATCH');
  for(const [ext,key]of [['md','amendment3Md'],['json','amendment3Json']])requireThat(sha(await readFile(join(root,`docs/research/market-entry-mechanics-v1.0-amendment-3.${ext}`)))===IDENTITY[key],'AMENDMENT3_HASH_MISMATCH');
  const names={baseMd:'market-entry-mechanics-v1.0.md',baseJson:'market-entry-mechanics-v1.0.json',amendmentMd:'market-entry-mechanics-v1.0-amendment-1.md',amendmentJson:'market-entry-mechanics-v1.0-amendment-1.json'};
  const docs={};for(const [key,file]of Object.entries(names))docs[key]=await readFile(join(root,'docs/research',file),'utf8');
  return createEngine(docs);
}
const directional=r=>({terminalState:r.status,reason:r.reason??null,GrossR:r.grossR,NetR:r.netR,feeR:r.feeR,entry:r.entry,exit:r.exit,filled:finite(r.entry),fillCandleOpen:r.fillCandleOpen??null,fillPhase:r.fillPhase??null,exitCandleOpen:r.exitCandleOpen??null,exitPhase:r.exitPhase??null});
const episodeMean=s=>finite(s.LONG.NetR)&&finite(s.SHORT.NetR)?(s.LONG.NetR+s.SHORT.NetR)/2:null;
export function evaluateEpisode(engine,{instrument,observationAt,referenceCandles,dailyCandles,candles},provenance={}, {identityOnly=false}={}){
  assertDevelopment(instrument,observationAt);
  const episodeId=`${RESEARCH}:${instrument}:${new Date(observationAt).toISOString()}`;
  const setup=engine.deriveSetup({instrument,observationAt,referenceCandles,dailyCandles});
  const Baseline={},Alternative={};let identityMatches=true;
  for(const direction of ['LONG','SHORT']){
    if(setup.status!=='READY'){Baseline[direction]=directional(setup);Alternative[direction]=directional(setup);continue;}
    const plan=engine.buildPlan({episodeId,instrument,observationAt,direction,P0:setup.P0,A:setup.A});
    if(plan.status!=='READY'){Baseline[direction]=directional(plan);Alternative[direction]=directional(plan);continue;}
    const control=engine.identityControl(plan,candles);identityMatches&&=control.matches;
    Baseline[direction]=directional(control.baseline);
    Alternative[direction]=directional(identityOnly?control.identity:engine.execute(plan,candles,'ALTERNATIVE'));
  }
  requireThat(identityMatches,'IDENTITY_CONTROL_FAILURE:'+episodeId);
  Baseline.episodeNetR=episodeMean(Baseline);Alternative.episodeNetR=episodeMean(Alternative);
  const pairedDelta=finite(Baseline.episodeNetR)&&finite(Alternative.episodeNetR)?Alternative.episodeNetR-Baseline.episodeNetR:null;
  return {schemaVersion:SCHEMA,researchId:RESEARCH,instrument,observationAt,episodeId,Baseline,Alternative,pairedDelta,identityControlPassed:identityMatches,provenance:{...provenance,setup:setup.status==='READY'?{P0:setup.P0,A:setup.A,referenceOpen:setup.provenance.reference.openTime,dailyOpens:setup.provenance.daily.map(c=>c.openTime),cutoff:setup.provenance.cutoff}:null}};
}
export function quantile7(values,p){requireThat(values.length>0&&values.every(finite)&&finite(p)&&p>=0&&p<=1,'QUANTILE_INPUT');const a=[...values].sort((x,y)=>x-y),h=(a.length-1)*p,i=Math.floor(h);return a[i]+(h-i)*((a[i+1]??a[i])-a[i]);}
function summary(a){if(!a.length||!a.every(finite))return {mean:null,median:null,total:null};const total=a.reduce((s,x)=>s+x,0);return {mean:total/a.length,median:quantile7(a,.5),total};}
export function aggregate(records){
  const a=ordered(records),states={},fills={};
  for(const strategy of ['Baseline','Alternative']){states[strategy]={};fills[strategy]={};for(const d of ['LONG','SHORT']){states[strategy][d]={};fills[strategy][d]=0;for(const r of a){const x=r[strategy][d];states[strategy][d][x.terminalState]=(states[strategy][d][x.terminalState]??0)+1;fills[strategy][d]+=x.filled===true?1:0;}}}
  const numeric=a.filter(r=>finite(r.pairedDelta)).length;
  return {episodeCount:a.length,numericPairedCount:numeric,nonNumericPairedCount:a.length-numeric,Baseline:summary(a.map(r=>r.Baseline.episodeNetR)),Alternative:summary(a.map(r=>r.Alternative.episodeNetR)),pairedDelta:summary(a.map(r=>r.pairedDelta)),terminalStates:states,fillCounts:fills};
}
export function mulberry32(){let state=20261016,draws=0;return {next(){state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t=t^(t+Math.imul(t^(t>>>7),t|61));draws++;return ((t^(t>>>14))>>>0)/4294967296;},get state(){return state;},get draws(){return draws;}};}
export function sampleDateIndices(rng){const starts=[],indices=[];for(let b=0;b<53;b++){const s=Math.floor(rng.next()*359);starts.push(s);for(let j=0;j<7;j++)indices.push(s+j);}return {starts,candidateCount:indices.length,indices:indices.slice(0,365)};}
function requireNumeric(a){const bad=a.filter(r=>!finite(r.pairedDelta));if(bad.length){const e=Error('NON_NUMERIC_PRIMARY_DELTA:'+bad.map(r=>r.episodeId).join(','));e.episodes=bad.map(r=>r.episodeId);throw e;}}
export function primaryBootstrap(records){
  const a=exactUniverse(records);requireNumeric(a);const rng=mulberry32(),estimates=[];let firstReplicate;
  for(let rep=0;rep<10000;rep++){const draw=sampleDateIndices(rng);if(rep===0)firstReplicate=draw;let total=0;for(const day of draw.indices)for(let i=0;i<3;i++)total+=a[day*3+i].pairedDelta;estimates.push(total/1095);}
  requireThat(rng.draws===530000,'PRNG_DRAW_COUNT');
  return {method:'7-day non-wrapping moving-block',seed:20261016,replicates:10000,draws:rng.draws,finalState:rng.state,firstReplicate,lower:quantile7(estimates,.025),upper:quantile7(estimates,.975),median:quantile7(estimates,.5)};
}
export function advancement({integrityPass,numericPairedCount,mean,lower}){return integrityPass===true&&numericPairedCount===1095&&finite(mean)&&finite(lower)&&mean>0&&lower>0?'ADVANCE':'DO_NOT_ADVANCE';}
export function analyzeEpisodes(records,{integrityPass=false}={}){
  const a=exactUniverse(records);requireNumeric(a);
  requireThat(integrityPass&&a.every(r=>r.identityControlPassed===true),'INTEGRITY_GATE');
  const report=aggregate(a),bootstrap=primaryBootstrap(a);
  return {report,bootstrap,decision:advancement({integrityPass,numericPairedCount:report.numericPairedCount,mean:report.pairedDelta.mean,lower:bootstrap.lower})};
}
// Deliberate future execution interface. This function is NEVER called by synthetic tests.
export async function runDevelopment(sealPath,outputPath){
  try{await lstat(outputPath);throw Error('OUTPUT_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
  requireThat(!resolve(outputPath).startsWith(dirname(resolve(sealPath))+'/'),'OUTPUT_MUST_BE_OUTSIDE_SEALED_DATASET');
  const verified=await verifySealedInputs(sealPath),engine=await loadFrozenEngine(),maps=new Map();
  for(const instrument of UNIVERSE)for(const bar of ['1m','1D']){
    const path=`normalized/${instrument}_${bar}.jsonl`,bytes=verified.normalized.get(path);requireThat(bytes,'MISSING_NORMALIZED_INPUT:'+path);
    const rows=bytes.toString('utf8').trim().split('\n').map(JSON.parse);let prev=-Infinity;
    for(const r of rows){requireThat(r.instrument===instrument&&r.bar===bar&&r.openTime>prev,'NORMALIZED_IDENTITY_ORDER');prev=r.openTime;}
    maps.set(instrument+'/'+bar,new Map(rows.map(r=>[r.openTime,r])));
  }
  const provenance={...verified.provenance,amendment3Sha256:IDENTITY.amendment3Json,engineSha256:IDENTITY.engine,runnerSha256:sha(await readFile(fileURLToPath(import.meta.url)))};
  const results=developmentSchedule().map(e=>{
    const minutes=maps.get(e.instrument+'/1m'),days=maps.get(e.instrument+'/1D');
    const select=(map,times)=>times.map(t=>map.get(t)).filter(Boolean);
    return evaluateEpisode(engine,{...e,referenceCandles:select(minutes,[e.observationAt-M]),dailyCandles:select(days,Array.from({length:14},(_,i)=>e.observationAt-H-(14-i)*D)),candles:select(minutes,Array.from({length:720},(_,i)=>e.observationAt+i*M))},provenance);
  });
  const analysis=analyzeEpisodes(results,{integrityPass:true});
  await writeFile(outputPath,JSON.stringify({schemaVersion:SCHEMA,provenance,episodes:results,...analysis},null,2)+'\n',{flag:'wx'});
  return {outputPath,episodeCount:results.length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==5||process.argv[2]!=='--execute-development')throw Error('Usage: run-development-outcomes.mjs --execute-development SEAL_PATH NEW_OUTPUT_PATH');
  runDevelopment(resolve(process.argv[3]),resolve(process.argv[4])).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
