import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAS_SCRIPT } from '../api/open-trades-repair.js';

test('exact repair Lua CAS on isolated Unix Redis', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'repair-cas-test-'));
  const socket = join(dir, 'redis.sock');
  const exec = promisify(execFile);
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket,
    '--unixsocketperm', '700', '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: 'ignore' });
  let startupError;
  server.on('error', error => { startupError = error; });
  const redis = async command => {
    const { stdout } = await exec('redis-cli', ['-s', socket, '--json', ...command.map(String)]);
    if (stdout.startsWith('error:')) throw Error('TEST_REDIS_ERROR');
    return command[0] === 'INFO' ? stdout : JSON.parse(stdout);
  };
  const prefix = `test-only:${randomUUID()}`;
  const key = `${prefix}:target`, sentinel = `${prefix}:sentinel`;
  const expectedRaw = ' [ {"test":"expected — значение"} ]\n';
  const replacementRaw = '[{"test":"replacement"}]\n';
  const originalRaw = ' {"test":"different source"}\n';
  const sentinelRaw = 'sentinel bytes\n';
  let ready = false;
  const snapshot = async () => {
    const keys = (await redis(['KEYS', '*'])).sort();
    return Promise.all(keys.map(async k => [k, await redis(['DUMP', k]), await redis(['PTTL', k])]));
  };
  const setCalls = async () => {
    const info = await redis(['INFO', 'commandstats']);
    return Number(info.match(/(?:^|\r?\n)cmdstat_set:calls=(\d+)/)?.[1] || 0);
  };
  const runCAS = async expected => {
    const command = ['EVAL', CAS_SCRIPT, '1', key, expected, replacementRaw];
    assert.deepEqual(command.slice(3, 3 + Number(command[2])), [key]);
    // Independent check of the imported script's key references, not a copied Lua implementation.
    assert.deepEqual([...new Set([...CAS_SCRIPT.matchAll(/KEYS\[(\d+)\]/g)].map(m => m[1]))], ['1']);
    return redis(command);
  };
  try {
    for (let i = 0; i < 100; i++) {
      if (startupError) throw startupError;
      try { await redis(['PING']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.ok(ready, 'Isolated Redis did not start');
    assert.equal(await redis(['DBSIZE']), 0);
    await redis(['SET', key, originalRaw]);
    await redis(['SET', sentinel, sentinelRaw]);
    await t.test('mismatch: zero SET calls and byte-identical entire database', async () => {
      const before = await snapshot(), writes = await setCalls();
      assert.equal(await runCAS(expectedRaw), 0);
      assert.equal(await redis(['GET', key]), originalRaw);
      assert.equal(await redis(['GET', sentinel]), sentinelRaw);
      assert.deepEqual(await snapshot(), before);
      assert.equal(await setCalls(), writes);
    });
    await t.test('success: exactly one SET, target replacement only, sentinel unchanged', async () => {
      await redis(['SET', key, expectedRaw]);
      const before = await snapshot(), writes = await setCalls();
      assert.equal(await runCAS(expectedRaw), 1);
      assert.equal(await redis(['GET', key]), replacementRaw);
      assert.equal(await redis(['GET', sentinel]), sentinelRaw);
      const after = await snapshot();
      assert.deepEqual(after.map(row => row[0]), before.map(row => row[0]));
      assert.deepEqual(after.filter(row => row[0] !== key), before.filter(row => row[0] !== key));
      assert.equal(await redis(['PTTL', key]), -1);
      assert.equal(await setCalls() - writes, 1);
      assert.equal(await redis(['DBSIZE']), 2);
    });
  } finally {
    try {
      if (ready) {
        await redis(['DEL', key, sentinel]); // Only keys created by this test.
        assert.equal(await redis(['DBSIZE']), 0);
      }
    } finally {
      server.kill();
      if (server.exitCode === null && server.signalCode === null && !startupError) {
        await new Promise(resolve => server.once('exit', resolve));
      }
      await rm(dir, { recursive: true, force: true });
    }
  }
});
