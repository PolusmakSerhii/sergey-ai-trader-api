import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v!==null&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}`:JSON.stringify(v);
const endpoint=new URL('../../api/open-trades-repair.js',import.meta.url);
const source=await readFile(endpoint,'utf8');
const production={originalSha:'b987ae4ffc6e6c65683e7e5c2e482f6c737f9aa6766b47b805ed5585741da275',tradeIdSha:'2c5261655f0e84cb20b84a4a808a2571b20ec9e0e98afd60417821a4fc5c8779',setupKeySha:'66d59017a429a30dfa22e9d7b16fb7bc457f4baf54e9a1ae20ee04baf6259a5f',recordSha:'1f79e4d3c16b809417e722eac66f6449959172540b96d0bf50e6ec71f7014cbd'};
export async function fixture({mutate,overrides={},rawOverride,candidateFailure}={}){
 const rows=Array.from({length:18},(_,i)=>({tradeId:`synthetic-id-${i}`,setupKey:`synthetic-setup-${i}`,initialPlan:{entryPrice:100,nested:['quote"','backslash\\',{levels:[1,2]}]},outcome:{status:'Active'}}));
 rows[0].note='Привіт 😀';rows[2]=structuredClone(rows[1]);if(mutate)mutate(rows);
 let parts=rows.map(r=>JSON.stringify(r));
 // Different whitespace/key ordering/numeric lexeme on the retained record, unchanged semantics.
 if(!mutate){parts[1]='{ "tradeId":"synthetic-id-1", "setupKey":"synthetic-setup-1", "initialPlan":{"entryPrice":1e2,"nested":["quote\\\"","backslash\\\\",{"levels":[1,2]}]}, "outcome":{"status":"Active"} }';}
 const serialize=()=> '[\r\n  '+parts.join(',\r\n  ')+'\r\n]\n';let raw=serialize();
 rows[0].padding='x'.repeat(87415-Buffer.byteLength(raw)-13);parts[0]=JSON.stringify(rows[0]);raw=serialize();
 // Account for JSON property overhead without changing any incident payload value.
 if(Buffer.byteLength(raw)!==87415){rows[0].padding+='x'.repeat(87415-Buffer.byteLength(raw));parts[0]=JSON.stringify(rows[0]);raw=serialize();}
 assert.equal(Buffer.byteLength(raw),87415);if(rawOverride)raw=rawOverride(raw);
 const parsed=JSON.parse(raw),pair=parsed[1];
 const evidence={originalSha:hash(raw),tradeIdSha:hash(canonical(pair?.tradeId) ?? "missing"),setupKeySha:hash(canonical(pair?.setupKey) ?? "missing"),recordSha:hash(canonical(pair)),...overrides};
 let code=source;
 for(const [name,value]of Object.entries(evidence))if(name in production)code=code.replaceAll(production[name],value);
 if('originalBytes' in overrides)code=code.replace('originalBytes: 87415','originalBytes: '+overrides.originalBytes);
 code=code.replace("'../lib/private-access.js'",JSON.stringify(new URL('../../lib/private-access.js',import.meta.url).href))
  .replace("'./market.js'",JSON.stringify(new URL('../../api/market.js',import.meta.url).href))
  .replace("'../lib/open-trades-repair-lua.js'",JSON.stringify(new URL('../../lib/open-trades-repair-lua.js',import.meta.url).href))
  .replace("new URL('./market.js', import.meta.url)",'new URL('+JSON.stringify(new URL('../../api/market.js',import.meta.url).href)+')');
 // Explicit test-only fault injection: fail a candidate validator after valid originals.
 if(candidateFailure==='parse')code=code.replace('const validation = market.openTradesValidation;',`const realValidation=market.openTradesValidation;const validation={...realValidation,parseOpenTrades(raw){if(JSON.parse(raw).length===17)throw Error('Invalid or duplicate open trade');return realValidation.parseOpenTrades(raw);}};`);
 if(candidateFailure==='js')code=code.replace('const validation = market.openTradesValidation;',`const realValidation=market.openTradesValidation;const validation={...realValidation,validateProposedTradeSignals(rows,openOnly){if(rows.length===17)throw Error('Invalid or duplicate proposed trade signal');return realValidation.validateProposedTradeSignals(rows,openOnly);}};`);
 const api=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
 return {api,raw,rows:parsed,evidence};
}
export async function invoke(f,{method='POST',badAuth=false,query={},body={},failAt,ackLost=false,result=1,changedReadback=false,missingConfig=false}={}){
 const saved={...process.env},oldFetch=globalThis.fetch,calls=[];let target=f.raw,backup=null;
 Object.assign(process.env,{SM1M_API_SECRET:'synthetic-owner-secret-'.repeat(4),UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'synthetic-token'});
 if(missingConfig){delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.KV_REST_API_URL;}
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,'https://redis.invalid');assert.equal(options.redirect,'error');assert.ok(options.signal);
  const command=JSON.parse(options.body);calls.push(command);if(failAt===calls.length)throw Error('PRIVATE_PROVIDER_PAYLOAD');
  let value;
  if(command[0]==='GET'){assert.deepEqual(command,['GET',f.api.KEY]);value=calls.length===3&&changedReadback?'[]':target;}
  else{assert.deepEqual(command.slice(0,5),['EVAL',f.api.CAS_SCRIPT,'2',f.api.KEY,f.api.BACKUP_KEY]);assert.equal(command[5],target);value=result;if(value===1){backup=target;target=command[6];}if(ackLost)throw Error('PRIVATE_LOST_ACK');}
  return {ok:true,json:async()=>({result:value})};
 };
 const res={setHeader(){},status(n){this.code=n;return this;},json(value){this.body=value;return this;}};
 try{await f.api.default({method,headers:{authorization:badAuth?'Bearer wrong':`Bearer ${process.env.SM1M_API_SECRET}`},query,body},res);return {res,calls,target,backup};}
 finally{globalThis.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
}
