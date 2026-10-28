import {mkdtemp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
export async function withLocalRedis(fn){
 const dir=await mkdtemp(join(tmpdir(),'contract-gate-')),socket=join(dir,'redis.sock');
const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
let startupError;server.on('error',e=>{startupError=e;});
// RESP over Unix socket: payload never goes through argv, shell or TCP.
function command(args){return new Promise((resolve,reject)=>{const conn=createConnection(socket);let data=Buffer.alloc(0);const timer=setTimeout(()=>{conn.destroy();reject(Error('LOCAL_TIMEOUT'));},5000);const finish=v=>{clearTimeout(timer);conn.destroy();resolve(v);};conn.on('error',e=>{clearTimeout(timer);reject(e);});conn.on('connect',()=>{const parts=[Buffer.from(`*${args.length}\r\n`)];for(const arg of args){const b=Buffer.isBuffer(arg)?arg:Buffer.from(String(arg));parts.push(Buffer.from(`$${b.length}\r\n`),b,Buffer.from('\r\n'));}conn.write(Buffer.concat(parts));});conn.on('data',chunk=>{data=Buffer.concat([data,chunk]);const end=data.indexOf('\r\n');if(end<0)return;const type=String.fromCharCode(data[0]),header=data.subarray(1,end).toString();if(type==='$'){const n=Number(header);if(n===-1)return finish({value:null});if(data.length<end+2+n+2)return;return finish({value:data.subarray(end+2,end+2+n)});}if(type==='-')return finish({error:header});if(type===':')return finish({value:Number(header)});if(type==='+')return finish({value:header});clearTimeout(timer);conn.destroy();reject(Error('RESP_ERROR'));});});}

 try {
 let ready=false;for(let i=0;i<100;i++){if(startupError)throw startupError;try{ready=(await command(['PING'])).value==='PONG';}catch{}if(ready)break;await new Promise(r=>setTimeout(r,20));}assert.ok(ready,'LOCAL_REDIS_READY');
 const validate=async(lua,raw)=>{const r=await command(['EVAL',lua,'3','synthetic:open','synthetic:history','synthetic:ids','deliberate-cas-mismatch',raw,'','','100']);if(r.value===0)return 'PASS';return ['Invalid proposed open trades','ERR Invalid proposed open trades'].includes(r.error)?'REJECT':'EXECUTION_ERROR';};
 const result=await fn({command,validate});assert.equal((await command(['DBSIZE'])).value,0,'OFFLINE_VALIDATION_MUST_NOT_WRITE');return result;
 }finally{if(server.exitCode===null&&!startupError){server.kill();await new Promise(r=>server.once('exit',r));}await rm(dir,{recursive:true,force:true});}
}
