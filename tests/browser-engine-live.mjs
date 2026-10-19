// Explicit cloud read-only comparison; excluded from npm test.
import '../src/server/config.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/server/config.mjs';
import { openBrowser } from '../src/browser/session.mjs';
import { installGuard, requestAllowed, verifyGuard } from '../src/browser/guard.mjs';
import { observePage, classifyPage } from '../src/browser/observe.mjs';
import { entryRule, validatePublicUrl, safeMessage } from '../src/core/validation.mjs';
import { Store } from '../src/storage/store.mjs';
import { Runner } from '../src/core/runner.mjs';
import { randomUUID } from 'node:crypto';

const caseId = process.argv[2] || 't6';
const localeIndex = process.argv.indexOf('--locale');
const locale = localeIndex >= 0 ? process.argv[localeIndex + 1] : null;
const engineIndex = process.argv.indexOf('--engine');
const selectedEngine = engineIndex >= 0 ? process.argv[engineIndex + 1] : null;
if (selectedEngine && !['normal', 'light'].includes(selectedEngine))
  throw new Error('Invalid comparison engine');
const catalog = JSON.parse(
  await readFile(path.join(ROOT, 'data/samples/invoice-cases.json'), 'utf8'),
);
const entry = catalog.cases.find((item) => item.id === caseId);
const url = entry?.qr_candidates.find((item) => item.decode_valid)?.original_url;
if (!url) throw new Error('Case has no decoded entry URL');
await validatePublicUrl(url);
const directory = path.join(ROOT, 'test-results', `browser-engine-${caseId}-${Date.now()}`);
await mkdir(directory, { recursive: true });
const report = {
  caseId,
  startedAt: new Date().toISOString(),
  readOnly: true,
  fieldWrites: 0,
  clicks: 0,
  invoiceSubmissions: 0,
  results: [],
};
const save = () => writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
if (process.argv.includes('--runner')) {
  const store = new Store(directory);
  const runner = new Runner(store, { root: ROOT, dataDir: directory });
  try {
    const task = store.createTask(
      {
        source: 'input',
        mode: 'read_only',
        engine: selectedEngine || 'light',
        engineRequested: selectedEngine || 'light',
        url,
        profile: null,
      },
      randomUUID(),
    );
    await runner.execute(task);
    report.task = store.require('tasks', task.id);
    report.finishedAt = new Date().toISOString();
    await save();
    console.log(
      JSON.stringify({
        report: path.relative(ROOT, path.join(directory, 'report.json')),
        status: report.task.status,
        reasonCode: report.task.reasonCode,
        engine: report.task.engine,
        attempts: report.task.engineAttempts?.length,
        actualSubmitted: report.task.actualSubmitted,
        cleanup: report.task.cleanup,
      }),
    );
    if (
      report.task.actualSubmitted ||
      report.task.cleanup?.status !== 'closed' ||
      !report.task.engineAttempts?.length
    )
      process.exitCode = 1;
  } finally {
    await runner.close();
    store.close();
  }
}
for (const engine of process.argv.includes('--runner')
  ? []
  : process.argv.includes('--desktop')
    ? ['desktop']
    : selectedEngine
      ? [selectedEngine]
      : ['light', 'normal']) {
  const result = {
    engine,
    startedAt: new Date().toISOString(),
    blocked: [],
    pageErrors: [],
    invoiceRequests: [],
  };
  report.results.push(result);
  await save();
  let handle;
  try {
    console.log(JSON.stringify({ caseId, engine, stage: 'connecting' }));
    handle = await openBrowser(engine === 'desktop' ? 'normal' : engine, {
      demo: engine === 'desktop',
      onSession: (sessionId) => {
        result.sessionId = sessionId;
      },
    });
    if (engine === 'desktop' && locale) {
      handle.context = await handle.browser.newContext({
        locale,
        viewport: { width: 1365, height: 900 },
        serviceWorkers: 'block',
      });
      handle.page = await handle.context.newPage();
    }
    if (engine === 'desktop') await handle.page.setViewportSize({ width: 1365, height: 900 });
    if (engine !== 'desktop' && locale)
      await handle.context.setExtraHTTPHeaders({ 'Accept-Language': `${locale},zh;q=0.9` });
    result.localeRequested = locale;
    result.browserIdentity = await handle.page.evaluate(() => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
    }));
    await save();
    handle.page.on('request', (request) => {
      const parsed = new URL(request.url());
      if (parsed.origin !== 'https://invoice.meituan.com' || !parsed.pathname.startsWith('/api/'))
        return;
      result.invoiceRequests.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        postData: request.postData(),
      });
    });
    await installGuard(handle.context, {
      entryUrl: url,
      onBlocked: (record) => result.blocked.push(record),
      onClientEntry: (rule) => {
        result.clientEntry = rule;
      },
    });
    await verifyGuard(handle.page);
    // Only this diagnostic observes the known OAuth GET document instead of
    // stopping at its address. No auth actions or unknown API reads are enabled.
    await handle.context.route(
      'https://open.weixin.qq.com/connect/oauth2/authorize*',
      async (route) => {
        const request = route.request();
        if (
          entryRule(request.url())?.reasonCode !== 'wechat_oauth_required' ||
          !request.isNavigationRequest() ||
          request.frame().parentFrame() !== null ||
          request.method() !== 'GET' ||
          !requestAllowed({
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
          })
        )
          return route.fallback();
        await validatePublicUrl(request.url());
        return route.continue();
      },
    );
    handle.page.on('pageerror', (error) => result.pageErrors.push(safeMessage(error)));
    console.log(JSON.stringify({ caseId, engine, stage: 'observing' }));
    try {
      const response = await handle.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      result.httpStatus = response?.status() ?? null;
    } catch (error) {
      result.navigationError = safeMessage(error);
    }
    let previous = '';
    let stable = 0;
    for (let count = 0; count < 12; count++) {
      await handle.page.waitForTimeout(1000);
      try {
        const observation = await observePage(handle.page);
        const text = observation.frames
          .map((frame) => frame.innerText || frame.contentText)
          .join('\n');
        stable = text.trim() && text === previous ? stable + 1 : 0;
        previous = text;
        result.observation = observation;
        if (count >= 4 && stable >= 2) break;
      } catch {
        // Redirects may temporarily replace the execution context.
      }
    }
    result.pageState = result.observation ? classifyPage(result.observation) : null;
    result.entryState = entryRule(handle.page.url());
    result.finalHost = new URL(handle.page.url()).hostname;
    result.screenshot = `${engine}.png`;
    await handle.page.screenshot({
      path: path.join(directory, result.screenshot),
      fullPage: true,
      timeout: 15000,
    });
    await writeFile(path.join(directory, `${engine}.html`), await handle.page.content());
  } catch (error) {
    result.error = safeMessage(error);
    result.reasonCode = error.code || 'operation_failed';
    if (error.cleanup) result.cleanup = error.cleanup;
    process.exitCode = 1;
  } finally {
    if (handle) result.cleanup = await handle.close();
    result.finishedAt = new Date().toISOString();
    await save();
    console.log(
      JSON.stringify({
        caseId,
        engine,
        finalHost: result.finalHost,
        pageState: result.pageState,
        entryState: result.entryState,
        screenshotSaved: Boolean(result.screenshot && !result.error),
        cleanup: result.cleanup,
        error: result.error,
      }),
    );
  }
  if (result.cleanup?.status === 'close_unconfirmed') {
    process.exitCode = 1;
    break;
  }
}
report.finishedAt = new Date().toISOString();
await save();
console.log(JSON.stringify({ report: path.relative(ROOT, path.join(directory, 'report.json')) }));
