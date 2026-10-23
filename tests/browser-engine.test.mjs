import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
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
  for (const reasonCode of ['known_client_entry', 'wechat_oauth_required', 'client_required'])
    assert.equal(engineRecheckReason({ status: 'unsupported_browser', reasonCode }), null);
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

test('client-required pages and WeChat OAuth stop under light without a normal recheck', async () => {
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
      assert.equal(prepared.engine, 'light');
      assert.equal(prepared.state.status, 'unsupported_browser');
      assert.equal(env.opened.length, 1);
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
      const notices = store
        .require('tasks', task.id)
        .events.filter((event) => event.phase === 'engine_recheck');
      assert.equal(notices.length, 1);
    } finally {
      await runner.close();
      store.close();
      await env.browser.close();
    }
  }
});

async function refillRun(
  t,
  { lightError, normalError, mode = 'dry_run', cleanup, lightShotFails },
) {
  const env = await fixture({ light: form, normal: form }, { cleanup });
  const open = async (engine, options) => {
    const handle = await env.open(engine, options);
    if (engine === 'light' && lightShotFails)
      handle.page.screenshot = async () => {
        throw new Error('Synthetic light screenshot failure');
      };
    return handle;
  };
  const store = new Store(env.directory);
  const runner = new Runner(store, { root: ROOT, dataDir: env.directory, openBrowser: open });
  t.after(async () => {
    await runner.close();
    store.close();
    await env.browser.close();
  });
  const profile = store.saveProfile(DEMO_PROFILE);
  const task = store.createTask(
    {
      source: 'input',
      mode,
      engine: 'light',
      engineRequested: 'light',
      url,
      profile,
      profileId: profile.id,
    },
    randomUUID(),
  );
  runner.rules.select = async (_observation, _profile, engine) => {
    const failure = engine === 'light' ? lightError : normalError;
    throw new AppError(`Synthetic ${engine} stop`, 400, failure);
  };
  await runner.execute(task);
  return { env, result: store.require('tasks', task.id) };
}

test('a light fill failure closes light and refills the whole page once under normal', async (t) => {
  const { env, result } = await refillRun(t, {
    lightError: 'stale_element',
    normalError: 'synthetic_stop',
  });
  assert.deepEqual(env.order, ['open:light', 'close:light', 'open:normal', 'close:normal']);
  assert.equal(result.engine, 'normal');
  assert.equal(result.reasonCode, 'synthetic_stop');
  assert.equal(result.fillFallback.trigger, 'stale_element');
  assert.equal(result.fillFallback.cleanup.status, 'closed');
  assert.equal(result.actualSubmitted, false);
  const saved = JSON.parse(
    await readFile(
      path.join(env.directory, 'artifacts', result.id, 'light-attempt', 'fallback.json'),
      'utf8',
    ),
  );
  assert.equal(saved.to, 'normal');
  await readFile(path.join(env.directory, 'artifacts', result.id, 'light-attempt', 'failure.png'));
  await readFile(
    path.join(env.directory, 'artifacts', result.id, 'light-attempt', 'observation-before.json'),
  );
});

test('a normal refill failure is not retried again', async (t) => {
  const { env, result } = await refillRun(t, {
    lightError: 'agent_blocked',
    normalError: 'agent_blocked',
  });
  assert.equal(env.order.filter((item) => item.startsWith('open:')).length, 2);
  assert.equal(result.status, 'failed');
  assert.equal(result.reasonCode, 'agent_blocked');
});

test('business and model-service failures under light do not trigger a normal refill', async (t) => {
  for (const code of ['ambiguous_company', 'tax_conflict', 'harness_failed', 'model_turn_failed']) {
    const { env, result } = await refillRun(t, { lightError: code, normalError: 'unexpected' });
    assert.deepEqual(env.order, ['open:light', 'close:light'], code);
    assert.equal(result.reasonCode, code);
    assert.ok(!result.fillFallback);
  }
});

test('a failed light screenshot is redone under normal', async (t) => {
  const { env, result } = await refillRun(t, { mode: 'read_only', lightShotFails: true });
  assert.deepEqual(env.order, ['open:light', 'close:light', 'open:normal', 'close:normal']);
  assert.equal(result.status, 'observed');
  assert.equal(result.engine, 'normal');
  assert.equal(result.fillFallback.trigger, 'screenshot_failed');
  assert.ok(result.artifacts.some((artifact) => artifact.name === 'pre-submit.png'));
});

