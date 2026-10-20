import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from '../src/server/config.mjs';
import { Store } from '../src/storage/store.mjs';
import { Runner } from '../src/core/runner.mjs';
import { SYNTHETIC_PROFILE as DEMO_PROFILE } from './fixtures/profile.mjs';
import { AppError } from '../src/core/validation.mjs';
import {
  prepareInvoiceBrowser,
  pageAbnormality,
  engineRecheckReason,
} from '../src/browser/preflight.mjs';

const url = 'https://invoice.example.invalid/invoice?order=synthetic';
const form = `<h2>购买方信息</h2><label for="name">单位名称</label><input id="name">
  <button type="button" id="submit">提交开票</button>
  <script>window.submissionCount=0;window.fieldWrites=0;
  document.querySelector('#submit').onclick=()=>window.submissionCount++;
  document.querySelector('#name').oninput=()=>window.fieldWrites++;</script>`;
const errorPage = '<h1>Oops! Something went wrong:(</h1>';

async function fixture(
  pages,
  { cleanup = 'closed', failNormal = false, screenshotFails = false } = {},
) {
  await mkdir(path.join(ROOT, 'test-results'), { recursive: true });
  const directory = await mkdtemp(path.join(ROOT, 'test-results', 'browser-engine-'));
  const browser = await chromium.launch({ headless: true });
  const opened = [];
  const order = [];
  const open = async (engine, { onSession }) => {
    order.push(`open:${engine}`);
    if (engine === 'normal' && failNormal) throw new Error('Synthetic normal connect failure');
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://invoice.example.invalid/**', (route) => {
      const content = pages[engine];
      return route.fulfill({
        status: content?.status || 200,
        contentType: 'text/html; charset=utf-8',
        body: typeof content === 'string' ? content : content?.body || '',
      });
    });
    const wait = page.waitForTimeout.bind(page);
    page.waitForTimeout = (ms) => wait(ms === 2200 ? 0 : ms);
    if (screenshotFails)
      page.screenshot = async () => {
        throw new Error('Synthetic screenshot failure');
      };
    onSession(`synthetic-${engine}`);
    let closing;
    const handle = {
      page,
      context,
      sessionId: `synthetic-${engine}`,
      close: () =>
        (closing ||= (async () => {
          order.push(`close:${engine}`);
          await context.close();
          return { status: engine === 'light' ? cleanup : 'closed' };
        })()),
    };
    opened.push(handle);
    return handle;
  };
  return { directory, browser, opened, order, open };
}

test('generic errors request recheck without guessing causes or field mappings', () => {
  const observation = (text, controls = []) => ({
    frames: [{ innerText: text, contentText: '', controls }],
  });
  assert.equal(pageAbnormality(observation(errorPage)).reasonCode, 'page_error');
  assert.equal(
    pageAbnormality(
      observation('Oops! Something went wrong:(', [
        { tag: 'button', visible: true, enabled: true, editable: true },
      ]),
    ).reasonCode,
    'page_error',
  );
  assert.equal(pageAbnormality(observation('')).reasonCode, 'blank_page');
  assert.equal(
    pageAbnormality(
      observation('Oops! Something went wrong:(', [
        { tag: 'input', visible: true, enabled: true, editable: true },
      ]),
    ),
    null,
  );
  for (const reasonCode of ['expired', 'invalid_invoice_amount', 'cancelled', 'private_url'])
    assert.equal(engineRecheckReason({ status: 'failed', reasonCode }), null);
  assert.equal(
    engineRecheckReason({ status: 'unsupported_browser', reasonCode: 'known_client_entry' }),
    null,
  );
});

