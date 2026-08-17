# Sergey AI Trader PRO API

Production backend for the Sergey AI Trader PRO market scanner. It reads OKX
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
  remain cumulative.
- A+ statistics use the grade fixed when the plan enters its Entry Zone.

## Validation

```bash
npm test
```

This checks JavaScript syntax, API handler exports, and critical scanner response
contracts. CI runs the same command on every push to `main` and pull request.

## Required production configuration

Vercel and QStash hold the runtime configuration. At minimum, the deployment
requires Redis REST credentials, QStash verification/signing configuration,
and the AI provider credentials used by `/api/chat`. Keep all values in the
hosting provider's encrypted environment settings; never commit them.

## Redis backup

The backup contains the current global ranking, the rolling ranking history,
persistent completed-trade statistics, the latest 20 completed trades, and the
trade IDs used to prevent duplicate results. Backup files are written with
owner-only permissions and the `backups/` directory is excluded from Git.
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
backups) the persistent completed-trade data. Create a fresh backup first, pause
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
