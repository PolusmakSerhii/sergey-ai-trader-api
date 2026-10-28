// OFFLINE ONLY. No production transport, credentials or environment loading.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {loadContract,sha256} from './contract.mjs';
import {candidate} from './candidate.mjs';
import {withLocalRedis} from './local-redis.mjs';
export async function evaluate(raw,contract,redis){
 const PARSE=contract.parse(raw).result,JS=contract.js(raw),LUA=await redis.validate(contract.lua,raw);
 return {PARSE,JS,LUA,ALL_THREE_PASS:[PARSE,JS,LUA].every(r=>r==='PASS'),ALL_THREE_AGREE:PARSE===JS&&JS===LUA};
}
export async function stepB(raw,rule){const contract=await loadContract();const hypothetical=candidate(raw,rule);return withLocalRedis(async redis=>({CORE_SHA:(await import('./contract.mjs')).CORE_SHA,RAW_SHA256:sha256(raw),CANDIDATE_SHA256:sha256(hypothetical),CURRENT:await evaluate(raw,contract,redis),HYPOTHETICAL:await evaluate(hypothetical,contract,redis)}));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [backup,rulePath]=process.argv.slice(2);if(!backup||!rulePath)throw Error('Usage: node step-b.mjs exact-raw-backup approved-rule.json');
 console.log(JSON.stringify(await stepB(await readFile(backup,'utf8'),JSON.parse(await readFile(rulePath,'utf8'))),null,2));
}
