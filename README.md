# Crypto AI Trader PRO API

Production backend for the Crypto AI Trader PRO market scanner. It reads OKX
market data, calculates probability and opportunity metrics, builds the global
ranking, verifies trade outcomes with OKX one-minute candles, and persists the
ranking and cumulative result statistics in Upstash Redis.

## Production flow

1. QStash starts an authenticated global-ranking refresh every six minutes.
2. The API scans the currently available OKX USDT markets in small batches.
3. Successful batches are combined and sorted by Opportunity Score.
4. The complete ranking, history, active plans, and completed outcomes are
   stored in Redis.
5. Dashboard reads the cached ranking and statistics without starting another
   complete scan.

The production monitor runs hourly in GitHub Actions. It verifies freshness,
market count, zero failed results, cycle duration, and the presence of numeric
Recommendation Confidence for every ranked market.

## Important endpoints

- `/api/market?mode=scanner&page=1&limit=10` — paginated scanner data.
- `/api/market?mode=scanner&globalRank=true` — cached global ranking.
- `/api/market?mode=statistics` — rolling history and persistent trade stats.
- `/api/chat` — AI Dashboard assistant.

Refreshing the global ranking is protected and should be performed by QStash;
do not invoke a forced refresh from ordinary clients.

## Completed-trade rules

- A new plan starts its 60-minute monitoring window at the next minute boundary
  (or immediately when created exactly on the boundary). `createdAt` records
  creation; `plannedAt` records this effective start. Entry requires a confirmed
  OKX 1m candle touching the fixed Entry Zone after the monitoring start.
- Legacy plans: TP1 reached before Stop Loss closes the full position as a win.
- New versioned plans: TP1/TP2/TP3 close 25%/25%/50% of the initial position;
  after TP1 the remaining stop becomes the actual entry price.
- Initial Stop Loss reached before any target closes the position as a loss.
  After partial exits the sign of total realized R determines the final result.
- If both levels are touched inside the same one-minute candle, the conservative
  result is Stop Loss.
- Confirmed candles are evaluated in timestamp order. Outcome evidence stores
  the exact entry/exit candles, rule, minute precision, candle count and observed
  Low/High. Entry at a candle open inside the zone uses that open; otherwise it
  uses the approached zone boundary. This is analytic execution, not a real fill.
- Cumulative Win/Loss counters are deduplicated by trade ID and persist beyond
  the 24-hour ranking window.
- Detailed Completed Trades retain the latest 20 plans; aggregate statistics
  remain cumulative. IDs, details and aggregate statistics are committed together
  using a Redis compare-and-set Lua script. Concurrent updates retry; an uncertain
  response can be retried without counting the same trade twice.
- A+ statistics use the grade fixed when the plan enters its Entry Zone.

## Validation

```bash
npm test
```

This checks JavaScript syntax, API handler exports, critical scanner response
contracts, and ledger/backup behavior against an isolated Redis process. Install
`redis-server` and `redis-cli`, or set `REDIS_SERVER` and `REDIS_CLI` to their
executable paths. Tests use a private temporary Unix socket, disable TCP and
persistence, and never use production credentials. CI installs Redis and runs
the same command on every push to `main` and pull request.

## Required production configuration

Vercel and QStash hold the runtime configuration. At minimum, the deployment
requires Redis REST credentials, QStash verification/signing configuration,
and the AI provider credentials used by `/api/chat`. Keep all values in the
hosting provider's encrypted environment settings; never commit them.

## Redis backup

The backup contains the current global ranking, the rolling ranking history,
persistent completed-trade statistics, the latest 20 completed trades, and the
trade IDs used to prevent duplicate results. Backup files are written with
owner-only permissions, refuse to overwrite an existing file, and the `backups/`
directory is excluded from Git.
Persistent statistics include overall results and a separate A+ result summary
based on the opportunity grade fixed when the trade enters its Entry Zone.

Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, then run:

```bash
npm run backup:redis
```

An explicit destination can be supplied after `--`:

```bash
npm run backup:redis -- /safe/path/sergey-ai-backup.json
```

Do not commit backup files or Redis credentials.

## Redis restore

Restore replaces the current ranking cache, ranking history, and (for version 2
backups) the persistent completed-trade data. Version 3 also restores open plans;
versions 1/2 reconstruct them only from the latest history snapshot, replacing
any unrelated open plans. Version 1 preserves existing completed-trade data
because that format does not contain a ledger. Validate that this legacy ledger
belongs to the restored history before using a version 1 backup. All inputs are
validated before one Redis script applies the restore without interleaving other
commands. Create a fresh backup first, pause
the QStash ranking schedule, and only then run:

```bash
npm run restore:redis -- /safe/path/sergey-ai-backup.json --confirm=RESTORE
```

