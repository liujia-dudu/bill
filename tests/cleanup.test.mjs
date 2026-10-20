import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { outputKind, runCleanup } from '../tools/cleanup.mjs';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-20T12:00:00Z');

async function place(root, relative, ageDays, file = 'report.json') {
  const directory = path.join(root, relative);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, file), '{}');
  const at = new Date(now - ageDays * DAY);
  await utimes(path.join(directory, file), at, at);
  await utimes(directory, at, at);
}

test('output kinds group runs of the same check', () => {
  assert.equal(outputKind('chat-e2e-1792480299238'), 'chat-e2e');
  assert.equal(outputKind('browser-engine-Ab12cd'), 'browser-engine');
  assert.equal(outputKind('browser-engine-t5-1792148104709'), 'browser-engine-t5');
  assert.equal(outputKind('mzdp-update-20261016-152555'), 'mzdp-update');
  assert.equal(outputKind('design-review-20261016.json'), 'design-review');
});

test('cleanup keeps 3 per kind, 7 days, 3 database backups and protected data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 5; i++) await place(root, `test-results/chat-e2e-17924802992${i}0`, i);
  await place(root, 'test-results/harness-live-1792135123863', 9);
  for (let i = 0; i < 4; i++)
    await place(root, `diagnostics/update-17921441621${i}0`, 20 + i, 'invoice.sqlite');
  await place(root, 'diagnostics/review-20261019', 1);
  await place(root, 'diagnostics/review-20261001', 19);
  await place(root, 'diagnostics/publish-clean-20261019/node_modules/pkg', 1);
  await place(root, 'data/logs', 10, 'old.log');
  await place(root, 'data/logs', 1, 'new.log');
  await place(root, 'data/samples/t1', 30, 'input.png');
  await place(root, 'data', 30, 'invoice.sqlite');

  await runCleanup(root, { now });
  const kept = (relative) => existsSync(path.join(root, relative));
  for (let i = 0; i < 3; i++) assert.ok(kept(`test-results/chat-e2e-17924802992${i}0`));
  assert.ok(!kept('test-results/chat-e2e-1792480299230'));
  assert.ok(!kept('test-results/harness-live-1792135123863'));
  for (let i = 0; i < 3; i++) assert.ok(kept(`diagnostics/update-17921441621${i}0`));
  assert.ok(!kept('diagnostics/update-1792144162130'));
  assert.ok(kept('diagnostics/review-20261019'));
  assert.ok(!kept('diagnostics/review-20261001'));
  assert.ok(kept('diagnostics/publish-clean-20261019'));
  assert.ok(!kept('diagnostics/publish-clean-20261019/node_modules'));
  assert.ok(!kept('data/logs/old.log'));
  assert.ok(kept('data/logs/new.log'));
  assert.ok(kept('data/samples/t1/input.png'));
  assert.ok(kept('data/invoice.sqlite'));
  const log = await readFile(path.join(root, 'data/logs/cleanup.log'), 'utf8');
  assert.match(log, /removed diagnostics.publish-clean-20261019.node_modules/);
});
