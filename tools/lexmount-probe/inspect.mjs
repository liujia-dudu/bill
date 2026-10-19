import { loadEnvFile } from 'node:process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
loadEnvFile(path.join(root, '.env'));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const engine = flag('--engine', 'light');
const caseIds = flag('--cases', 't2').split(',');
const config = {
  keyConfigured: Boolean(process.env.LEXMOUNT_API_KEY),
  projectConfigured: Boolean(process.env.LEXMOUNT_PROJECT_ID),
  customEndpointConfigured: Boolean(process.env.LEXMOUNT_BASE_URL),
  node: process.version,
};
const log = (data) => console.log(JSON.stringify(data));
if (args.includes('--check-config')) {
  log(config);
  process.exit(config.keyConfigured && config.projectConfigured ? 0 : 1);
}
if (!config.keyConfigured || !config.projectConfigured) {
  throw new Error('Missing LEXMOUNT_API_KEY or LEXMOUNT_PROJECT_ID in project environment.');
}
if (!['light', 'normal'].includes(engine)) throw new Error('Invalid browser engine.');

const { Lexmount, disableLogging } = await import('lexmount');
const { chromium } = await import('playwright');
disableLogging();
const cases = JSON.parse(await readFile(path.join(root, 'data', 'samples', 'invoice-cases.json'), 'utf8')).cases;
const selected = caseIds.map((id) => {
  const item = cases.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown case: ${id}`);
  return item;
});
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const outDir = path.join(root, 'data', 'lexmount-observations', runId);
await mkdir(outDir, { recursive: true });
const client = new Lexmount({ timeout: 25000 });
const summary = { runId, engine, observedAt: new Date().toISOString(), readOnly: true,
  invoiceSubmissions: 0, fieldWrites: 0, clicks: 0, cases: [] };
const secrets = [process.env.LEXMOUNT_API_KEY, process.env.LEXMOUNT_PROJECT_ID].filter(Boolean);
function safeError(error) {
  let message = String(error?.message || error);
  for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
  message = message.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, '[url]');
  return { name: error?.name || 'Error', message: message.slice(0, 800),
    statusCode: error?.statusCode ?? null };
}
async function save() {
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
}
let activeSession;
let activeBrowser;
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  for (const entry of selected) {
    if (stopping) break;
    const result = { caseId: entry.id, engine, startedAt: new Date().toISOString(),
      stage: 'creating_session', readOnly: true, screenshots: [], cleanup: {} };
    summary.cases.push(result);
    await save();
    log({ caseId: entry.id, stage: result.stage, engine });
    const started = Date.now();
    try {
      activeSession = await client.sessions.create({
        browserMode: engine,
        ...(engine === 'light' ? { enableLightmountLayout: true, enableLightmountResource: true } : {}),
        windowSize: '390,844',
        downloads: { enabled: false },
        recording: { persistent: false },
        enableCaptcha: false,
        pollTimeoutMs: 60000,
        pollIntervalMs: 1000,
      });
      result.sessionId = activeSession.id;
      result.stage = 'connecting';
      await save();
      log({ caseId: entry.id, stage: result.stage });
      if (!activeSession.connectUrl) throw new Error('Session has no CDP endpoint.');
      secrets.push(activeSession.connectUrl);
      activeBrowser = await chromium.connectOverCDP(activeSession.connectUrl, { timeout: 20000 });
      const context = activeBrowser.contexts()[0];
      if (!context) throw new Error('No default browser context.');
      const page = context.pages()[0] ?? await context.newPage();
      page.setDefaultTimeout(12000);
      const problems = [];
      page.on('pageerror', (error) => problems.push(safeError(error)));
      try { await page.setViewportSize({ width: 390, height: 844 }); }
      catch (error) { result.viewportError = safeError(error); }
      const originalUrl = entry.qr_candidates.find((qr) => qr.decode_valid)?.original_url;
      if (!originalUrl) throw new Error('No decoded entry URL in case catalog.');
      result.stage = 'navigating';
      await save();
      log({ caseId: entry.id, stage: result.stage, entryHost: new URL(originalUrl).hostname });
      try {
        const response = await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        result.entryHttpStatus = response?.status() ?? null;
      } catch (error) { result.navigationError = safeError(error); }
      // Allow SPA redirects and async business data to settle without clicking or filling.
      let previousText = '';
      let stable = 0;
      for (let count = 0; count < 10 && !stopping; count++) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        try {
          const text = await page.locator('body').innerText({ timeout: 5000 });
          stable = text.trim() && text === previousText ? stable + 1 : 0;
          previousText = text;
          if (count >= 3 && stable >= 2) break;
        } catch { /* Redirects can temporarily replace the execution context. */ }
      }
      result.stage = 'observing';
      result.finalUrl = page.url();
      result.title = await page.title();
      result.pageText = previousText;
      result.frames = page.frames().map((frame) => ({ name: frame.name(), url: frame.url() }));
      result.controls = await page.evaluate(() => Array.from(document.querySelectorAll(
        'input,textarea,select,button,[role="button"],[role="checkbox"],a'
      )).slice(0, 100).map((node) => ({
        tag: node.tagName.toLowerCase(),
        type: node.getAttribute('type'), role: node.getAttribute('role'),
        name: node.getAttribute('name'), id: node.id || null,
        label: node.labels ? Array.from(node.labels).map((label) => label.textContent.trim()).join(' ') : null,
        ariaLabel: node.getAttribute('aria-label'), placeholder: node.getAttribute('placeholder'),
        text: node.textContent?.trim().slice(0, 200), required: node.hasAttribute('required'),
        disabled: node.hasAttribute('disabled'), valuePresent: Boolean(node.value),
        rect: (() => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; })(),
      })));
      result.domText = await page.evaluate(() => document.body?.textContent?.slice(0, 30000) ?? '');
      result.contentText = await page.evaluate(() => {
        const content = document.body.cloneNode(true);
        for (const node of content.querySelectorAll('script,style,noscript')) node.remove();
        return content.textContent.replace(/\s+/g, ' ').trim().slice(0, 15000);
      });
      try {
        const name = `${entry.id}-${engine}.html`;
        await writeFile(path.join(outDir, name), await page.content());
        result.domSnapshot = name;
      } catch (error) { result.domSnapshotError = safeError(error); }
      result.pageErrors = problems;
      try {
        const name = `${entry.id}-${engine}.png`;
        await page.screenshot({ path: path.join(outDir, name), timeout: 15000, fullPage: true });
        result.screenshots.push(name);
      } catch (error) { result.screenshotError = safeError(error); }
      result.stage = 'observed';
      log({ caseId: entry.id, stage: result.stage, finalHost: new URL(result.finalUrl).hostname,
        textLength: result.pageText.length, controlCount: result.controls.length,
        screenshotSaved: result.screenshots.length > 0 });
    } catch (error) {
      result.failedAtStage = result.stage;
      result.error = safeError(error);
      result.stage = 'failed';
      log({ caseId: entry.id, stage: 'failed', failedAtStage: result.failedAtStage, error: result.error });
      // Activation timeouts may expose a reserved session that still needs closing.
      if (!activeSession) {
        result.sessionId = error?.sessionId ?? error?.response?.session_id
          ?? String(error?.message || '').match(/Timed out waiting for session ([\w-]+) to become active/)?.[1];
      }
    } finally {
      if (activeBrowser) {
        try { await activeBrowser.close(); result.cleanup.browserDisconnected = true; }
        catch (error) { result.cleanup.browserError = safeError(error); }
        activeBrowser = undefined;
      }
      if (activeSession || result.sessionId) {
        try {
          if (activeSession) await activeSession.close();
          else await client.sessions.delete({ sessionId: result.sessionId });
          result.cleanup.sessionCloseAccepted = true;
        } catch (error) { result.cleanup.sessionError = safeError(error); }
        for (let poll = 0; poll < 12; poll++) {
          try {
            const current = await client.sessions.get(result.sessionId);
            result.cleanup.finalStatus = current.status;
            if (['closed', 'create_failed'].includes(current.status)) break;
          } catch (error) {
            if (error?.statusCode === 404 || error?.name === 'SessionNotFoundError') {
              result.cleanup.finalStatus = 'not_found_after_close';
            } else result.cleanup.verifyError = safeError(error);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        activeSession = undefined;
      }
      result.durationMs = Date.now() - started;
      result.finishedAt = new Date().toISOString();
      await save();
      log({ caseId: entry.id, durationMs: result.durationMs, cleanup: result.cleanup });
    }
    if (result.stage === 'failed') process.exitCode = 1;
    if (result.sessionId && !['closed', 'create_failed', 'not_found_after_close'].includes(result.cleanup.finalStatus)) {
      process.exitCode = 1;
      log({ caseId: entry.id, stage: 'stopped', reason: 'session_cleanup_not_confirmed' });
      break;
    }
    if (result.failedAtStage === 'creating_session') break;
  }
} finally {
  client.close();
  summary.finishedAt = new Date().toISOString();
  await save();
  log({ report: path.relative(root, path.join(outDir, 'summary.json')), casesObserved: summary.cases.length });
}
