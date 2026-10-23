import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/server/config.mjs';
import { InvoiceBrowserTools } from '../src/agent/browser-tools.mjs';
import { RuleRegistry, recordKey } from '../src/rules/registry.mjs';
import { executeRule } from '../src/rules/executor.mjs';
import { buildPending, PENDING_FILE } from '../src/rules/candidate.mjs';
import { pageContract } from '../src/rules/contract.mjs';
import { validateVariant, profileFields } from '../src/rules/schema.mjs';
import { observePage } from '../src/browser/observe.mjs';
import { installGuard, pageGuard } from '../src/browser/guard.mjs';
import { Store } from '../src/storage/store.mjs';
import { Runner } from '../src/core/runner.mjs';

const host = 'invoice.example.invalid';
const profile = {
  type: 'enterprise',
  title: 'Synthetic Company',
  taxId: '91310000MA0000000Y',
  email: 'test@example.invalid',
};
const personal = { type: 'personal', title: '个人', email: profile.email };
const html = `<section><h2>购买方信息</h2>
<div class="field"><label for="name">单位名称 *</label><input id="name" required></div>
<div class="field"><label for="tax">税号 *</label><input id="tax" required></div>
<div class="field"><label for="mail">邮箱 *</label><input id="mail" required></div>
<button type="button" id="submit">提交开票</button>
</section><script>window.submissionCount=0;document.querySelector('#submit').onclick=()=>window.submissionCount++;</script>`;

async function workspace() {
  await mkdir(path.join(ROOT, 'test-results'), { recursive: true });
  const directory = await mkdtemp(path.join(ROOT, 'test-results', 'rules-'));
  return { directory, registry: new RuleRegistry(path.join(directory, 'rules')) };
}
const observation = {
  url: `https://${host}/invoice?order=synthetic`,
  frames: [
    {
      title: 'Invoice',
      controls: [
        { tag: 'input', type: 'text', label: '名称', visible: true, enabled: true, required: true },
      ],
    },
  ],
};
function pendingFor(signature, overrides = {}) {
  return {
    key: recordKey(observation.url),
    buyerType: 'enterprise',
    engine: 'normal',
    profileFields: profileFields(profile),
    steps: [{ action: 'finish', contract: signature }],
    sourceTaskId: 'synthetic',
    ...overrides,
  };
}
async function browserFixture(directory, content = html) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await installGuard(context, { demo: true });
  const page = await context.newPage();
  // Synthetic HTTPS origin, with no requests to an actual invoice site.
  await page.route(`https://${host}/**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: content }),
  );
  await page.goto(`https://${host}/invoice?order=synthetic`);
  await page.evaluate(pageGuard);
  const tools = new InvoiceBrowserTools({ page, profile: { ...profile }, directory, demo: true });
  return { browser, page, tools };
}
async function explore(tools) {
  for (const [id, valueRef] of [
    ['name', 'title'],
    ['tax', 'taxId'],
    ['mail', 'email'],
  ]) {
    const observed = await tools.observe();
    const control = observed.frames
      .flatMap((frame) => frame.controls)
      .find((c) => c.stableId === id);
    await tools.dispatch('invoice_fill', { elementRef: control.elementRef, valueRef });
  }
  await tools.dispatch('invoice_finish', {});
}
function pendingOf(tools, page, initialProfile = profile) {
  return buildPending({ tools, taskId: 'synthetic', initialUrl: page.url(), initialProfile });
}
async function replayRoute(registry, page, replayProfile = profile) {
  await page.reload();
  await page.evaluate(pageGuard);
  const route = await registry.select(await observePage(page), replayProfile);
  assert.equal(route.source, 'adapter');
  return route;
}

