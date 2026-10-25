import { createHash } from 'node:crypto';
import { requirePrivateApi } from '../lib/private-access.js';

// Temporary incident diagnostic: fixed key, fixed indexes, read-only transport.
const KEY = 'sergey-ai:open-trades:v1';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = v => createHash('sha256').update(v).digest('hex');
const identityHash = v => v == null ? null : sha(JSON.stringify(v)).slice(0, 16);
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : object(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const TIMES = new Set(['capturedAt','createdAt','updatedAt','detectedAt','plannedAt','expiresAt','activatedAt',
  'checkedAt','verificationBoundaryAt','lastPriceCheckedAt','analysisAt','decidedAt','executedAt',
  'verifiedAt','fromTime','toTime','timestamp','closeTime','openTime','completedAt']);
const CONTAINERS = new Set(['origin','initialPlan','exitStrategy','outcome','priceCheck','entryCheck','exitCheck',
  'managementPending','candle','lastReanalysis','evidence','executions','exits','events']);
const VERSIONS = new Set(['version','revision','schemaVersion','rulesRevision','lifecycleVersion']);
const KNOWN_VERSIONS = new Set(['closed-candles-v2','tp1-reanalysis-candles-v1','partial-candles-v1',
  'tp1-50-reanalyse-v1','partial-25-25-50-be-v1']);
function time(v) {
  if (v === null) return null;
  if (!(typeof v === 'number' && Number.isFinite(v)) &&
      !(typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v))) return 'INVALID';
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(new Date(n).getTime()) ? new Date(n).toISOString() : 'INVALID';
}
function project(record, index) {
  const timestamps = {}, versions = {}, structures = {}, arrayCounts = {};
  function visit(v, path = '', depth = 0) {
    if (depth > 16) throw Error('INVALID');
    for (const [key, value] of Object.entries(v)) {
      const p = path ? `${path}.${key}` : key;
      if (TIMES.has(key)) timestamps[p] = time(value);
      if (VERSIONS.has(key)) versions[p] = KNOWN_VERSIONS.has(value) ? value
        : { valueHash: identityHash(value) }; // Unknown version strings never leak arbitrary content.
      if (CONTAINERS.has(key)) {
        structures[p] = value == null ? 'MISSING' : Array.isArray(value) ? 'ARRAY' : object(value) ? 'OBJECT' : 'INVALID';
        if (Array.isArray(value)) {
          arrayCounts[p] = value.length;
          value.forEach((entry, i) => { if (object(entry)) visit(entry, `${p}[${i}]`, depth + 1); });
        } else if (object(value)) visit(value, p, depth + 1);
      }
    }
  }
  visit(record);
  for (const key of ['initialPlan','outcome','outcome.entryCheck','outcome.exitCheck','outcome.priceCheck',
    'outcome.managementPending','outcome.lastReanalysis','outcome.exits','outcome.executions','outcome.events']) {
    structures[key] ??= 'MISSING';
  }
  const status = record.outcome?.status;
  return { index, tradeIdHash: identityHash(record.tradeId), setupKeyHash: identityHash(record.setupKey),
    outcome: { status: ['WaitingEntry','Pending','Active','Stopped','Closed','Expired','TP1Hit','TP3Hit'].includes(status)
      ? status : status == null ? 'MISSING' : 'OTHER' },
    timestamps, versions, structures, arrayCounts,
    // Boolean pending flags distinguish deferred management from verified progress, without prices.
    progress: { reanalysisPending: typeof record.outcome?.reanalysisPending === 'boolean' ? record.outcome.reanalysisPending : null },
    initialPlanHash: object(record.initialPlan) ? sha(canonical(record.initialPlan)) : null,
    topLevelFieldNames: Object.keys(record).sort() };
}
export function diagnose(raw) {
  if (typeof raw !== 'string') throw Error('INVALID');
  const records = JSON.parse(raw);
  if (!Array.isArray(records) || !object(records[6]) || !object(records[7])) throw Error('INVALID');
  if (records.some(record => !object(record) || typeof record.tradeId !== 'string' || !record.tradeId)) throw Error('INVALID');
  const canonicalRecords = records.map(canonical);
  const recordFingerprints = records.map((record, index) => ({
    index, canonicalSha256: sha(canonicalRecords[index]), tradeIdSha256: sha(record.tradeId)
  }));
  const pair = [6, 7].map(index => ({ ...project(records[index], index),
    canonicalSha256: recordFingerprints[index].canonicalSha256 }));
  const same = (a,b) => canonical(a ?? null) === canonical(b ?? null) ? 'SAME' : 'DIFFERENT';
  return { rawByteLength: Buffer.byteLength(raw, 'utf8'), rawSha256: sha(raw),
    recordCount: records.length, recordFingerprints,
    records6And7CanonicalEqual: canonicalRecords[6] === canonicalRecords[7],
    initialPlanHashFormat: 'SHA-256 recursively key-sorted JSON', records: pair,
    comparison: { tradeId: same(records[6].tradeId, records[7].tradeId), setupKey: same(records[6].setupKey, records[7].setupKey),
      initialPlan: same(pair[0].initialPlanHash, pair[1].initialPlanHash),
      onlyIn6: pair[0].topLevelFieldNames.filter(k => !Object.hasOwn(records[7], k)),
      onlyIn7: pair[1].topLevelFieldNames.filter(k => !Object.hasOwn(records[6], k)) } };
}
export default async function handler(req, res) {
  if (!requirePrivateApi(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET_REQUIRED' });
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(503).json({ error: 'STORAGE_UNAVAILABLE' });
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['GET', KEY]) });
    if (!response.ok) throw Error('UNAVAILABLE');
    const data = await response.json();
    if (!object(data) || data.error) throw Error('UNAVAILABLE');
    return res.status(200).json(diagnose(data.result));
  } catch {
    return res.status(503).json({ error: 'DIAGNOSTIC_UNAVAILABLE' });
  }
}
