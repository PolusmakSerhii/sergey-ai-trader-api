// PREPARED transport only: constructing/importing this module never connects.
// Callers provide credentials explicitly after approval. No env files are read.
import assert from 'node:assert/strict';
import {KEY} from './contract.mjs';
export function approvedTransport({endpoint,token,mode,casScript=null,fetchImpl=globalThis.fetch}){
 const url=new URL(endpoint);assert.equal(url.protocol,'https:');assert.equal(url.username,'');assert.equal(url.password,'');assert.equal(url.search,'');assert.equal(url.hash,'');
 assert.ok(typeof token==='string'&&token.length>0);assert.ok(['STEP_A','REPAIR'].includes(mode));let calls=0;
 return async command=>{
  // Count attempts BEFORE transport: timeout/error/uncertainty consumes capability.
  const index=calls++;
  if(mode==='STEP_A')assert.ok(index===0&&command.length===2&&command[0]==='GET'&&command[1]===KEY,'ONE_EXACT_GET_ONLY');
  else if(index===0)assert.ok(typeof casScript==='string'&&casScript.length>0&&command.length===6&&command[0]==='EVAL'&&command[1]===casScript&&command[2]==='1'&&command[3]===KEY,'ONE_CAS_ONLY');
  else assert.ok(index===1&&command.length===2&&command[0]==='GET'&&command[1]===KEY,'ONE_VERIFICATION_GET_ONLY');
  const response=await fetchImpl(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(command),redirect:'error',signal:AbortSignal.timeout(15000)});
  assert.equal(response.ok,true,'REDIS_HTTP_ERROR_STOP');const body=await response.json();assert.ok(!body.error,'REDIS_ERROR_STOP');assert.ok(Object.hasOwn(body,'result'),'REDIS_RESULT_REQUIRED');return body.result;
 };
}