test('normal refill waits for light to be confirmed closed', async (t) => {
  const { env, result } = await refillRun(t, {
    lightError: 'stale_element',
    normalError: 'unexpected',
    cleanup: 'close_unconfirmed',
  });
  assert.deepEqual(env.order, ['open:light', 'close:light']);
  assert.equal(result.reasonCode, 'session_cleanup_required');
});

test('a page read that never returns under light times out and rechecks with normal', async (t) => {
  const env = await fixture({ light: form, normal: form });
  t.after(() => env.browser.close());
  let light;
  const open = async (engine, options) => {
    const handle = await env.open(engine, options);
    if (engine === 'light') light = handle;
    return handle;
  };
  // Hang only the page read, after navigation and guard checks have passed.
  const step = (message, fn) => {
    if (message === '识别页面与字段' && light && !light.hung) {
      light.hung = true;
      light.page.mainFrame().evaluate = () => new Promise(() => {});
    }
    return fn();
  };
  const directory = path.join(env.directory, 'hang');
  await mkdir(directory, { recursive: true });
  const prepared = await prepareInvoiceBrowser({ engine: 'light', url, directory, open, step });
  t.after(() => prepared.handle.close());
  assert.equal(prepared.engine, 'normal');
  assert.deepEqual(env.order.slice(0, 3), ['open:light', 'close:light', 'open:normal']);
  const check = JSON.parse(await readFile(path.join(directory, 'engine-check.json'), 'utf8'));
  assert.equal(check.fallback.trigger, 'page_observation_failed');
});

test('cancel stops a step stuck on the page immediately and closes the browser', async (t) => {
  const env = await fixture({ light: form, normal: form });
  const open = async (engine, options) => {
    const handle = await env.open(engine, options);
    handle.page.mainFrame().evaluate = () => new Promise(() => {});
    return handle;
  };
  const store = new Store(env.directory);
  const runner = new Runner(store, { root: ROOT, dataDir: env.directory, openBrowser: open });
  t.after(async () => {
    await runner.close();
    store.close();
    await env.browser.close();
  });
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
  const running = runner.execute(task);
  while (store.require('tasks', task.id).status !== 'running' || !runner.activeHandle)
    await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const cancelledAt = performance.now();
  runner.cancel(task.id);
  await running;
  assert.ok(performance.now() - cancelledAt < 3000);
  const result = store.require('tasks', task.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.actualSubmitted, false);
  assert.ok(env.order.includes('close:light'));
  assert.ok(!env.order.includes('open:normal'));
});

test('a site where light failed goes straight to normal until light changes version', async (t) => {
  const env = await fixture({ light: form, normal: form });
  let lightVersion = 'light-1';
  const open = async (engine, options) => {
    const handle = await env.open(engine, options);
    handle.browser = { version: () => (engine === 'light' ? lightVersion : 'normal-1') };
    return handle;
  };
  const store = new Store(env.directory);
  const runner = new Runner(store, { root: ROOT, dataDir: env.directory, openBrowser: open });
  t.after(async () => {
    await runner.close();
    store.close();
    await env.browser.close();
  });
  const profile = store.saveProfile(DEMO_PROFILE);
  const host = new URL(url).hostname;
  runner.rules.select = async () => {
    throw new AppError('Synthetic routing stop', 400, 'synthetic_stop');
  };
  const run = async () => {
    env.order.length = 0;
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
    await runner.execute(task);
    return store.require('tasks', task.id);
  };
  let result = await run();
  assert.equal(env.order[0], 'open:light');
  assert.equal(store.get('settings', 'light-version').value, 'light-1');
  // Light failed on this site and normal reached the review screenshot.
  runner.rememberEngine(host, 'light-1', 'normal', result.id, true);
  result = await run();
  assert.deepEqual(env.order, ['open:normal', 'close:normal']);
  assert.equal(result.engine, 'normal');
  assert.equal(result.engineMemory.lightVersion, 'light-1');
  // Any task seeing a new light version makes this site try light once more.
  store.write('settings', { id: 'light-version', value: 'light-2' });
  lightVersion = 'light-2';
  result = await run();
  assert.equal(env.order[0], 'open:light');
  assert.ok(!result.engineMemory);
  runner.rememberEngine(host, 'light-2', 'light', result.id, false);
  assert.ok(!store.get('settings', `engine:${host}`));
});