After restoration, resume QStash and verify `/api/market?mode=statistics` and the
global ranking before relying on Dashboard data.

## Production checklist

- Global ranking is fresh and contains the full market set.
- `resultsFailed` is zero and `resultsCollected` equals
  `totalAvailableSymbols`.
- Every ranking entry has numeric `recommendationConfidence`.
- QStash cycles finish before the next six-minute schedule.
- Dashboard shows Online, the expected page count, and cumulative trade stats.
- GitHub validation and production-monitor workflows are green.

## Ledger compatibility and recovery

`mode=statistics` only reads persistent data. It does not initialize a ledger or
rebuild cumulative results from the latest 20 records. An existing aggregate is
preserved with its existing scope; absent/older scopes are reported as
`Legacy (unverified)` instead of being relabeled as Confirmed A+. New empty
ledgers use `confirmed-a-plus-v1`. Missing aggregates use the existing rolling
history fallback without writing to Redis.

If IDs exist but aggregate statistics are missing or malformed, new completed
results fail closed and the history/open-plan checkpoint does not advance.
Restore a consistent backup or perform a separately reviewed recovery; do not
clear IDs or infer cumulative totals from the last 20 records. The ranking cache
can still refresh independently, so inspect the refresh response's `history.status`
and backend errors when validating persistence. No automatic recovery or historical
result recalculation is performed by this change.

The atomic scripts prevent command interleaving and precheck expected data types;
they do not provide rollback for Redis infrastructure failures such as out-of-memory
errors. Keep Redis capacity and request-size limits under observation. Trade outcome rules are documented below; changes are versioned per outcome.

## Closed-candle lifecycle (closed-candles-v2)

`createRankingHistoryEntry` preserves the original plan, ID, direction and
confirmed-setup metadata while waiting and after activation. Ranking changes
cannot substitute a new plan. Legacy snapshots retain TP1-as-full-exit semantics.
For those legacy plans, no partial exits, break-even management, score weights or A+ gates
are changed in this phase. Closed historical records are not recalculated.

`evaluateTradeLifecycle` processes only contiguous, valid, confirmed 1m candles.
TP1 before SL in different candles is a win; SL first is a loss. Both levels in
one eligible candle use the documented conservative SL-first policy, including
an entry candle. A unique level touched on the opening side of an entry candle
may precede the entry; if the close does not resolve that ordering, the trade stays
Active with a null result and `ambiguous_entry_candle` verification. The minute
open/close timestamps are evidence boundaries, not tick-accurate fill times.

Existing active entry prices/times are preserved, not retrospectively reverified;
an absent `entryCheck` identifies legacy entry evidence. Legacy plans/checkpoints
that fall inside a minute retain their existing times.
A possible entry/exit in that boundary candle remains unverified instead of being
assigned to the wrong side of the boundary. A candle straddling expiry is treated
the same way. These cases require finer-grained evidence or a separately approved
resolution policy; repeatedly retrieving the same OHLC cannot remove intrinsic
intraminute ambiguity. No arbitrary automatic expiry closes unresolved entries.

`outcome.priceCheck.status` distinguishes `verified`, `awaiting_closed_candle`,
`unavailable`, `incomplete_candles`, `invalid_plan`, `ambiguous_start_candle`,
`ambiguous_expiry_candle`, `ambiguous_checkpoint_candle`, and
`ambiguous_entry_candle`. These are verification details, not new trade states.
The existing frontend can still consume the API; dedicated verification notices
in the UI remain a separate frontend change.

`lastPriceCheckedAt` is the first unprocessed minute boundary. It never advances
past a missing or ambiguous candle. `verificationBoundaryAt` retains a legacy
partial-minute boundary across retries. A new `entryCheck`/`exitCheck` carries the
supporting candle, and `lifecycleVersion` identifies the new rule set. `checkedAt`
is the closing boundary of the exit candle; `priceCheck.verifiedAt` is when the
analysis ran. EXPIRED requires verified coverage through the full entry window
without entry and remains excluded from Win/Loss statistics.

The fetcher uses OKX `history-candles`, accepts only `confirm=1` records, uses `after`/`before` pagination
and a single 8-second request budget. Each check processes at most the oldest
300 unchecked minutes in three requests; a larger outage catches up over later
cycles rather than skipping to recent candles. Gaps/timeouts retain the checkpoint
and never fall back to a current ticker price. This does not introduce additional
requests for all scanner rows, only for existing tracked plans.

Local behavioral tests include direction symmetry, chronological exits, entry
candles, missing/unconfirmed data, expiry, boundary ambiguity, frozen plans,
pagination and end-to-end persistence through the existing statistics API.
Aggregates still retain their existing scope: historical results from old rules
and newly versioned results are not retroactively converted or reclassified.

