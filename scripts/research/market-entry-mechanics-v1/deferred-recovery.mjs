import {readFile, open, lstat, realpath} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {windows, pages, validate, sha} from './build-development-dataset.mjs';

const amendment = {
  commit: '525daf337bbf995af5eade0db7be3723049038a5',
  md: 'b5a0cebdd43629f8c65f6d133709bcb298d320b2a2f34ad9d9bc42dcd8b0446f',
  json: '9beeb1fd94329e76eb31123f6577bf38abee882056b405d2e680522e39d4270a'
};
const root = fileURLToPath(new URL('../../../', import.meta.url));
const ensure = (yes, message) => { if (!yes) throw Error(message); };
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function read(path) {
  ensure(!(await lstat(path)).isSymbolicLink(), 'SYMLINK_FORBIDDEN');
  return readFile(path, 'utf8');
}
// O_EXCL is the cross-process claim. A partial/empty file still consumes the label.
async function exclusive(path, value) {
  const handle = await open(path, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}
export async function verifyRecoveryIdentity() {
  for (const ext of ['md', 'json']) ensure(sha(await readFile(join(root, `docs/research/market-entry-mechanics-v1.0-amendment-2.${ext}`))) === amendment[ext], 'AMENDMENT_IDENTITY');
  const config = JSON.parse(await readFile(join(root, 'docs/research/market-entry-mechanics-v1.0-amendment-2.json'), 'utf8'));
  for (const [name, hash] of Object.entries(config.frozenHashes)) ensure(sha(await readFile(join(root, 'docs/research', name))) === hash, 'FROZEN_IDENTITY');
  ensure(sha(await readFile(join(root, 'scripts/research/market-entry-mechanics-v1/engine.mjs'))) === config.engineSha256, 'ENGINE_IDENTITY');
}
const transportMessages = new Set(['fetch failed', 'The operation was aborted due to timeout']);
const errorInfo = e => ({name: e?.name ?? 'Error', message: String(e?.message ?? e), cause: e?.cause ? {name: e.cause.name ?? null, message: String(e.cause.message ?? e.cause), code: e.cause.code ?? null} : null});

// One fetch, redirects forbidden, no retries. HTTP/body progress survives read failure.
export async function singleRequest(url, progress) {
  const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(30000)});
  progress.httpStatus = response.status;
  const text = await response.text();
  progress.responseBodyObtained = true;
  return {status: response.status, text};
}
export async function recover(options, {request = singleRequest, now = Date.now} = {}) {
  ensure(Object.keys(options).every(k => ['rawDir', 'requestId', 'attempt', 'preOutcome', 'noKnownDefect'].includes(k)), 'IDENTITY_OVERRIDE_FORBIDDEN');
  const {rawDir, requestId, attempt} = options;
  ensure(options.preOutcome === true && options.noKnownDefect === true, 'ELIGIBILITY_ATTESTATION_REQUIRED');
  ensure(/^R[123]$/.test(attempt), 'RECOVERY_LABEL');
  await verifyRecoveryIdentity();
  // Only an exact page from the frozen Development schedule can be selected.
  const w = windows().flatMap(pages).find(x => `${x.instrument}_${x.bar}_${x.lo}_${x.hi}` === requestId);
  ensure(w, 'NOT_REQUIRED_DEVELOPMENT_PAGE');
  const dir = await realpath(rawDir);
  const base = join(dir, requestId), originalPath = base + '.attempts.json';
  const originalBytes = await read(originalPath), original = JSON.parse(originalBytes);
  const url = new URL('https://www.okx.com/api/v5/market/history-candles');
  url.search = new URLSearchParams({instId: w.instrument, bar: w.bar, limit: '300', after: String(w.hi + 1), before: String(w.lo - 1)});
  ensure(Array.isArray(original) && original.length === 3, 'ORIGINAL_ALLOWANCE_NOT_EXHAUSTED');
  ensure(original.every((r, i) => r.attempt === i + 1 && r.status === 'FAIL' && r.url === url.href && transportMessages.has(r.error) && !('http' in r) && !('recordHashes' in r) && !r.conflict && !r.payload && !r.responseBodyObtained), 'ORIGINAL_NOT_TRANSPORT_ONLY_OR_IDENTITY_MISMATCH');
  ensure(!await exists(base + '.json'), 'CACHE_ALREADY_EXISTS');
  const identity = {requestId, window: w, url: url.href, originalLedgerSha256: sha(originalBytes), amendment};
  const started = now(); ensure(Number.isFinite(started), 'CLOCK_INVALID');
  const index = Number(attempt[1]);
  for (let i = 1; i <= 3; i++) {
    const claimPath = `${base}.recovery-R${i}.claim.json`, resultPath = `${base}.recovery-R${i}.result.json`;
    if (i >= index) {
      ensure(!await exists(claimPath) && !await exists(resultPath), 'ATTEMPT_ALREADY_CONSUMED_OR_OUT_OF_ORDER');
    } else {
      ensure(await exists(claimPath) && await exists(resultPath), 'PREDECESSOR_INCOMPLETE');
      const claim = JSON.parse(await read(claimPath)), result = JSON.parse(await read(resultPath));
      ensure(JSON.stringify(claim.identity) === JSON.stringify(identity) && claim.attempt === `R${i}`, 'RECOVERY_IDENTITY_MISMATCH');
      ensure(result.claimSha256 === sha(await read(claimPath)) && result.classification === 'TRANSPORT_FAILURE', 'RECOVERY_TERMINATED');
      const end = Date.parse(result.endedAt), start = Date.parse(claim.startedAt);
      ensure(Number.isFinite(end) && Number.isFinite(start) && end >= start && started - end >= 60000, 'COMPLETION_UNKNOWN_OR_DELAY');
    }
  }
  const claimPath = `${base}.recovery-${attempt}.claim.json`, resultPath = `${base}.recovery-${attempt}.result.json`;
  await exclusive(claimPath, {state: 'CLAIMED', identity, attempt, startedAt: new Date(started).toISOString(), preOutcome: true, noKnownDefect: true});
  // Never catch local persistence errors as transport failures: leave consumed claim.
  const claimSha256 = sha(await read(claimPath));
  const progress = {httpStatus: null, responseBodyObtained: false, cacheWritten: false};
  let response, failure, classification, providerCode = null, providerMessage = null, validation = null;
  try { response = await request(url.href, progress); }
  catch (e) {
    failure = errorInfo(e);
    // Unknown exceptions leave the claim consumed; they cannot authorize R2.
    if (!['TimeoutError', 'AbortError'].includes(e?.name) && !transportMessages.has(e?.message)) throw e;
    classification = progress.responseBodyObtained ? 'SUBSTANTIVE_DATA_FAILURE' : 'TRANSPORT_FAILURE';
  }
  let payload, checked;
  if (response) {
    progress.httpStatus = response.status; progress.responseBodyObtained = true;
    try {
      ensure(response.status === 200, 'HTTP_' + response.status);
      payload = JSON.parse(response.text); providerCode = payload.code ?? null; providerMessage = payload.msg ?? null;
      checked = validate(payload, w);
      validation = {count: checked.rows.length, firstOpen: checked.rows[0].openTime, lastOpen: checked.rows.at(-1).openTime, lastClose: checked.rows.at(-1).closeTime, continuity: 'PASS', confirmation: 'PASS', OHLC: 'PASS', duplicates: 0, conflicts: 0};
      classification = 'SUCCESS';
    } catch (e) { classification = 'SUBSTANTIVE_DATA_FAILURE'; failure = errorInfo(e); }
  }
  ensure(classification, 'TRANSPORT_RESULT_INVALID');
  if (classification === 'SUCCESS') {
    await exclusive(base + '.json', {window: w, request: {attempt, url: url.href, claimSha256, status: 'PASS'}, rawText: checked.clipped ? null : response.text, payload: {code: '0', data: checked.source}, filtered: checked.clipped > 0});
    progress.cacheWritten = true;
  }
  const ended = now(); ensure(Number.isFinite(ended) && ended >= started, 'CLOCK_INVALID');
  const result = {attempt, claimSha256, classification, startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: ended - started, ...progress, providerCode, providerMessage, error: failure ?? null, validation, responseRecordCount: Array.isArray(payload?.data) ? payload.data.length : null, responseSha256: response ? sha(response.text) : null,
    // Preserve substantive evidence only inside the authorized page; never retain incidental Holdout rows.
    dataEvidence: classification === 'SUBSTANTIVE_DATA_FAILURE' && Array.isArray(payload?.data) ? payload.data.filter(a => Array.isArray(a) && Number(a[0]) >= w.lo && Number(a[0]) <= w.hi) : null};
  await exclusive(resultPath, result);
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, rawDir, requestId, attempt, attestation] = process.argv.slice(2);
  if (process.argv.length !== 7 || mode !== '--deferred-recovery' || attestation !== '--pre-outcome-no-known-defect') throw Error('Usage: deferred-recovery.mjs --deferred-recovery RAW_DIR REQUEST_ID R1|R2|R3 --pre-outcome-no-known-defect');
  recover({rawDir, requestId, attempt, preOutcome: true, noKnownDefect: true}).then(x => console.log(JSON.stringify(x))).catch(e => {console.error(e.message); process.exitCode = 1;});
}
