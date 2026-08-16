import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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

if (
  backup?.format !== "sergey-ai-redis-backup" ||
  backup?.version !== 1 ||
  typeof backup?.keys?.ranking !== "string" ||
  typeof backup?.keys?.history !== "string" ||
  !backup?.ranking ||
  !Array.isArray(backup?.history)
) {
  throw new Error("Backup file has an unsupported or invalid format");
}

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

await redis([
  "SET",
  backup.keys.ranking,
  JSON.stringify(backup.ranking)
]);
await redis(["DEL", backup.keys.history]);

for (let start = 0; start < backup.history.length; start += 50) {
  const chunk = backup.history.slice(start, start + 50);

  if (chunk.length) {
    await redis([
      "RPUSH",
      backup.keys.history,
      ...chunk.map((entry) => JSON.stringify(entry))
    ]);
  }
}

console.log("Redis restore completed.");
console.log(`History entries: ${backup.history.length}`);
