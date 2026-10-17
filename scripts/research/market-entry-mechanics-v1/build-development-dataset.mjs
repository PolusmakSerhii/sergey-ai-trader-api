import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const M=60000,D=86400000;
export const instruments=['BTC-USDT-SWAP','ETH-USDT-SWAP','SOL-USDT-SWAP'];
export const sha=x=>createHash('sha256').update(x).digest('hex');
const start=Date.parse('2024-11-01T17:00:00Z'),end=Date.parse('2025-10-31T17:00:00Z');
const holdout=Date.parse('2025-11-02T00:00:00Z');
export function schedule(){return instruments.flatMap(instrument=>Array.from({length:365},(_,i)=>{const observationAt=start+i*D;return {episodeId:`market-entry-mechanics-v1.0:${instrument}:${new Date(observationAt).toISOString()}`,instrument,observationAt,referenceOpen:observationAt-M,firstExecutionOpen:observationAt,lastExecutionOpen:observationAt+12*60*M-M};}));}
export function windows(){const result=[];for(const instrument of instruments){for(let t=start;t<=end;t+=D)result.push({instrument,bar:'1m',lo:t-M,hi:t+12*60*M-M,step:M});const lastClose=start-60*M;result.push({instrument,bar:'1D',lo:lastClose-14*D,hi:end-60*M-D,step:D});}return result;}
export function pages(w){const out=[];for(let lo=w.lo;lo<=w.hi;lo+=300*w.step)out.push({...w,lo,hi:Math.min(w.hi,lo+299*w.step)});return out;}
export function validate(payload,w){
 if(payload?.code!=='0'||!Array.isArray(payload.data))throw Error('PROVIDER_SCHEMA');
 const rows=[],seen=new Set();let previous=Infinity,clipped=0,holdoutClipped=0;
 for(const a of payload.data){
  if(!Array.isArray(a)||a.length<9||!/^\d+$/.test(String(a[0])))throw Error('ROW_SCHEMA');
  const t=Number(a[0]);if(!Number.isSafeInteger(t))throw Error('TIMESTAMP');
  if(t<w.lo||t>w.hi){clipped++;if(t>=holdout)holdoutClipped++;continue;}
  if(seen.has(t))throw Error('DUPLICATE_OR_CONFLICT');seen.add(t);
  if(t>=previous)throw Error('TIMESTAMP_ORDER');previous=t;
  const v=a.slice(1,5).map(x=>typeof x==='string'&&x.trim()!==''?Number(x):NaN);
  const [o,h,l,c]=v,shift=w.bar==='1D'?16*60*60*1000:0;
  if((t-shift)%w.step||String(a[8])!=='1'||!v.every(x=>Number.isFinite(x)&&x>0)||l>Math.min(o,c)||h<Math.max(o,c)||l>h)throw Error('CANDLE_INTEGRITY');
  rows.push({instrument:w.instrument,bar:w.bar,openTime:t,closeTime:t+w.step,open:o,high:h,low:l,close:c,confirm:1});
 }
 const expected=(w.hi-w.lo)/w.step+1;
 if(rows.length!==expected)throw Error(`MISSING_CANDLES:${expected-rows.length}`);
 rows.sort((a,b)=>a.openTime-b.openTime);
 for(let i=0;i<rows.length;i++)if(rows[i].openTime!==w.lo+i*w.step)throw Error('COVERAGE');
 return {rows,clipped,holdoutClipped,source:payload.data.filter(a=>Number(a[0])>=w.lo&&Number(a[0])<=w.hi)};
}
async function optional(path){try{return await readFile(path,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
const json=x=>JSON.stringify(x,null,2)+'\n';
export async function obtain(w,dir,request){
 const id=`${w.instrument}_${w.bar}_${w.lo}_${w.hi}`,rawPath=join(dir,id+'.json'),logPath=join(dir,id+'.attempts.json');
 const cached=await optional(rawPath);
 if(cached!==null){const saved=JSON.parse(cached);return {...validate(saved.payload,w),cached:true,rawPath};}
 const history=JSON.parse(await optional(logPath)||'[]');
 for(let attempt=history.length;attempt<3;attempt++){
  const row={attempt:attempt+1,startedAt:new Date().toISOString(),status:'STARTED'};history.push(row);await writeFile(logPath,json(history));
  try{
   const url=new URL('https://www.okx.com/api/v5/market/history-candles');url.search=new URLSearchParams({instId:w.instrument,bar:w.bar,limit:'300',after:String(w.hi+1),before:String(w.lo-1)});
   row.url=url.href;const response=await request(url.href);row.http=response.status;
   if(response.status!==200)throw Error('HTTP_'+response.status);
   const payload=JSON.parse(response.text);
   row.recordHashes={};
   for(const a of Array.isArray(payload.data)?payload.data:[]){
    const t=Number(a?.[0]);if(!Number.isSafeInteger(t)||t<w.lo||t>w.hi)continue;
    try{validate({code:'0',data:[a]},{...w,lo:t,hi:t});}catch{continue;}
    const h=sha(JSON.stringify(a));
    if((row.recordHashes[t]&&row.recordHashes[t]!==h)||history.slice(0,-1).some(x=>x.recordHashes?.[t]&&x.recordHashes[t]!==h))row.conflict=true;
    row.recordHashes[t]=h;
   }
   if(row.conflict||history.some(x=>x.conflict))throw Error('PERSISTENT_SOURCE_CONFLICT');
   const validated=validate(payload,w);
   row.status='PASS';row.clipped=validated.clipped;row.holdoutClipped=validated.holdoutClipped;
   // Exact response text is kept only when wholly within scope. Extra rows are never persisted.
   await writeFile(rawPath,json({window:w,request:row,rawText:validated.clipped?null:response.text,payload:{code:'0',data:validated.source},filtered:validated.clipped>0}),{flag:'wx'});
   await writeFile(logPath,json(history));return {...validated,cached:false,rawPath};
  }catch(e){row.status='FAIL';row.error=e.message;await writeFile(logPath,json(history));if(attempt===2)throw Error(`${id}:RECOVERY_EXHAUSTED:${e.message}`);}
 }
 throw Error(id+':RECOVERY_EXHAUSTED');
}
const identities={
 'docs/research/market-entry-mechanics-v1.0.md':['e3c73966e22e8e5637a76a60a07d34dd6e44b026','2306fb61299d8ec61fef8a22293c9c811e0f79d5dc2442d5b14c2a33d595d242'],
 'docs/research/market-entry-mechanics-v1.0.json':['e3c73966e22e8e5637a76a60a07d34dd6e44b026','76a1876bbc8a73178f2b6b77a41dfa7dd1e98f4878ad48353a5c94bbdea7c17c'],
 'docs/research/market-entry-mechanics-v1.0-amendment-1.md':['b69c3612000a53468849094dd876d8c702485712','3d4e64c96a13caa13ad6ad7992016eac81f0c796d622453b4f7fa60e2f3b81f3'],
 'docs/research/market-entry-mechanics-v1.0-amendment-1.json':['b69c3612000a53468849094dd876d8c702485712','c6d4873b3d1de4b2ac1675126b591079d5b4cffd60f2284bb89b35fa0b09e11b'],
 'scripts/research/market-entry-mechanics-v1/engine.mjs':['635f661a2215bd3bc75513fd0ff8023bfd65588f','5c79833481e6333639ab24b42f2aff5a114a18c9dc00d752c38b3629020ee5e8']};
export async function build(output,auditPath){
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 for(const [file,[,hash]]of Object.entries(identities))if(sha(await readFile(join(root,file)))!==hash)throw Error('FROZEN_IDENTITY_MISMATCH:'+file);
 const audit=JSON.parse(await readFile(auditPath,'utf8'));if(audit.status!=='PASS'||!audit.scope)throw Error('CLEANLINESS_AUDIT_REQUIRED');
 if(await optional(join(output,'manifest.json')))throw Error('ALREADY_SEALED');
 const episodes=schedule();if(episodes.length!==1095||new Set(episodes.map(x=>x.episodeId)).size!==1095)throw Error('EPISODE_COUNT');
 await mkdir(join(output,'raw'),{recursive:true});await mkdir(join(output,'normalized'),{recursive:true});
 const fileList=[],counts={},list=windows().flatMap(pages);let calls=0,last=0,processed=0;
 const request=async url=>{await new Promise(r=>setTimeout(r,Math.max(0,300-(Date.now()-last))));last=Date.now();calls++;const response=await fetch(url,{signal:AbortSignal.timeout(30000)});return {status:response.status,text:await response.text()};};
 for(const instrument of instruments){const all={'1m':[],'1D':[]};for(const w of list.filter(x=>x.instrument===instrument)){
  if(w.hi>=holdout)throw Error('HOLDOUT_WINDOW');
  const result=await obtain(w,join(output,'raw'),request);all[w.bar].push(...result.rows.map(c=>({...c,sourcePage:result.rawPath.split('/').at(-1)})));
  processed++;if(processed%50===0)console.log(JSON.stringify({pages:processed,totalPages:list.length,httpThisRun:calls}));
 }
 counts[instrument]={};for(const bar of ['1m','1D']){const rows=all[bar].sort((a,b)=>a.openTime-b.openTime);if(new Set(rows.map(x=>x.openTime)).size!==rows.length)throw Error('GLOBAL_DUPLICATE');
 const expected=bar==='1m'?365*721:378;if(rows.length!==expected)throw Error('GLOBAL_COVERAGE');
 const path=join(output,'normalized',instrument+'_'+bar+'.jsonl'),text=rows.map(JSON.stringify).join('\n')+'\n';const existing=await optional(path);if(existing!==null&&existing!==text)throw Error('NORMALIZED_CONFLICT');if(existing===null)await writeFile(path,text,{flag:'wx'});counts[instrument][bar]=rows.length;
 }}
 const epText=json(episodes),epPath=join(output,'episodes.json');const old=await optional(epPath);if(old!==null&&old!==epText)throw Error('EPISODE_CONFLICT');if(old===null)await writeFile(epPath,epText,{flag:'wx'});
 let totalRequests=0,retries=0,failedAttempts=0,incidentalHoldout=0,clipped=0;
 for(const name of (await readdir(join(output,'raw'))).sort()){const rel='raw/'+name,bytes=await readFile(join(output,rel));fileList.push({path:rel,sha256:sha(bytes)});if(name.endsWith('.attempts.json')){const a=JSON.parse(bytes);totalRequests+=a.length;retries+=Math.max(0,a.length-1);failedAttempts+=a.filter(x=>x.status!=='PASS').length;incidentalHoldout+=a.reduce((n,x)=>n+(x.holdoutClipped||0),0);clipped+=a.reduce((n,x)=>n+(x.clipped||0),0);}}
 for(const name of (await readdir(join(output,'normalized'))).sort()){const rel='normalized/'+name;fileList.push({path:rel,sha256:sha(await readFile(join(output,rel)))});}
 fileList.push({path:'episodes.json',sha256:sha(epText)});
 const manifest={protocol:'market-entry-mechanics-v1.0-amendment-1',datasetVersion:'development-v1',createdAt:new Date().toISOString(),source:'https://www.okx.com/api/v5/market/history-candles',identities,universe:instruments,calendar:{start:'2024-11-01',end:'2025-10-31',observation:'17:00:00 UTC'},episodeCount:1095,uniqueEpisodeCount:1095,episodeIdHash:sha(episodes.map(x=>x.episodeId).join('\n')),windows:windows(),counts,rawSourceRecords:counts,normalizedRecords:counts,missing:0,duplicates:0,conflicts:0,unconfirmed:0,invalid:0,validation:'PASS',totalRequests,retries,failedAttempts,clipped,incidentalHoldout,holdoutFirewall:'PASS: no out-of-scope rows persisted',cleanlinessAudit:audit,cleanlinessAuditSha256:sha(await readFile(auditPath)),builderSha256:sha(await readFile(fileURLToPath(import.meta.url))),files:fileList};
 for(const [file,[,hash]]of Object.entries(identities))if(sha(await readFile(join(root,file)))!==hash)throw Error('FROZEN_IDENTITY_CHANGED');
 await writeFile(join(output,'manifest.json'),json(manifest),{flag:'wx'});console.log(JSON.stringify({sealed:true,counts,totalRequests,retries,failedAttempts,incidentalHoldout,manifestSHA:sha(json(manifest))}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==4)throw Error('Usage: build-development-dataset.mjs OUTPUT_DIR CLEANLINESS_AUDIT_JSON');
 build(resolve(process.argv[2]),resolve(process.argv[3])).catch(e=>{console.error('DATASET SEALING: FAIL',e.message);process.exitCode=1;});
}