test('records match by host + path and buyer type, ignoring order parameters', async () => {
  const { registry } = await workspace();
  assert.equal((await registry.select(observation, profile)).reason, 'new_page');
  await registry.learn(pendingFor(pageContract(observation, profile)), 'trusted');
  const route = await registry.select(observation, profile);
  assert.equal(route.source, 'adapter');
  assert.equal(route.learned.level, 'trusted');
  const newOrder = { ...observation, url: observation.url.replace('synthetic', 'another') };
  assert.equal((await registry.select(newOrder, profile)).source, 'adapter');
  for (const url of [`https://${host}.evil.invalid/invoice`, `https://${host}/other`])
    assert.equal((await registry.select({ ...observation, url }, profile)).reason, 'new_page');
  // Same page under another engine, profile scope or layout: the steps only guide the model.
  const changed = structuredClone(observation);
  changed.frames[0].controls.push({ tag: 'input', required: true });
  for (const [current, currentProfile, engine] of [
    [observation, profile, 'light'],
    [observation, { ...profile, phone: '13800000000' }, 'normal'],
    [changed, profile, 'normal'],
  ]) {
    const hinted = await registry.select(current, currentProfile, engine);
    assert.equal(hinted.source, 'agent');
    assert.equal(hinted.reason, 'record_not_matched');
    assert.equal(hinted.hint.at(-1).action, 'finish');
  }
  // Buyer types learn separately.
  assert.equal((await registry.select(observation, personal)).reason, 'new_page');
  await registry.learn(
    pendingFor(pageContract(observation, personal), {
      buyerType: 'personal',
      profileFields: profileFields(personal),
    }),
    'hint',
  );
  assert.equal((await registry.select(observation, personal)).reason, 'hint_record');
  assert.equal((await registry.select(observation, profile)).source, 'adapter');
  await writeFile(registry.file(recordKey(observation.url)), '{broken');
  assert.equal((await registry.select(observation, profile)).reason, 'invalid_rule');
});

test('a hint never downgrades a trusted record, and discard only drops the matching revision', async () => {
  const { registry } = await workspace();
  const signature = pageContract(observation, profile);
  const key = recordKey(observation.url);
  const trusted = await registry.learn(pendingFor(signature), 'trusted');
  assert.equal(await registry.learn(pendingFor(signature), 'hint'), null);
  assert.equal((await registry.select(observation, profile)).learned.revision, trusted);
  assert.equal(await registry.discard(key, 'enterprise', ['c'.repeat(64)]), false);
  assert.equal((await registry.select(observation, profile)).source, 'adapter');
  await registry.learn(
    pendingFor(signature, { buyerType: 'personal', profileFields: profileFields(personal) }),
    'hint',
  );
  assert.equal(await registry.discard(key, 'enterprise', [trusted]), true);
  assert.equal((await registry.select(observation, profile)).reason, 'new_page');
  assert.equal((await registry.select(observation, personal)).reason, 'hint_record');
  await registry.learn(pendingFor(signature), 'hint');
  await registry.learn(pendingFor(signature), 'trusted');
  assert.equal((await registry.select(observation, profile)).source, 'adapter');
});

test('schema excludes executable code, arbitrary values and all submission actions', () => {
  const variant = {
    level: 'trusted',
    engine: 'normal',
    profileFields: profileFields(profile),
    steps: [{ action: 'finish', contract: 'a'.repeat(64) }],
    sourceTaskId: 'synthetic',
    learnedAt: '2026-10-23T00:00:00Z',
  };
  assert.equal(validateVariant(variant), variant);
  for (const action of ['submit', 'click', 'evaluate', 'fetch', 'agree']) {
    const unsafe = structuredClone(variant);
    unsafe.steps.unshift({ action, contract: 'a'.repeat(64) });
    assert.throws(() => validateVariant(unsafe), { code: 'invalid_rule' });
  }
  const script = structuredClone(variant);
  script.script = 'dangerous()';
  assert.throws(() => validateVariant(script), { code: 'invalid_rule' });
  const value = structuredClone(variant);
  value.steps.unshift({
    action: 'fill',
    target: { frameIndex: 0, identity: { tag: 'input' } },
    valueRef: 'password',
    contract: 'a'.repeat(64),
  });
  assert.throws(() => validateVariant(value), { code: 'invalid_rule' });
});

test('a completed fill is replayed for a new order and profile without the model or submission', async () => {
  const { directory, registry } = await workspace();
  const { browser, page, tools } = await browserFixture(directory);
  try {
    await explore(tools);
    const pending = pendingOf(tools, page);
    assert.equal(pending.steps.at(-1).action, 'finish');
    assert.ok(!JSON.stringify(pending).includes(profile.email));
    assert.ok(!JSON.stringify(pending).includes(profile.title));
    await registry.learn(pending, 'trusted');
    const nextProfile = {
      ...profile,
      title: 'Another Synthetic Company',
      email: 'another@example.invalid',
    };
    await page.goto(`https://${host}/invoice?order=another`);
    const route = await replayRoute(registry, page, nextProfile);
    const replay = path.join(directory, 'replay');
    await mkdir(replay);
    const result = await executeRule({
      route,
      taskId: 'replay',
      page,
      profile: nextProfile,
      directory: replay,
      demo: true,
    });
    assert.equal(result.modelCalls, 0);
    assert.ok(result.checks.every((check) => check.matches));
    assert.equal(await page.locator('#mail').inputValue(), nextProfile.email);
    assert.equal(await page.evaluate(() => window.submissionCount), 0);
    assert.ok((await readFile(path.join(replay, 'pre-submit.png'))).length);
    const snapshot = JSON.parse(await readFile(path.join(replay, 'rule-snapshot.json'), 'utf8'));
    assert.equal(snapshot.revision, result.learnedFrom.revision);
    // The replay leaves its own pending steps for the user's next decision.
    const again = JSON.parse(await readFile(path.join(replay, PENDING_FILE), 'utf8'));
    assert.ok(!JSON.stringify(again).includes(nextProfile.email));
    assert.equal(again.steps.length, pending.steps.length);
  } finally {
    await browser.close();
  }
});