test('light error is closed before one guarded normal recheck; no fields are written', async () => {
  const env = await fixture({ light: errorPage, normal: form });
  const blocked = [];
  const artifacts = [];
  let prepared;
  try {
    prepared = await prepareInvoiceBrowser({
      engine: 'light',
      url,
      directory: env.directory,
      open: env.open,
      onBlocked: (record) => blocked.push(record),
      onArtifact: (record) => artifacts.push(record),
    });
    assert.deepEqual(env.order, ['open:light', 'close:light', 'open:normal']);
    assert.equal(prepared.engine, 'normal');
    assert.equal(prepared.state, null);
    assert.equal(await prepared.handle.page.locator('#name').inputValue(), '');
    assert.equal(await prepared.handle.page.evaluate(() => window.fieldWrites), 0);
    await prepared.handle.page.locator('#submit').click();
    await prepared.handle.page.locator('#name').press('Enter');
    assert.equal(await prepared.handle.page.evaluate(() => window.submissionCount), 0);
    // Only the guard self-check probe is refused; page requests are not filtered.
    assert.deepEqual(
      blocked.map((record) => record.path),
      ['/api/__invoice_guard_probe__', '/api/__invoice_guard_probe__'],
    );
    const evidence = JSON.parse(
      await readFile(path.join(env.directory, 'engine-check.json'), 'utf8'),
    );
    assert.equal(evidence.attempts.length, 2);
    assert.equal(evidence.fallback.result, 'normal_page_ready');
    assert.equal(evidence.fallback.compatibilitySuspected, true);
    assert.equal(evidence.fallback.compatibilityConfirmed, false);
    assert.deepEqual(
      artifacts.map((artifact) => artifact.name),
      ['engine-check-light.png', 'engine-check-normal.png'],
    );
  } finally {
    prepared?.orderRead.close();
    await prepared?.handle.close();
    await env.browser.close();
  }
});

test('both engines failing stops, and normal alone never retries', async () => {
  for (const engine of ['light', 'normal']) {
    const env = await fixture({ light: errorPage, normal: errorPage });
    let prepared;
    try {
      prepared = await prepareInvoiceBrowser({
        engine,
        url,
        directory: env.directory,
        open: env.open,
      });
      assert.equal(prepared.state.reasonCode, 'page_error');
      assert.equal(env.opened.length, engine === 'light' ? 2 : 1);
      const evidence = JSON.parse(
        await readFile(path.join(env.directory, 'engine-check.json'), 'utf8'),
      );
      if (engine === 'light') {
        assert.equal(evidence.fallback.result, 'normal_page_abnormal');
        assert.equal(evidence.fallback.compatibilitySuspected, false);
      }
    } finally {
      prepared?.orderRead.close();
      await prepared?.handle.close();
      await env.browser.close();
    }
  }
});

test('healthy light and issued/expired terminal pages do not open another engine', async () => {
  for (const content of [form, '<p>发票已开具</p>', '<p>链接失效</p>']) {
    const env = await fixture({ light: content, normal: form });
    let prepared;
    try {
      prepared = await prepareInvoiceBrowser({
        engine: 'light',
        url,
        directory: env.directory,
        open: env.open,
      });
      assert.equal(prepared.engine, 'light');
      assert.equal(env.opened.length, 1);
    } finally {
      prepared?.orderRead.close();
      await prepared?.handle.close();
      await env.browser.close();
    }
  }
});

test('HTTP errors and blank pages recheck once, but screenshot failures are not success evidence', async () => {
  for (const light of ['', { status: 503, body: 'Unavailable' }]) {
    const env = await fixture({ light, normal: form }, { screenshotFails: true });
    let prepared;
    try {
      prepared = await prepareInvoiceBrowser({
        engine: 'light',
        url,
        directory: env.directory,
        open: env.open,
      });
      assert.equal(prepared.engine, 'normal');
      assert.equal(prepared.state, null);
      const evidence = JSON.parse(
        await readFile(path.join(env.directory, 'engine-check.json'), 'utf8'),
      );
      assert.ok(
        evidence.attempts.every((attempt) => attempt.screenshotError && !attempt.screenshot),
      );
      assert.equal(evidence.actualSubmitted, false);
    } finally {
      prepared?.orderRead.close();
      await prepared?.handle.close();
      await env.browser.close();
    }
  }
});

