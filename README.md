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

- A plan becomes active only after price enters its Entry Zone.
- TP1 reached before Stop Loss closes the plan as a win.
- Stop Loss reached first closes it as a loss.
- If both levels are touched inside the same one-minute candle, the conservative
  result is Stop Loss.
- Outcome evidence stores the OKX candle count plus observed Low and High.
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
errors. Keep Redis capacity and request-size limits under observation. Existing
trade outcome rules (including their candle-order limitations) are unchanged here.
