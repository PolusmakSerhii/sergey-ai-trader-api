import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const apiDirectory = new URL("../api/", import.meta.url);
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

console.log(`Backend validation passed (${apiFiles.length} API handlers checked).`);
