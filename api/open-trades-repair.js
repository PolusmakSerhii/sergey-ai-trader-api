import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { requirePrivateApi } from '../lib/private-access.js';
import market from './market.js';
import { buildIncidentScript } from '../lib/open-trades-repair-lua.js';

export const KEY = 'sergey-ai:open-trades:v1';
export const INCIDENT = Object.freeze({
  originalSha: 'b987ae4ffc6e6c65683e7e5c2e482f6c737f9aa6766b47b805ed5585741da275',
  originalBytes: 87415, originalCount: 18, keepIndex: 1, removeIndex: 2, candidateCount: 17,
  tradeIdSha: '2c5261655f0e84cb20b84a4a808a2571b20ec9e0e98afd60417821a4fc5c8779',
  setupKeySha: '66d59017a429a30dfa22e9d7b16fb7bc457f4baf54e9a1ae20ee04baf6259a5f',
  recordSha: '1f79e4d3c16b809417e722eac66f6449959172540b96d0bf50e6ec71f7014cbd'
});
export const BACKUP_KEY = `sergey-ai:recovery:open-trades:stage2:${INCIDENT.originalSha}:raw`;
const sha = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const gate = (ok, reason = 'VALIDATION_FAILED') => { if (!ok) throw Error(reason); };
const validation = market.openTradesValidation;
// Reuse the existing Lua guard verbatim; refuse source drift instead of maintaining a copy.
const marketBytes = readFileSync(new URL('./market.js', import.meta.url));
gate(createHash('sha1').update(`blob ${marketBytes.length}\0`).update(marketBytes).digest('hex') ===
  'fdfd17c67c05c1aad45cb2431781b2f9205be9fe', 'VALIDATOR_SOURCE_CHANGED');
const writeScript = marketBytes.toString('utf8').match(/const WRITE_OPEN_TRADES_SCRIPT = `([\s\S]*?)`;/)?.[1];
gate(typeof writeScript === 'string' && !writeScript.includes('\\') && !writeScript.includes('${'), 'LUA_SOURCE_CHANGED');
const guardEnd = writeScript.indexOf('local decoded, trades = pcall(cjson.decode, ARGV[2])');
gate(guardEnd > 0 && writeScript.startsWith('\nlocal function validTrades'), 'LUA_SOURCE_CHANGED');
export const EXACT_LUA_GUARD = writeScript.slice(0, guardEnd);
export const CAS_SCRIPT = buildIncidentScript({ key: KEY, backupKey: BACKUP_KEY, incident: INCIDENT, guard: EXACT_LUA_GUARD });

