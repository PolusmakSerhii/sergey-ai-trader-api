import { createHash } from 'node:crypto';
import { requirePrivateApi } from '../lib/private-access.js';

// Temporary, incident-specific repair. No caller-selected key, hashes, indexes or payload.
const KEY = 'sergey-ai:open-trades:v1';
const SOURCE_SHA = 'df4846a7a65455d772d82c09f6c0da674dd71f469198450b5243d4d0892eff96';
const RECORD_SHA = '505800de226d1b229c4a66ce0e9c4a282f7a600e2641cb08022b87e2ffd107c5';
const sha = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);

// Same acceptance requirements as market.js parseOpenTrades; no repair or coercion.
export function validateOpenTrades(records) {
  if (!Array.isArray(records)) throw Error('VALIDATION_FAILED');
  const ids = new Set(), setups = new Set();
  for (const record of records) {
    if (!record?.tradeId || !record.setupKey || !record.initialPlan ||
        !['WaitingEntry', 'Pending', 'Active'].includes(record.outcome?.status) ||
        ids.has(record.tradeId) || setups.has(record.setupKey)) throw Error('VALIDATION_FAILED');
    ids.add(record.tradeId); setups.add(record.setupKey);
  }
}
export function prepareRepair(raw) {
  if (typeof raw !== 'string' || sha(raw) !== SOURCE_SHA) throw Error('SOURCE_CHANGED');
  const records = JSON.parse(raw);
  if (!Array.isArray(records) || records.length !== 13 || !object(records[6]) || !object(records[7])) throw Error('VALIDATION_FAILED');
  const a = canonical(records[6]), b = canonical(records[7]);
  if (a !== b || sha(a) !== RECORD_SHA || sha(b) !== RECORD_SHA ||
      records[6].tradeId !== records[7].tradeId || records[6].setupKey !== records[7].setupKey ||
      records[6].outcome?.status !== 'Active' || records[7].outcome?.status !== 'Active') throw Error('VALIDATION_FAILED');
  const repaired = records.filter((_, index) => index !== 7);
  const serialized = JSON.stringify(repaired);
  const roundtrip = JSON.parse(serialized);
  validateOpenTrades(roundtrip);
  if (roundtrip.length !== 12 || canonical(roundtrip[6]) !== a ||
      roundtrip.some((record, index) => canonical(record) !== canonical(records[index < 7 ? index : index + 1]))) throw Error('VALIDATION_FAILED');
  return serialized;
}
export const CAS_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;
export default async function handler(req, res) {
  if (!requirePrivateApi(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ status: 'POST_REQUIRED' });
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(503).json({ status: 'STORAGE_UNAVAILABLE' });
  const execute = async command => {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    if (!response.ok) throw Error('TRANSPORT');
    const data = await response.json();
    if (!object(data) || data.error) throw Error('TRANSPORT');
    return data.result;
  };
  let raw, prepared;
  try { raw = await execute(['GET', KEY]); }
  catch { return res.status(503).json({ status: 'SOURCE_READ_UNAVAILABLE', writeAttempted: false }); }
  try { prepared = prepareRepair(raw); }
  catch (error) {
    return res.status(409).json({ status: error.message === 'SOURCE_CHANGED' ? 'SOURCE_CHANGED' : 'VALIDATION_FAILED', writeAttempted: false });
  }
  let result;
  try { result = await execute(['EVAL', CAS_SCRIPT, '1', KEY, raw, prepared]); }
  catch {
    // A lost acknowledgement can follow a committed write. Never retry or claim no mutation.
    return res.status(503).json({ status: 'CAS_RESULT_UNKNOWN', writeAttempted: true, writeConfirmed: false });
  }
  if (result === 0) return res.status(409).json({ status: 'CAS_MISMATCH', writeAttempted: true, writeConfirmed: false });
  if (result !== 1) return res.status(503).json({ status: 'CAS_RESULT_UNKNOWN', writeAttempted: true, writeConfirmed: false });
  const summary = { writeConfirmed: true, preparedRawSha256: sha(prepared) };
  try {
    const stored = await execute(['GET', KEY]);
    if (stored !== prepared) return res.status(409).json({ status: 'VERIFICATION_CHANGED', ...summary });
    const records = JSON.parse(stored);
    validateOpenTrades(records);
    if (records.length !== 12) throw Error('INVALID');
    return res.status(200).json({ status: 'REPAIRED_VERIFIED', ...summary, sourceRawSha256: SOURCE_SHA,
      recordCount: 12, removedOriginalIndex: 7, retainedOriginalIndex: 6, validation: 'PASS' });
  } catch { return res.status(503).json({ status: 'VERIFICATION_UNAVAILABLE', ...summary }); }
}