test('Runner learns hints on abandon or expiry, trusted on approval, and forgets on correction', async () => {
  const { directory } = await workspace();
  const store = new Store(directory);
  const runner = new Runner(store, { root: ROOT, dataDir: directory });
  try {
    const signature = pageContract(observation, profile);
    const prepare = async () => {
      const task = store.createTask(
        { source: 'input', mode: 'dry_run', url: observation.url, profile },
        randomUUID(),
      );
      const dir = path.join(directory, 'artifacts', task.id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, PENDING_FILE),
        JSON.stringify(pendingFor(signature, { sourceTaskId: task.id })),
      );
      store.patchTask(task.id, { status: 'awaiting_review' });
      runner.live.set(task.id, { handle: { close: async () => ({ status: 'closed' }) } });
      return task;
    };
    const settle = () => Promise.allSettled([...runner.learning]);
    const abandoned = await prepare();
    runner.abandon(abandoned.id);
    await settle();
    assert.equal((await runner.rules.select(observation, profile)).reason, 'hint_record');
    assert.equal(store.require('tasks', abandoned.id).learned.level, 'hint');
    const approved = await prepare();
    assert.equal(runner.approve(approved.id).status, 'approved_unsubmitted');
    await settle();
    const route = await runner.rules.select(observation, profile);
    assert.equal(route.source, 'adapter');
    // A later task replayed the trusted record and the user said it was wrong.
    const replayed = store.createTask(
      { source: 'input', mode: 'dry_run', url: observation.url, profile },
      randomUUID(),
    );
    store.patchTask(replayed.id, { learnedFrom: route.learned });
    await runner.forget(replayed.id);
    assert.equal((await runner.rules.select(observation, profile)).reason, 'new_page');
    // Correcting an expired task drops the hint it left behind.
    const expired = await prepare();
    await runner.expire(expired.id);
    await settle();
    assert.equal((await runner.rules.select(observation, profile)).reason, 'hint_record');
    await runner.forget(expired.id);
    assert.equal((await runner.rules.select(observation, profile)).reason, 'new_page');
  } finally {
    await runner.close();
    store.close();
  }
});

test('framework ids that change on every load do not stop a replay', async () => {
  const { directory, registry } = await workspace();
  // Element Plus style: el-id-<random per load>-<index>.
  const content = `<label for="a">公司名称</label><input id="a" required>
<label for="b">税号</label><input id="b" required>
<label for="c">收票邮箱</label><input id="c" required>
<button type="button" id="submit">提交开票</button>
<script>const n=Math.floor(Math.random()*9000)+1000;
document.querySelectorAll('input').forEach((el,i)=>{const id='el-id-'+n+'-'+(i+1);document.querySelector('label[for='+el.id+']').htmlFor=id;el.id=id;});
window.submissionCount=0;document.querySelector('#submit').onclick=()=>window.submissionCount++;</script>`;
  const { browser, page, tools } = await browserFixture(directory, content);
  const scoped = { ...profile };
  try {
    for (const [label, valueRef] of [
      ['公司名称', 'title'],
      ['税号', 'taxId'],
      ['收票邮箱', 'email'],
    ]) {
      const observed = await tools.observe();
      const control = observed.frames
        .flatMap((frame) => frame.controls)
        .find((c) => c.label === label);
      await tools.dispatch('invoice_fill', { elementRef: control.elementRef, valueRef });
    }
    await tools.dispatch('invoice_finish', {});
    const pending = pendingOf(tools, page, scoped);
    assert.ok(!JSON.stringify(pending).includes('el-id-'));
    await registry.learn(pending, 'trusted');
    const before = await page.locator('input').first().getAttribute('id');
    const route = await replayRoute(registry, page, scoped);
    assert.notEqual(await page.locator('input').first().getAttribute('id'), before);
    const result = await executeRule({
      route,
      page,
      profile: { ...scoped },
      directory,
      demo: true,
    });
    assert.equal(result.modelCalls, 0);
    assert.ok(result.checks.every((check) => check.matches));
    assert.equal(await page.evaluate(() => window.submissionCount), 0);
  } finally {
    await browser.close();
  }
});

