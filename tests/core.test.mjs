import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/storage/store.mjs';
import {
  normalizeProfile,
  profileProblems,
  parseWebUrl,
  entryRule,
  digest,
} from '../src/core/validation.mjs';
import { requestAllowed, installGuard, pageGuard, verifyGuard } from '../src/browser/guard.mjs';
import { Runner, DEMO_PROFILE } from '../src/core/runner.mjs';
import { chromium } from 'playwright';
import { ROOT } from '../src/server/config.mjs';

test('profile snapshots and revisions survive database restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'invoice-store-'));
  let store = new Store(dir);
  const profile = store.saveProfile({ ...DEMO_PROFILE, title: '初始抬头' });
  const task = store.createTask({ profile, mode: 'dry_run' }, randomUUID());
  const updated = store.saveProfile({ ...profile, title: '修改后抬头' }, profile.id);
  assert.equal(updated.revision, 2);
  assert.equal(store.get('tasks', task.id).profile.title, '初始抬头');
  assert.throws(() => store.saveProfile({ ...profile, title: '旧页面修改' }, profile.id), /已更新/);
  store.close();
  store = new Store(dir);
  assert.equal(store.get('profiles', profile.id).title, '修改后抬头');
  assert.equal(store.get('tasks', task.id).status, 'interrupted');
  store.close();
});
test('profile validation keeps enterprise and personal tax identifiers separate', () => {
  assert.equal(normalizeProfile({ ...DEMO_PROFILE, type: 'personal' }).taxId, '');
  assert.ok(profileProblems({ ...DEMO_PROFILE, taxId: '' }).some((x) => x.includes('税号')));
  assert.ok(profileProblems({ ...DEMO_PROFILE, email: 'bad' }).some((x) => x.includes('邮箱')));
});
test('editing a profile invalidates pending screenshot review', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'invoice-revision-'));
  const store = new Store(dir);
  try {
    const profile = store.saveProfile(DEMO_PROFILE);
    const task = store.createTask(
      { mode: 'dry_run', source: 'input', profileId: profile.id, profile },
      randomUUID(),
    );
    store.patchTask(task.id, { status: 'awaiting_review', reviewToken: 'old' });
    store.saveProfile({ ...profile, email: 'changed@example.invalid' }, profile.id);
    assert.equal(store.get('tasks', task.id).status, 'needs_changes');
    assert.equal(store.get('tasks', task.id).reviewToken, null);
  } finally {
    store.close();
  }
});
test('precise entry rules and unsafe URL rejection', () => {
  assert.equal(
    entryRule('https://open.weixin.qq.com/connect/oauth2/authorize?x=1').reasonCode,
    'wechat_oauth_required',
  );
  for (const url of [
    'https://open.weixin.qq.com.evil.example/connect/oauth2/authorize',
    'https://open.weixin.qq.com/connect/qrconnect',
    'https://open.weixin.qq.com:444/connect/oauth2/authorize',
  ])
    assert.equal(entryRule(url), null);
  assert.equal(
    entryRule('https://open.weixin.qq.com/connect/oauth2/authorize', { mainFrame: false }),
    null,
  );
  assert.equal(entryRule('https://www.kiwa-tech.com/scanIOrder123').source, 'user_confirmed');
  for (const url of [
    'file:///test',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://10.0.0.1',
    'http://[::ffff:127.0.0.1]/',
    'https://u:p@example.com',
  ])
    assert.throws(() => parseWebUrl(url));
  assert.equal(parseWebUrl('https://example.com/a').hostname, 'example.com');
  assert.notEqual(digest('https://example.com?a=1&b=2'), digest('https://example.com?b=2&a=1'));
});
test('guard permits reviewed reads and rejects invoice writes, even through GET', () => {
  const base = {
    url: 'https://cube-inv.jcsk100.com/api/cube-ar/openApi/saveBillingCode',
    method: 'POST',
    resourceType: 'fetch',
  };
  assert.equal(requestAllowed(base), false);
  assert.equal(requestAllowed({ ...base, method: 'GET' }), false);
  assert.equal(
    requestAllowed({
      ...base,
      url: 'https://cube-inv.jcsk100.com/api/cube-ar/openApi/getInvoiceHead',
      postData: JSON.stringify({ name: '完整名称' }),
    }),
    true,
  );
  assert.equal(
    requestAllowed({
      ...base,
      url: 'https://cube-inv.jcsk100.com/api/cube-ar/openApi/getInvoiceHead',
      postData: JSON.stringify({ name: '名称', submit: true }),
    }),
    false,
  );
  assert.equal(
    requestAllowed({
      ...base,
      url: 'https://cube-inv.jcsk100.com/api/cube-ar/arInvoicePre/billingCode',
      method: 'GET',
    }),
    true,
  );
  assert.equal(
    requestAllowed({ ...base, url: 'https://example.com/api/read', method: 'GET' }),
    false,
  );
});
test('browser guards stop submit button, Enter, native form submit and network writes', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const blocked = [];
    await installGuard(context, { demo: true, onBlocked: (x) => blocked.push(x) });
    const page = await context.newPage();
    await verifyGuard(page);
    assert.equal(blocked.length, 1);
    await page.setContent(
      '<form><input id="value"><button id="submit">提交开票</button></form><script>window.count=0;document.querySelector("form").onsubmit=e=>{e.preventDefault();window.count++};document.querySelector("button").onclick=()=>window.count++</script>',
    );
    await page.evaluate(pageGuard);
    await page.locator('#value').fill('测试资料');
    await page.locator('#submit').click();
    await page.locator('#value').press('Enter');
    assert.equal(await page.evaluate(() => window.count), 0);
    assert.equal(
      await page.evaluate(() => {
        try {
          document.querySelector('form').submit();
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
  } finally {
    await browser.close();
  }
});
test('review requires current token, screenshot and matching fields; never claims actual submission', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'invoice-review-'));
  const store = new Store(dir);
  const runner = new Runner(store, { root: ROOT, dataDir: dir });
  try {
    await assert.rejects(runner.create({ mode: 'execute' }, randomUUID()), /禁止真实提交/);
    const task = store.createTask(
      { mode: 'dry_run', source: 'demo', profile: DEMO_PROFILE },
      randomUUID(),
    );
    store.patchTask(task.id, {
      status: 'awaiting_review',
      reviewToken: 'token',
      fieldChecks: [{ matches: true }],
      artifacts: [{ name: 'pre-submit.png' }],
    });
    await assert.rejects(runner.review(task.id, { token: 'old', approved: true }), /失效/);
    await assert.rejects(runner.review(task.id, { token: 'token', approved: true }), /证据不完整/);
    await mkdir(path.join(dir, 'artifacts', task.id), { recursive: true });
    await writeFile(path.join(dir, 'artifacts', task.id, 'pre-submit.png'), 'test-evidence');
    const approved = await runner.review(task.id, { token: 'token', approved: true });
    assert.equal(approved.status, 'simulated_success');
    assert.equal(approved.actualSubmitted, false);
    assert.equal((await runner.review(task.id, { token: 'token', approved: true })).id, task.id);
  } finally {
    store.close();
  }
});