test('client-required pages recheck; exact OAuth navigation stays blocked in both engines', async () => {
  for (const light of [
    '<p>请在微信客户端打开链接</p>',
    '<script>location.href="https://open.weixin.qq.com/connect/oauth2/authorize?synthetic=1"</script>',
  ]) {
    const env = await fixture({ light, normal: light });
    let prepared;
    try {
      prepared = await prepareInvoiceBrowser({
        engine: 'light',
        url,
        directory: env.directory,
        open: env.open,
      });
      assert.equal(prepared.engine, 'normal');
      assert.equal(prepared.state.status, 'unsupported_browser');
      assert.equal(env.opened.length, 2);
      if (light.includes('location.href'))
        assert.equal(prepared.state.reasonCode, 'wechat_oauth_required');
    } finally {
      prepared?.orderRead.close();
      await prepared?.handle.close();
      await env.browser.close();
    }
  }
});

test('unconfirmed cleanup, cancellation and normal connection failure cannot continue filling', async () => {
  const cases = [
    { options: { cleanup: 'close_unconfirmed' }, code: 'session_cleanup_required', opens: 1 },
    { options: { failNormal: true }, code: undefined, opens: 1 },
    { options: {}, code: 'cancelled', opens: 1, cancel: true },
  ];
  for (const scenario of cases) {
    const env = await fixture({ light: errorPage, normal: form }, scenario.options);
    try {
      await assert.rejects(
        prepareInvoiceBrowser({
          engine: 'light',
          url,
          directory: env.directory,
          open: env.open,
          check: () => {
            if (scenario.cancel && env.order.includes('close:light'))
              throw new AppError('任务已取消', 400, 'cancelled');
          },
        }),
        (error) => scenario.code === undefined || error.code === scenario.code,
      );
      assert.equal(env.opened.length, scenario.opens);
      assert.ok(env.order.includes('close:light'));
    } finally {
      await env.browser.close();
    }
  }
});

test('Runner reports actual engine and routes using normal, while failures cannot enter review', async () => {
  for (const normal of [form, errorPage]) {
    const env = await fixture({ light: errorPage, normal });
    const store = new Store(env.directory);
    const runner = new Runner(store, { root: ROOT, dataDir: env.directory, openBrowser: env.open });
    const profile = store.saveProfile(DEMO_PROFILE);
    const task = store.createTask(
      {
        source: 'input',
        mode: 'dry_run',
        engine: 'light',
        engineRequested: 'light',
        url,
        profile,
        profileId: profile.id,
      },
      randomUUID(),
    );
    let routeEngine;
    runner.rules.select = async (_observation, _profile, engine) => {
      routeEngine = engine;
      throw new AppError('Synthetic routing stop', 400, 'synthetic_stop');
    };
    try {
      await runner.execute(task);
      const result = store.require('tasks', task.id);
      assert.equal(result.engine, 'normal');
      assert.equal(result.engineRequested, 'light');
      assert.equal(result.engineAttempts.length, 2);
      assert.equal(result.status, 'failed');
      assert.equal(result.actualSubmitted, false);
      assert.equal(result.cleanup.status, 'closed');
      assert.equal(result.engineAttempts.at(-1).cleanup.status, 'closed');
      assert.ok(!result.reviewToken);
      assert.deepEqual(result.fieldChecks, []);
      assert.equal(routeEngine, normal === form ? 'normal' : undefined);
      assert.ok(result.artifacts.some((artifact) => artifact.name === 'engine-check-light.png'));
      assert.ok(result.artifacts.some((artifact) => artifact.name === 'engine-check-normal.png'));
    } finally {
      await runner.close();
      store.close();
      await env.browser.close();
    }
  }
});
