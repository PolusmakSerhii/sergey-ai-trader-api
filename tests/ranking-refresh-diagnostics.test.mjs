import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
const source=(await readFile(new URL('../api/market.js',import.meta.url),'utf8'))
 .replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
function harness(mode){
 const events=[],commands=[];let batches=0;
 const c=vm.createContext({process:{env:mode==='missing'?{}:{UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'SECRET'}},URL,Date,AbortSignal,randomUUID,console:{log(prefix,event){if(prefix==='[ranking-refresh]')events.push(JSON.parse(event));},error(){}},
 fetch:async(url,options)=>{
  if(String(url)==='https://redis.test'){
   const cmd=JSON.parse(options.body);commands.push(cmd);
   if(cmd[0]==='SET'){
    if(mode==='exception')throw new Error('SECRET https://redis.test');
    if(mode==='http')return {ok:false,status:401};
    if(mode==='invalid')return {ok:true,json:async()=>({unexpected:true})};
    if(mode==='payload_error')return {ok:true,json:async()=>({error:'SECRET'})};
    return {ok:true,json:async()=>({result:mode==='busy'?null:'OK'})};
   }
   const release=cmd[1].includes("redis.call('DEL'");
   if(release && mode==='release')throw Object.assign(new Error('SECRET'),{name:'TimeoutError'});
   if(!release && mode==='lease')return {ok:true,json:async()=>({error:'Ranking refresh lease lost'})};
   return {ok:true,json:async()=>({result:1})};
  }
  batches++;
  if(mode==='batch')throw new Error('SECRET');
  return {ok:true,json:async()=>({ok:true,totalBatches:1,failed:0,globalBatchResults:[{symbol:'BTCUSDT',opportunityScore:90}]})};
 }});
 vm.runInContext(source,c);c.verifyQStashRequest=async()=>true;
 c.writeGlobalRankingCache=async()=>mode!=='persist';c.writeRankingHistory=async()=>true;
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 return {events,commands,res,get batches(){return batches;},run:()=>c.handler({method:'POST',headers:{host:'api.test'},query:{mode:'scanner',globalRank:'true',refresh:'true'}},res)};
}
for(const [mode,result] of [['ok','acquired'],['busy','busy'],['missing','missing_config'],['exception','redis_error'],['http','redis_error'],['invalid','redis_error'],['payload_error','redis_error']])test(`acquire ${mode}`,async()=>{
 const h=harness(mode);await h.run();assert.equal(h.events[0].stage,'acquire');assert.equal(h.events[0].result,result);
 assert.equal(h.res.code,mode==='ok'?200:503);
 if(mode!=='ok')assert.equal(h.batches,0);
 if(['busy','missing','invalid'].includes(mode))assert.equal(h.res.headers['Retry-After'],'60');
 if(mode==='missing')assert.equal(h.commands.length,0);
 assert.ok(h.events.every(e=>e.requestId===h.events[0].requestId && e.elapsedMs>=0));
 assert.ok(!JSON.stringify(h.events).includes('SECRET'));assert.ok(!JSON.stringify(h.events).includes('redis.test'));
 if(h.commands.length){const acquire=h.commands[0];assert.deepEqual(acquire.slice(3),['NX','EX',900]);assert.notEqual(h.events[0].requestId,acquire[2]);}
 if(mode==='ok'){
  const token=h.commands[0][2],renew=h.commands.find(c=>c.includes('EXPIRE')),release=h.commands.at(-1);
  assert.equal(renew[4],token);assert.match(renew[1],/GET.*KEYS\[1\]/);assert.match(renew[1],/lease lost/);
  assert.equal(release[4],token);assert.match(release[1],/== ARGV\[1\]/);assert.match(release[1],/redis.call\('DEL'/);
 }
});
for(const [mode,stage,result,status] of [['lease','renew','lease_lost',503],['batch','batch','batch_error',503],['persist','persist','persist_error',503],['release','release','release_error',200]])test(`${stage} diagnostic preserves response`,async()=>{
 const h=harness(mode);await h.run();assert.ok(h.events.some(e=>e.stage===stage&&e.result===result));assert.equal(h.res.code,status);
 assert.equal(new Set(h.events.map(e=>e.requestId)).size,1);
 assert.ok(!JSON.stringify(h.events).includes('SECRET'));
});
