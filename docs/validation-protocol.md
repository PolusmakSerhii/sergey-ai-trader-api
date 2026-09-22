# Canonical A+ forward validation v1

This archive observes the existing modelled trading lifecycle. It does not place orders,
create signals, change plans or calculate a second P&L.

## Sample boundary

`sergey-ai:validation-archive:v1` initializes `validationStartAt` once, on the first
successful archive write. The first writer supplies its collection timestamp. A frozen
`initialPlan.createdAt` at/after this boundary belongs to `forward`; older or missing
origin belongs to `legacy`. In particular the trade triggering initialization may be
legacy. No existing statistics start date guarantees full evidence collection, so the
statistics baseline is not reused. Deployments never move this boundary. Do not delete
the key to reset a sample. Unknown/unverified legacy records are not invented.

## Collection and recovery

After a successful open-trades/history CAS, one recent-completed LRANGE and one batched
archive EVAL run, independently of Entry Observations. Successful live registration
(or finding its existing open setup) runs one archive EVAL. Failed CAS attempts do not
archive. Lua atomically merges by canonical tradeId, preserves origin/frozen plan,
rejects backwards progress and makes terminal records immutable. No per-symbol writes.
Failures emit `[validation-archive] storage_error` without payloads/secrets and do not
fail canonical persistence. Subsequent cycles retry open/history signals and recent20
completions. Outages exceeding those canonical evidence windows cannot be fully repaired.
Archive completeness must therefore be audited, not assumed from a successful GET.

## Retention / access

Frozen plans and outcomes are stored as lossless JSON strings internally and returned
as objects by the read API, preserving empty arrays and original price precision
through Redis Lua cjson. No TTL or eviction. Maximum 5000 records and 16 MiB of actual serialized Redis document.
Exceeding either rejects the entire batch before SET; existing records stay intact.
Monitor failure logs and export before bounds are reached. These limits are not the
recent20 UI limit. No automatic backup integration is included; existing Redis backup
scripts do not include this new key. Export the read endpoint separately for off-Redis
retention. Redis loss without such an export loses the archive.

Read-only `GET /api/market?mode=validation-archive&offset=0&limit=100` returns a stable
tradeId-sorted page, boundary, forward and legacy summaries. Paginate until nextOffset
is null; updates can occur between pages, so retain tradeId and updatedAt and repeat
exports when a frozen research sample is needed. GET never initializes or repairs state.
Summary reuses the canonical statistics reducer on archived final outcomes ordered by
checkedAt then tradeId; it is not a new persisted ledger. Expired without execution is
excluded from completed results. Profit factor is null when gross loss is zero; empty
expectancy is null. Legacy and forward metrics remain separate.

## Validation protocol

1. Record the boundary and rules revision before interpreting the cohort.
2. Keep all forward records, including waiting, active and expired; do not cherry-pick.
3. Review at 50 and 100+ completed trades, reporting total cohort and unresolved trades.
4. Check evidence completeness, archive errors, candle gaps/ambiguity, and canonical
   ledger totals for the same trade IDs. Do not substitute all-time totals for a cohort.
5. Report wins/losses/BE, net R, expectancy, profit factor, drawdown, chronological
   streaks, Long/Short and TP analytics from final canonical results.
6. Keep frozen original plans separate from actual/model entry and later stop/exit
   evidence. Missing recommendation confidence/instrument type stays null.
7. Results are modelled candle outcomes, not verified exchange fills; fees, funding,
   slippage and account position sizing are not added by this archive. Do not claim
   profitability or change thresholds from a small or incomplete sample.

Entry Observation History remains a separate research store and is never an execution
input. No recovery/continuation/improved-entry classifications are introduced.