test('incomplete exploration leaves nothing to learn, and mismatched replay fills nothing', async () => {
  const { directory, registry } = await workspace();
  const { browser, page, tools } = await browserFixture(directory);
  try {
    assert.equal(pendingOf(tools, page), null);
    await explore(tools);
    await registry.learn(pendingOf(tools, page), 'trusted');
    const route = await replayRoute(registry, page);
    await page.locator('#tax').evaluate((node) => node.setAttribute('aria-required', 'false'));
    await page.locator('label[for=tax]').evaluate((node) => {
      node.textContent = '新的必填字段';
    });
    await assert.rejects(
      executeRule({ route, page, profile: { ...profile }, directory, demo: true }),
      { code: 'rule_mismatch' },
    );
    assert.equal(await page.locator('#name').inputValue(), '');
  } finally {
    await browser.close();
  }
});

test('generic company lookup replay verifies page tax and keeps missing-tax profile scope', async () => {
  const { directory, registry } = await workspace();
  const content = await readFile(
    new URL('./fixtures/pages/invoice-company-demo.html', import.meta.url),
    'utf8',
  );
  const { browser, page, tools } = await browserFixture(directory, content);
  const initialProfile = { ...profile, title: '青禾合成科技有限公司', taxId: '' };
  tools.profile = { ...initialProfile };
  const act = async (name, predicate, args = {}) => {
    const observed = await tools.observe();
    const control = observed.frames.flatMap((frame) => frame.controls).find(predicate);
    await tools.dispatch(name, { elementRef: control.elementRef, ...args });
  };
  try {
    await act('invoice_open_choices', (c) => c.stableId === 'buyer');
    await act('invoice_fill', (c) => c.stableId === 'buyer', { valueRef: 'title' });
    await act('invoice_choose_company', (c) => c.role === 'option');
    await act('invoice_read_tax', (c) => c.stableId === 'credit');
    await act('invoice_fill', (c) => c.stableId === 'email', { valueRef: 'email' });
    await tools.dispatch('invoice_finish', {});
    const pending = pendingOf(tools, page, initialProfile);
    assert.ok(!pending.profileFields.includes('taxId'));
    assert.ok(!JSON.stringify(pending).includes(initialProfile.title));
    assert.ok(!JSON.stringify(pending).includes(profile.taxId));
    await registry.learn(pending, 'trusted');
    let evidence;
    const replayProfile = { ...initialProfile };
    const route = await replayRoute(registry, page, replayProfile);
    const result = await executeRule({
      route,
      page,
      profile: replayProfile,
      directory,
      demo: true,
      onTaxVerified: async (value) => {
        evidence = value;
        return { taxId: value.taxId };
      },
    });
    assert.equal(evidence.taxId, profile.taxId);
    assert.equal(result.checks.find((check) => check.key === 'taxId').source, 'invoice_page');
    assert.equal(await page.evaluate(() => window.submissionCount), 0);
  } finally {
    await browser.close();
  }
});

test('generic native selection and multi-step replay preserve per-step screenshots', async () => {
  const { directory, registry } = await workspace();
  const content = await readFile(
    new URL('./fixtures/pages/invoice-agent-demo.html', import.meta.url),
    'utf8',
  );
  const { browser, page, tools } = await browserFixture(directory, content);
  const act = async (name, predicate, args = {}) => {
    const observed = await tools.observe();
    const control = observed.frames.flatMap((frame) => frame.controls).find(predicate);
    await tools.dispatch(name, { elementRef: control.elementRef, ...args });
  };
  try {
    await act('invoice_select', (c) => c.type === 'radio' && c.label === '企业', {
      option: 'company',
    });
    await act('invoice_fill', (c) => c.stableId === 'buyer', { valueRef: 'title' });
    await act('invoice_fill', (c) => c.stableId === 'credit', { valueRef: 'taxId' });
    await act('invoice_continue', (c) => c.stableId === 'next');
    await act('invoice_fill', (c) => c.stableId === 'delivery', { valueRef: 'email' });
    await tools.dispatch('invoice_finish', {});
    const pending = pendingOf(tools, page);
    assert.ok(pending.steps.some((step) => step.action === 'continue' && step.target));
    await registry.learn(pending, 'trusted');
    const route = await replayRoute(registry, page);
    const result = await executeRule({
      route,
      page,
      profile: { ...profile },
      directory,
      demo: true,
    });
    assert.ok(result.checks.every((check) => check.matches));
    assert.ok((await readFile(path.join(directory, 'step-0.png'))).length);
    assert.ok((await readFile(path.join(directory, 'pre-submit.png'))).length);
    assert.equal(await page.evaluate(() => window.submissionCount), 0);
  } finally {
    await browser.close();
  }
});