OKX reference: https://app.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks-history

### Source resilience and caching

CoinGlass responses use a 60-second cache; Fear & Greed uses 300 seconds.
Only successful responses are stored in memory on the running Vercel instance.
Source caching performs no Redis GET/SET commands and uses no shared persistent cache.
Identical concurrent requests on the same instance share one request; returned values
are independent copies. Expired values and source errors are never used as a fallback.
A cold start or another instance fetches independently, so savings apply only to repeated
requests during the TTL on the same warm instance. The cache is not on the user's laptop
unless the backend itself is running locally. Previous `sergey-ai:source-cache:v1:*` keys,
if any were deployed, are no longer accessed and expire via their existing TTLs.

Redis remains responsible for ranking snapshots/history, trades/statistics and refresh
coordination. Removing source-cache commands does not guarantee the entire project fits
Upstash's free allowance; existing Redis usage and refresh traffic still count.

External market requests have an 8-second timeout per request, Redis requests 5 seconds,
scanner analysis calls 45 seconds, and ranking batch calls 60 seconds. Lifecycle candle
requests retain their existing 8-second total budget and do not use this cache.
Fear & Greed failure returns `{ value: null, classification: "N/A" }` without aborting
technical analysis. Indicator formulas, grading and Trade Plan rules are unchanged.

A ranking refresh containing failed symbols, malformed batches or no results returns
502 before writing ranking cache or history, preserving the previous successful snapshot.
Trade checks resume at the next successful refresh; this change does not provide a
separate trade-monitor job.

OKX SWAP instruments use a 300-second cache, all SWAP tickers 15 seconds, and daily
candles 60 seconds. Daily cache keys include symbol, instrument type, interval and
requested limit. Intraday chart candles and lifecycle minute candles bypass this cache.
The shared process cache is capped at 128 entries to bound retained candle histories.
Source freshness is limited by these TTLs; scoring formulas themselves are unchanged.

Public Global Ranking reads only the last stored snapshot. A missing/unavailable cache
returns 503 and never starts a full scan. Initial population and subsequent refreshes
require the existing authenticated QStash `refresh=true` request. Existing frontend error
handling retains already displayed ranking data on failure; a first load without a cached
snapshot cannot show ranking until an authorized refresh succeeds.

Refreshes acquire `sergey-ai:ranking-refresh-lock:v1` with SET NX EX and a unique token.
The 15-minute lease is renewed before batches and persistence, subject to a 10-minute
scan budget checked at those boundaries (an in-flight batch may finish after that budget).
Redis checks ownership atomically with each snapshot, ledger and checkpoint command.
Ledger Lua scripts include the same guard directly because Redis cannot nest EVAL.
A stale owner cannot write or delete another owner's lease. Normal completion/failure
releases the owned lease; process termination or an uncertain acquisition response relies
on expiry. Busy/unavailable locks, lost ownership and persistence failure return 503 so
scheduler retries remain possible. Cache/history/ledger remain separate writes, not one
transaction; a failure can occur after a snapshot was stored. Existing ledger deduplication
makes completed-trade retries safe. Refresh lock keys are not included in backups.

`tests/source-resilience.test.mjs` covers coalescing, cache expiry and isolation,
zero Redis access for source caches, cold starts, bounded retention, source failures and
ranking persistence guards without live API calls.

### Observational liquidation flow

`derivativesHistory.liquidations.flow` adds diagnostics to the existing CoinGlass
`All` exchange aggregate for 24 hours, with no additional source or Redis requests.
It exposes LONG/SHORT USD amounts, each side's percentage of their sum, and signed
imbalance: `(longUsd - shortUsd) / (longUsd + shortUsd) * 100`. Positive imbalance
means larger LONG liquidations; it is not a price forecast. The original reported
total is retained separately, with its difference from the side sum exposed.

Only finite nonnegative numeric source amounts are accepted. Missing amounts remain
null rather than zero. With two valid zeros, activity is zero and shares/imbalance
are null; dominantSide is N/A. Spikes and price confirmation explicitly remain
unavailable because aligned historical liquidation data is not collected.
`affectsTradingScore` is false: existing scoring, grades, Trade Plan generation and
all earlier derivatives fields retain their behavior. This stage exposes the API
fields only; a frontend display and historical flow collection are separate steps.

### Aligned Open Interest and price context

`derivativesHistory.openInterest.priceContext` compares the latest closed OKX SPOT
1D candle with six CoinGlass aggregated 4H OI intervals covering exactly its opening
time through opening time + 24 hours. It reuses existing responses; no new source or
Redis calls are added. The API returns the actual window boundaries, start/end values,
percentage changes and price/OI directions. This is a closed daily window, not a rolling
24h ticker change and not an intraday signal. Incomplete, duplicate, invalid or misaligned
history returns N/A. A window ending at least 24 hours ago is considered stale.

