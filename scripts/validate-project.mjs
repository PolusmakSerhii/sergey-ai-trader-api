import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const apiDirectory = new URL("../api/", import.meta.url);
const scriptsDirectory = new URL("./", import.meta.url);
const apiFiles = (await readdir(apiDirectory))
  .filter((name) => name.endsWith(".js"))
  .sort();

assert.ok(apiFiles.length > 0, "At least one API handler is required");

for (const name of apiFiles) {
  const fileUrl = new URL(name, apiDirectory);
  const source = await readFile(fileUrl, "utf8");
  const syntaxCheck = spawnSync(process.execPath, ["--check", fileURLToPath(fileUrl)], {
    encoding: "utf8"
  });

  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr || `${name} has invalid syntax`);
  assert.match(source, /export\s+default/, `${name} must export a default handler`);
}

const marketSource = await readFile(
  new URL("../api/market.js", import.meta.url),
  "utf8"
);

assert.match(
  marketSource,
  /totalMatchedSymbols:\s*filteredScannerSymbols\.length/,
  "Scanner responses must expose the total matched symbol count"
);
assert.match(
  marketSource,
  /recommendationConfidence:\s*item\.recommendationConfidence\s*\?\?\s*0/,
  "Global ranking batches must preserve recommendation confidence"
);

const newsSource = await readFile(
  new URL("../api/news.js", import.meta.url),
  "utf8"
);

assert.match(newsSource, /NEWS_CACHE_TTL_SECONDS\s*=\s*10\s*\*\s*60/, "News cache must limit source requests");
assert.match(newsSource, /affectsTradingScore:\s*false/, "News must not change trading score before validation");
assert.match(newsSource, /sentiment:\s*"Neutral"/, "News failure must return a neutral fallback");
assert.match(newsSource, /marketMode:\s*"NormalTrading"/, "News failure must keep normal trading mode");
assert.match(newsSource, /articles:\s*strongArticles\.slice\(0,\s*8\)/, "News response must show only strong articles and events");
assert.match(newsSource, /plannedEventCount/, "News response must expose planned event count");

const scriptFiles = (await readdir(scriptsDirectory))
  .filter((name) => name.endsWith(".mjs"))
  .sort();

for (const name of scriptFiles) {
  const fileUrl = new URL(name, scriptsDirectory);
  const syntaxCheck = spawnSync(process.execPath, ["--check", fileURLToPath(fileUrl)], {
    encoding: "utf8"
  });

  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr || `${name} has invalid syntax`);
}

console.log(
  `Backend validation passed (${apiFiles.length} API handlers and ${scriptFiles.length} scripts checked).`
);
