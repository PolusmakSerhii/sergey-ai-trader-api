import assert from 'node:assert/strict';
import {canonical} from './contract.mjs';
// Preserve each surviving JSON record's exact lexical bytes and original order.
export function recordSpans(raw){
 const rows=JSON.parse(raw);assert.ok(Array.isArray(rows),'ARRAY_REQUIRED');
 let i=0;while(/\s/.test(raw[i]||'')&&i<raw.length)i++;assert.equal(raw[i++],'[');
 const spans=[];
 for(let n=0;n<rows.length;n++){
  while(/\s/.test(raw[i]||'')&&i<raw.length)i++;const start=i;let depth=0,string=false,escape=false;
  for(;i<raw.length;i++){const ch=raw[i];if(string){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')string=false;continue;}if(ch==='"'){string=true;continue;}if(ch==='{'||ch==='[')depth++;if((ch===','||ch===']')&&depth===0)break;if(ch==='}'||ch===']')depth--;}
  const lexical=raw.slice(start,i).trimEnd();assert.equal(canonical(JSON.parse(lexical)),canonical(rows[n]));spans.push(lexical);if(n<rows.length-1)assert.equal(raw[i++],',');
 }
 return spans;
}
export function candidate(raw,rule){
 assert.equal(rule?.kind,'REMOVE_EXPLICIT_CANONICAL_IDENTICAL_DUPLICATES');
 const rows=JSON.parse(raw),spans=recordSpans(raw),removed=new Set();
 assert.ok(Array.isArray(rule.removals)&&rule.removals.length>0);
 for(const {removeIndex,keepIndex}of rule.removals){assert.ok(Number.isInteger(removeIndex)&&Number.isInteger(keepIndex)&&removeIndex>=0&&keepIndex>=0&&removeIndex<rows.length&&keepIndex<rows.length&&removeIndex!==keepIndex);assert.ok(!removed.has(removeIndex));assert.ok(rows[removeIndex]&&typeof rows[removeIndex]==='object');assert.ok(canonical(rows[removeIndex])===canonical(rows[keepIndex]),'NON_IDENTICAL_DUPLICATE_FORBIDDEN');assert.equal(typeof rows[removeIndex].tradeId,'string');assert.equal(typeof rows[removeIndex].setupKey,'string');removed.add(removeIndex);}
 for(const {keepIndex}of rule.removals)assert.ok(!removed.has(keepIndex),'SURVIVOR_REQUIRED');
 return '['+spans.filter((_,i)=>!removed.has(i)).join(',')+']';
}