test('mid-flow mismatch preserves verified progress for Harness handoff', async () => {
  const { directory, registry } = await workspace();
  const { browser, page, tools } = await browserFixture(directory);
  try {
    await explore(tools);
    const pending = pendingOf(tools, page);
    pending.steps[1].contract = 'b'.repeat(64);
    pending.steps[1].waitMs = 0;
    await registry.learn(pending, 'trusted');
    const route = await replayRoute(registry, page);
    let handoff;
    await assert.rejects(
      executeRule({ route, page, profile: { ...profile }, directory, demo: true }),
      (error) => {
        handoff = error.preparationTools;
        return error.code === 'rule_mismatch';
      },
    );
    assert.equal(handoff.checks.length, 1);
    assert.equal(handoff.checks[0].key, 'title');
    assert.equal(handoff.preparationSteps.length, 1);
    for (const [id, valueRef] of [
      ['tax', 'taxId'],
      ['mail', 'email'],
    ]) {
      const observed = await handoff.observe();
      const ref = observed.frames.flatMap((frame) => frame.controls).find((c) => c.stableId === id);
      await handoff.dispatch('invoice_fill', { elementRef: ref.elementRef, valueRef });
    }
    await handoff.dispatch('invoice_finish', {});
    assert.ok(handoff.result().checks.every((check) => check.matches));
    assert.equal(await page.evaluate(() => window.submissionCount), 0);
  } finally {
    await browser.close();
  }
});

test('screenshot failure leaves nothing to learn', async () => {
  const { directory } = await workspace();
  const { browser, page, tools } = await browserFixture(directory);
  try {
    for (const [id, valueRef] of [
      ['name', 'title'],
      ['tax', 'taxId'],
      ['mail', 'email'],
    ]) {
      const observed = await tools.observe();
      const ref = observed.frames.flatMap((frame) => frame.controls).find((c) => c.stableId === id);
      await tools.dispatch('invoice_fill', { elementRef: ref.elementRef, valueRef });
    }
    tools.capture = async () => {
      throw new Error('Synthetic screenshot failure');
    };
    await assert.rejects(tools.dispatch('invoice_finish', {}), /screenshot failure/);
    assert.equal(tools.finished, false);
    assert.equal(pendingOf(tools, page), null);
  } finally {
    await browser.close();
  }
});

test('the process only mentions agreements a page actually has', async (t) => {
  const { directory } = await workspace();
  const agreement =
    '<label><input type="checkbox" id="agree"> 我已阅读并同意<a href="#terms">《用户授权协议》</a></label>';
  let content = html.replace('<button', `${agreement}<button`);
  const browser = await chromium.launch({ headless: true });
  const open = async (_engine, { onSession = () => {} } = {}) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route(`https://${host}/**`, (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: content }),
    );
    onSession(null);
    return { page, context, close: async () => (await context.close(), { status: 'closed' }) };
  };
  const store = new Store(directory);
  const runner = new Runner(store, { root: ROOT, dataDir: directory, openBrowser: open });
  t.after(async () => {
    await runner.close();
    store.close();
    await browser.close();
  });
  const saved = store.saveProfile({ ...profile });
  const run = async () => {
    // Learn the current page by tool exploration, then let Runner replay it.
    const { browser: learner, page, tools } = await browserFixture(directory, content);
    await explore(tools);
    await runner.rules.learn(pendingOf(tools, page), 'trusted');
    await learner.close();
    const task = store.createTask(
      {
        source: 'input',
        mode: 'dry_run',
        engine: 'normal',
        engineRequested: 'normal',
        url: `https://${host}/invoice?order=synthetic`,
        profile: saved,
        profileId: saved.id,
      },
      randomUUID(),
    );
    await runner.execute(task);
    await runner.release(task.id);
    const result = store.require('tasks', task.id);
    assert.equal(result.status, 'awaiting_review', result.message);
    assert.equal(result.executionSource, 'adapter');
    return result.events.map((event) => event.message).filter((m) => m.includes('勾选'));
  };
  assert.deepEqual(await run(), ['已勾选《用户授权协议》']);
  content = html;
  assert.deepEqual(await run(), []);
});