OI is denominated in USD by the existing CoinGlass endpoint and includes valuation
effects from price changes. Aggregate OI across exchanges combined with OKX spot price
cannot prove that new longs/shorts were opened or identify the cause of position closures.
The context exposes this limitation and `affectsTradingScore: false`. Existing OI
assessment/scoring behavior is unchanged; the previously identified scoring input issue
requires a separately validated scoring change. Frontend rendering remains a later step.

Source contracts:
- https://docs.coinglass.com/reference/oi-ohlc-aggregated-history
- https://app.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks-history

### Result classification and break-even accounting

For newly recorded completed trades (TP1Hit/TP3Hit/Stopped lifecycle statuses),
finite numeric `resultR` determines Win (>0), Loss (<0) or BreakEven (exactly 0).
The exit status describes the event, not the sign of the financial result. Missing,
string or nonfinite R is rejected; Expired and Active do not enter completed totals.
Persistent and rolling summaries expose `breakEvens`; break-even ends a loss streak
and contributes zero to Total R. Win Rate remains wins / all completed trades,
including break-even and excluding expired-before-entry plans.

Existing stored totals are not reclassified. `resultClassificationSince` identifies
the first newly recorded result under these rules; the persistent break-even counter
covers records added from that point only. The API returns null for that counter on
older aggregates before any new classified record has been added. Full historical
reconciliation requires a complete ledger, not the latest 20 detail rows.
Legacy lifecycle plans keep the original frozen stop and TP1 full exit.
New versioned partial plans use the policy below; frontend labels distinguish event and R result.


### Versioned partial exits: 25/25/50 and TP1 → break-even

Only newly created tracked snapshots receive `initialPlan.exitStrategy` from
`createPartialExitStrategy()`: version `partial-25-25-50-be-v1`, fractions TP1=0.25,
TP2=0.25, TP3=0.50, allocationBasis=`initial-position`, afterTP1=`actual-entry`,
afterTP2=`unchanged`. Existing waiting, active and closed snapshots are not upgraded.
The evaluator reads the snapshot's policy, never current defaults. Scoring, entry
filters and target generation are unchanged.

`initialPlan.initialStopLoss` and the compatibility `initialPlan.stopLoss` stay fixed.
`outcome.initialStopLoss` stays fixed too; `outcome.currentStopLoss` becomes actual
entry on TP1, equally for LONG and SHORT. TP2 does not trail or move it further.
TP1 and TP2 keep status Active. TP3 fully closes as TP3Hit; stop exits use Stopped.
Completed accounting occurs once only after the remaining position is closed.

Position size is normalized to 1 initial position, not an invented currency or
exchange quantity. `remainingPosition` is the remaining fraction. `exits` stores
each target/STOP, original-position fraction, execution level, weighted realized R,
time and candle evidence. The original risk denominator is abs(actualEntry-initialSL).
Realized R is the sum of fraction * signed(exit-entry) / original risk. For levels
at +1R/+2R/+3R, all targets return +2.25R; TP1 then entry stop returns +0.25R.
This retains the existing analytical level-touch execution model, without fees,
slippage or actual exchange orders; it is not broker fill accounting.

Unrealized R uses the latest fully verified candle close and remaining fraction;
`markPriceAt` identifies its timestamp. Total R is realized plus unrealized. Missing
or ambiguous current verification returns null unrealized/total R, retaining known
realized exits. Full closure has zero unrealized R and resultR equal to realized R.

The existing entry, gap, expiry and legacy candle handling is retained. For partial
plans, targets already reached at an active position's candle open are processed
before a later stop. Otherwise the existing conservative SL-first rule applies when
an already effective stop and a target share a candle. A newly moved entry stop
must not be applied retroactively to the candle's earlier low/high. When TP1 is
confirmed but the ordering of the new stop and later targets cannot be determined,
the evaluator stores that 25% exit, marks `ambiguous_management_candle`, and retains
the checkpoint and last confirmed remainder. Replays cannot duplicate the exit or
pretend that the uncertainty is resolved. More granular evidence/manual resolution
is required; this stage does not add a new paid data source or automated resolver.

The existing Redis keys, lease fencing, idempotent ledger and v3 backup format are
retained. Backup/restore tests preserve a partially closed plan and its current stop.
Frontend renders initial/current SL, the current SL marker, three fixed targets,
snapshot fractions, remaining position and realized/unrealized/total R. Legacy
cards keep their existing presentation. No new endpoints or polling jobs are added;
longer-lived active trades can require more existing candle checks after TP1.
