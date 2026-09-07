import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BACKUP_KEYS, createRestoreCommands, RESTORE_SCRIPT } from "./redis-backup-format.mjs";

const confirmation = "--confirm=RESTORE";
const backupArgument = process.argv.slice(2).find(
  (argument) => !argument.startsWith("--")
);

if (!backupArgument || !process.argv.includes(confirmation)) {
  throw new Error(
    "Usage: npm run restore:redis -- <backup.json> --confirm=RESTORE"
  );
}

const redisUrl = String(
  process.env.UPSTASH_REDIS_REST_URL || ""
).replace(/\/$/, "");
const redisToken = String(
  process.env.UPSTASH_REDIS_REST_TOKEN || ""
);

if (!redisUrl || !redisToken) {
  throw new Error(
    "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required"
  );
}

const backup = JSON.parse(
  await readFile(resolve(backupArgument), "utf8")
);

const commands = createRestoreCommands(backup);

async function redis(command) {
  const response = await fetch(redisUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.error) {
    throw new Error(
      payload?.error || `Redis command failed: ${response.status}`
    );
  }

  return payload?.result ?? null;
}

await redis(["EVAL", RESTORE_SCRIPT, String(Object.keys(BACKUP_KEYS).length),
  ...Object.values(BACKUP_KEYS), JSON.stringify(commands)]);
console.log("Redis restore completed.");
console.log(`History entries: ${backup.history.length}`);
if (backup.version < 3) {
  console.log("Legacy backup: open trades reconstructed from the latest history snapshot.");
}
if (backup.version === 1) {
  console.log("Version 1 does not contain a completed ledger; existing completed data was preserved.");
}
