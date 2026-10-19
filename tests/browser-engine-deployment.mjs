// Local deployment audit only; no messages, tasks or invoice requests are created.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from '../src/server/config.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const base = 'http://127.0.0.1:3180';
const directory = path.join(ROOT, 'diagnostics', 'browser-engine-deployment-20261016');
await mkdir(directory, { recursive: true });
async function snapshot() {
  const get = async (endpoint) => {
    const response = await fetch(base + endpoint);
    assert.equal(response.status, 200);
    return response.json();
  };
  const health = await get('/api/health');
  assert.equal(health.submissionEnabled, false);
  const profiles = await get('/api/profiles');
  const tasks = await get('/api/tasks');
  const conversations = await get('/api/conversations');
  assert.ok(tasks.every((task) => !['queued', 'running'].includes(task.status)));
  assert.ok(conversations.every((item) => item.status !== 'running'));
  const details = [];
  for (const conversation of conversations)
    details.push(await get(`/api/conversations/${conversation.id}`));
  return { profiles, tasks, conversations, details };
}
if (process.argv.includes('--before')) {
  const state = await snapshot();
  await writeFile(path.join(directory, 'before.json'), JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ backupDirectory: directory, idle: true }));
} else {
  const before = JSON.parse(await readFile(path.join(directory, 'before.json'), 'utf8'));
  const after = await snapshot();
  const databaseIndex = process.argv.indexOf('--baseline-db');
  const baselinePath = databaseIndex >= 0 ? path.resolve(process.argv[databaseIndex + 1]) : null;
  if (baselinePath) {
    // A user may delete a conversation while the build runs. Compare against
    // the database backed up immediately before the restart, not older API state.
    const baseline = new DatabaseSync(baselinePath, { readOnly: true });
    const current = new DatabaseSync(path.join(ROOT, 'data/invoice.sqlite'), { readOnly: true });
    try {
      for (const table of [
        'profiles',
        'inputs',
        'tasks',
        'conversations',
        'messages',
        'memories',
        'tool_actions',
        'settings',
      ])
        assert.deepEqual(
          current.prepare(`SELECT id,document FROM ${table} ORDER BY id`).all(),
          baseline.prepare(`SELECT id,document FROM ${table} ORDER BY id`).all(),
          `${table} changed during restart`,
        );
      assert.deepEqual(after.profiles, before.profiles);
    } finally {
      current.close();
      baseline.close();
    }
  } else assert.deepEqual(after, before);
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.url().startsWith(base + '/api/') && response.status() >= 400)
        errors.push(`API ${response.status()}`);
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(directory, 'desktop.png'), fullPage: true });
    assert.equal(await page.title(), '秒开票');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(directory, 'mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    const report = {
      passed: true,
      profiles: after.profiles.length,
      tasks: after.tasks.length,
      conversations: after.conversations.length,
      stateUnchanged: true,
      baseline: baselinePath || 'before.json',
      startedAt: new Date().toISOString(),
      actualSubmitted: false,
      errors,
    };
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
  }
}
