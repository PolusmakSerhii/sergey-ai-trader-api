// Aggregate-only operational diagnostics. Never includes source payloads.
export function storageHealth(metrics, blocked = false) {
  const names = ['cycles','observations','payloadBytes','serializedBytes'];
  if (!metrics || names.some(k => !Number.isSafeInteger(metrics[k]) || metrics[k] < 0))
    return {status: blocked ? 'BLOCKED' : 'UNKNOWN', envelopeAppendGuaranteed:false};
  const safe = Object.fromEntries(names.map(k => [k, metrics[k]]));
  const utilization = {cycles:safe.cycles/10000, observations:safe.observations/50000,
    payload:safe.payloadBytes/6291456, serialized:safe.serializedBytes/8388608};
  utilization.max = Math.max(...Object.values(utilization));
  return {status:blocked ? 'BLOCKED' : utilization.max >= .85 ? 'CRITICAL' : utilization.max >= .70 ? 'WARNING' : 'OK',
    ...safe,utilization,envelopeAppendGuaranteed:false};
}
export function reportStorageHealth(callback, metrics) {
  // Diagnostics must never alter Forward control flow.
  try { callback?.(metrics); } catch {}
}
export function logStorageHealth(storage) {
  try {
    const level=storage.status==='OK'?'log':storage.status==='CRITICAL'||storage.status==='BLOCKED'?'error':'warn';
    console[level]('[forward-f2-storage]', JSON.stringify(storage));
  } catch {}
}
