import { createHash } from 'node:crypto';
import { requirePrivateApi } from '../lib/private-access.js';
import market from './market.js';

// Incident diagnostic only: fixed key, one logical read, no caller-selected command.
const KEY = 'sergey-ai:open-trades:v1';
const sha = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const type = value => value === null ? 'null' : Array.isArray(value) ? 'array'
  : ['string', 'number', 'boolean', 'object', 'undefined'].includes(typeof value) ? typeof value : 'other';
const missing = value => value == null || value === '';
// Recovery protection, including lifecycle evidence that the application itself advances.
const FROZEN = new Set(['tradeId','setupKey','setupId','symbol','direction','initialPlan','entryZone',
  'stopLoss','takeProfit1','takeProfit2','takeProfit3','outcome','action','tradeAllowed','tradeReadiness',
  'opportunityScore','opportunityGrade','confidence','grade','riskReward','researchSnapshot','entryDecision']);
const MUTABLE = new Set(['capturedAt','signalId','price']);

function parseStatus(raw, validation) {
  try { validation.parseOpenTrades(raw); return { status: 'PASS', reason: null }; }
  catch (error) {
    if (error instanceof SyntaxError) return { status: 'REJECT', reason: 'INVALID_JSON' };
    if (error?.message === 'Invalid open trades state') return { status: 'REJECT', reason: 'INVALID_ROOT' };
    if (error?.message === 'Invalid or duplicate open trade') return { status: 'REJECT', reason: 'INVALID_OR_DUPLICATE_OPEN_TRADE' };
    return { status: 'EXECUTION_ERROR', reason: 'VALIDATOR_EXECUTION_ERROR' };
  }
}
function jsStatus(records, validation) {
  try { validation.validateProposedTradeSignals(records, true); return { status: 'PASS', reason: null }; }
  catch (error) {
    if (error?.message === 'Invalid proposed trade signals') return { status: 'REJECT', reason: 'INVALID_ROOT' };
    if (error?.message === 'Invalid or duplicate proposed trade signal') return { status: 'REJECT', reason: 'INVALID_OR_DUPLICATE_PROPOSED_TRADE_SIGNAL' };
    return { status: 'EXECUTION_ERROR', reason: 'VALIDATOR_EXECUTION_ERROR' };
  }
}
function groups(records, field) {
  const identities = new Map();
  records.forEach((record, index) => {
    const identity = record?.[field];
    if (missing(identity)) return;
    const encoded = canonical(identity), key = `${type(identity)}:${encoded}`;
    if (!identities.has(key)) identities.set(key, { encoded, identityType: type(identity), indexes: [] });
    identities.get(key).indexes.push(index);
  });
  return [...identities.values()].filter(group => group.indexes.length > 1).map(group => {
    const rows = group.indexes.map(index => records[index]);
    const fields = [...new Set(rows.flatMap(row => Object.keys(row)))].sort();
    const differing = fields.filter(field => rows.some(row =>
      Object.hasOwn(row, field) !== Object.hasOwn(rows[0], field) || canonical(row[field]) !== canonical(rows[0][field])));
    return {
      identityType: group.identityType, identitySha256: sha(group.encoded), indexes: group.indexes,
      count: rows.length, allCanonicalEqual: rows.every(row => canonical(row) === canonical(rows[0])),
      canonicalSha256ByIndex: group.indexes.map(index => ({ index, sha256: sha(canonical(records[index])) })),
      frozenDifferingFieldNames: differing.filter(field => FROZEN.has(field)),
      mutableDifferingFieldNames: differing.filter(field => MUTABLE.has(field)),
      unknownDifferingFieldNames: differing.filter(field => !FROZEN.has(field) && !MUTABLE.has(field))
    };
  });
}
// Pure hypothetical only. Original object references and first-occurrence order survive.
// This function never persists, changes records, or chooses between differing records.
export function buildHypothetical(records) {
  const ids = new Map(), setups = new Map(), result = [];
  for (const record of records) {
    if (typeof record?.tradeId !== 'string' || !record.tradeId ||
        typeof record.setupKey !== 'string' || !record.setupKey) throw Error('CANDIDATE_UNAVAILABLE');
    const previous = ids.get(record.tradeId) || setups.get(record.setupKey);
    if (previous) {
      if (canonical(previous) !== canonical(record)) throw Error('CANDIDATE_UNAVAILABLE');
      continue;
    }
    ids.set(record.tradeId, record); setups.set(record.setupKey, record); result.push(record);
  }
  return result;
}
export function diagnose(raw, validation = market.openTradesValidation) {
  if (typeof raw !== 'string') throw Error('INVALID');
  const parsed = parseStatus(raw, validation);
  let records, jsonValid = true;
  try { records = JSON.parse(raw); } catch { jsonValid = false; }
  const analyzable = jsonValid && Array.isArray(records);
  const js = jsonValid ? jsStatus(records, validation) : { status: 'REJECT', reason: 'INVALID_JSON' };
  const nonString = field => analyzable ? records.flatMap((record, index) =>
    typeof record?.[field] === 'string' ? [] : [{ index, type: type(record?.[field]) }]) : [];
  const missingIndexes = field => analyzable ? records.flatMap((record, index) => missing(record?.[field]) ? [index] : []) : [];
  const ids = nonString('tradeId'), setups = nonString('setupKey');
  const missingIds = missingIndexes('tradeId'), missingSetups = missingIndexes('setupKey');
  const idGroups = analyzable ? groups(records, 'tradeId') : [];
  const setupGroups = analyzable ? groups(records, 'setupKey') : [];
  const duplicates = [...idGroups, ...setupGroups];
  let candidate = false;
  if (analyzable && parsed.status !== 'EXECUTION_ERROR' && js.status !== 'EXECUTION_ERROR' &&
      !ids.length && !setups.length && !missingIds.length && !missingSetups.length && duplicates.length &&
      duplicates.every(group => group.allCanonicalEqual && !group.frozenDifferingFieldNames.length &&
        !group.mutableDifferingFieldNames.length && !group.unknownDifferingFieldNames.length)) {
    try {
      const hypothetical = buildHypothetical(records);
      candidate = parseStatus(JSON.stringify(hypothetical), validation).status === 'PASS' &&
        jsStatus(hypothetical, validation).status === 'PASS';
    } catch { candidate = false; }
  }
  return {
    rawSha256: sha(raw), rawByteLength: Buffer.byteLength(raw, 'utf8'), recordCount: analyzable ? records.length : null,
    nonStringTradeIdCount: analyzable ? ids.length : null, nonStringTradeIdEntries: ids,
    nonStringSetupKeyCount: analyzable ? setups.length : null, nonStringSetupKeyEntries: setups,
    missingTradeIdCount: analyzable ? missingIds.length : null, missingTradeIdIndexes: missingIds,
    missingSetupKeyCount: analyzable ? missingSetups.length : null, missingSetupKeyIndexes: missingSetups,
    duplicateTradeIdGroupCount: analyzable ? idGroups.length : null,
    duplicateSetupKeyGroupCount: analyzable ? setupGroups.length : null,
    duplicateTradeIdGroups: idGroups, duplicateSetupKeyGroups: setupGroups,
    parseOpenTradesStatus: parsed.status, parseOpenTradesReason: parsed.reason,
    jsValidatorStatus: js.status, jsValidatorReason: js.reason, automaticRepairCandidate: Boolean(candidate)
  };
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
    if (!object(data) || data.error || typeof data.result !== 'string') throw Error('UNAVAILABLE');
    return res.status(200).json(diagnose(data.result));
  } catch {
    return res.status(503).json({ error: 'DIAGNOSTIC_UNAVAILABLE' });
  }
}