export function validateOpenTrades(records) {
  validation.parseOpenTrades(JSON.stringify(records));
  validation.validateProposedTradeSignals(records, true);
}
// JSON.parse validates the document; this scanner only locates original record lexemes.
export function recordSpans(raw) {
  const rows = JSON.parse(raw); gate(Array.isArray(rows));
  let i = 0; while (/\s/.test(raw[i] || '') && i < raw.length) i++; gate(raw[i++] === '[');
  const spans = [];
  for (let n = 0; n < rows.length; n++) {
    while (/\s/.test(raw[i] || '') && i < raw.length) i++;
    const start = i; let depth = 0, quoted = false, escaped = false;
    for (; i < raw.length; i++) {
      const ch = raw[i];
      if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
      if (ch === '"') { quoted = true; continue; }
      if ((ch === ',' || ch === ']') && depth === 0) break;
      if (ch === '{' || ch === '[') depth++;
      if (ch === '}' || ch === ']') depth--;
    }
    let end = i; while (end > start && /\s/.test(raw[end - 1])) end--;
    gate(end > start); spans.push({ start, end });
    if (n < rows.length - 1) gate(raw[i++] === ',');
  }
  return spans;
}
export function prepareRepair(raw) {
  gate(typeof raw === 'string' && sha(raw) === INCIDENT.originalSha, 'SOURCE_CHANGED');
  gate(Buffer.byteLength(raw, 'utf8') === INCIDENT.originalBytes);
  const rows = JSON.parse(raw); gate(Array.isArray(rows) && rows.length === INCIDENT.originalCount);
  const keep = rows[INCIDENT.keepIndex], removed = rows[INCIDENT.removeIndex];
  gate(object(keep) && object(removed));
  gate(canonical(keep) === canonical(removed) && sha(canonical(keep)) === INCIDENT.recordSha && sha(canonical(removed)) === INCIDENT.recordSha);
  gate(sha(canonical(keep.tradeId)) === INCIDENT.tradeIdSha && sha(canonical(removed.tradeId)) === INCIDENT.tradeIdSha);
  gate(sha(canonical(keep.setupKey)) === INCIDENT.setupKeySha && sha(canonical(removed.setupKey)) === INCIDENT.setupKeySha);
  // Every record passes both exact validators independently. Only the approved pair may repeat.
  const ids = new Map(), setups = new Map(); let duplicateIds = 0, duplicateSetups = 0;
  for (const [index, row] of rows.entries()) {
    validateOpenTrades([row]);
    for (const [field, seen] of [['tradeId', ids], ['setupKey', setups]]) {
      if (seen.has(row[field])) {
        gate(seen.get(row[field]) === INCIDENT.keepIndex && index === INCIDENT.removeIndex);
        if (field === 'tradeId') duplicateIds++; else duplicateSetups++;
      } else seen.set(row[field], index);
    }
  }
  gate(duplicateIds === 1 && duplicateSetups === 1);
  let parseRejected = false, jsRejected = false;
  try { validation.parseOpenTrades(raw); } catch (error) { gate(error?.message === 'Invalid or duplicate open trade'); parseRejected = true; }
  try { validation.validateProposedTradeSignals(rows, true); } catch (error) { gate(error?.message === 'Invalid or duplicate proposed trade signal'); jsRejected = true; }
  gate(parseRejected && jsRejected);
  const spans = recordSpans(raw), remove = spans[INCIDENT.removeIndex], next = spans[INCIDENT.removeIndex + 1];
  gate(remove && next);
  const candidateRaw = raw.slice(0, remove.start) + raw.slice(next.start);
  const candidate = JSON.parse(candidateRaw), candidateSpans = recordSpans(candidateRaw);
  gate(candidate.length === INCIDENT.candidateCount);
  const surviving = spans.filter((_, index) => index !== INCIDENT.removeIndex);
  gate(candidateSpans.every((span, index) => candidateRaw.slice(span.start, span.end) === raw.slice(surviving[index].start, surviving[index].end)));
  validation.parseOpenTrades(candidateRaw); validation.validateProposedTradeSignals(candidate, true);
  return candidateRaw;
}
export default async function handler(req, res) {
  if (!requirePrivateApi(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ status: 'POST_REQUIRED' });
  // No query/body option can select rollback, evidence, keys, candidate or transport commands.
  if (Object.keys(req.query || {}).length || Object.keys(req.body || {}).length) return res.status(400).json({ status: 'CALLER_OPTIONS_FORBIDDEN' });
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(503).json({ status: 'STORAGE_UNAVAILABLE' });
  let commands = 0;
  const execute = async command => {
    commands++;
    gate(commands <= 3, 'COMMAND_LIMIT');
    gate(commands === 2 ? command[0] === 'EVAL' && command[1] === CAS_SCRIPT && command[2] === '2' && command[3] === KEY && command[4] === BACKUP_KEY
      : command.length === 2 && command[0] === 'GET' && command[1] === KEY, 'COMMAND_LIMIT');
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    if (!response.ok) throw Error('TRANSPORT');
    const data = await response.json();
    if (!object(data) || data.error || !Object.hasOwn(data, 'result')) throw Error('TRANSPORT');
    return data.result;
  };
  let originalRaw, candidateRaw;
  try { originalRaw = await execute(['GET', KEY]); }
  catch { return res.status(503).json({ status: 'SOURCE_READ_UNAVAILABLE', writeAttempted: false }); }
  try { candidateRaw = prepareRepair(originalRaw); }
  catch (error) { return res.status(409).json({ status: error?.message === 'SOURCE_CHANGED' ? 'SOURCE_CHANGED' : 'VALIDATION_FAILED', writeAttempted: false }); }
  const candidateSha = sha(candidateRaw);
  let result;
  try { result = await execute(['EVAL', CAS_SCRIPT, '2', KEY, BACKUP_KEY, originalRaw, candidateRaw]); }
  catch { return res.status(503).json({ status: 'CAS_RESULT_UNKNOWN', writeAttempted: true, writeConfirmed: false, retryAllowed: false }); }
  // A transport replay may conceal a prior success. Never claim zero mutations from non-success.
  if (result !== 1) return res.status(result === 0 || result === -1 ? 409 : 503).json({ status: result === 0 ? 'CAS_NOT_CONFIRMED' : result === -1 ? 'BACKUP_EXISTS_STOP' : 'TRANSACTION_NOT_CONFIRMED', writeAttempted: true, writeConfirmed: false, retryAllowed: false });
  const summary = { writeConfirmed: true, originalSha256: INCIDENT.originalSha, originalByteLength: INCIDENT.originalBytes,
    candidateSha256: candidateSha, backupKey: BACKUP_KEY, backupSha256: INCIDENT.originalSha, backupMutationConfirmed: true, targetMutationConfirmed: true };
  try {
    const storedRaw = await execute(['GET', KEY]);
    if (typeof storedRaw !== 'string' || storedRaw !== candidateRaw || sha(storedRaw) !== candidateSha)
      return res.status(409).json({ status: 'VERIFICATION_CHANGED_STOP', ...summary, retryAllowed: false });
    const records = JSON.parse(storedRaw); gate(records.length === INCIDENT.candidateCount);
    validation.parseOpenTrades(storedRaw); validation.validateProposedTradeSignals(records, true);
    // Exact bytes equal the candidate accepted by the Lua guard before mutation: no second EVAL.
    return res.status(200).json({ status: 'REPAIRED_VERIFIED', ...summary, recordCount: records.length,
      retainedOriginalIndex: INCIDENT.keepIndex, removedOriginalIndex: INCIDENT.removeIndex, parse: 'PASS', js: 'PASS', lua: 'PASS', retryAllowed: false });
  } catch { return res.status(503).json({ status: 'VERIFICATION_UNAVAILABLE_STOP', ...summary, retryAllowed: false }); }
}
