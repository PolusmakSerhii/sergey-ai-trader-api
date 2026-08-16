# sergey-ai-trader-api

API for Sergey AI Trader Pro.

## Validation

```bash
npm test
```

## Redis backup

The backup contains the current global ranking and the complete ranking history
used for statistics and completed trades. Backup files are written with owner-only
permissions and the `backups/` directory is excluded from Git.

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

Restore replaces the current ranking cache and ranking history. Create a fresh
backup first, pause the QStash ranking schedule, and only then run:

```bash
npm run restore:redis -- /safe/path/sergey-ai-backup.json --confirm=RESTORE
```

After restoration, resume QStash and verify `/api/market?mode=statistics` and the
global ranking before relying on Dashboard data.
