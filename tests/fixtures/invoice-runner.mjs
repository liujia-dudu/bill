// Test-only browser/provider setup; production does not import fixture code.
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { RuleRegistry } from '../../src/rules/registry.mjs';
import { buildPending } from '../../src/rules/candidate.mjs';
import { InvoiceBrowserTools } from '../../src/agent/browser-tools.mjs';
import { installGuard } from '../../src/browser/guard.mjs';
import { SYNTHETIC_PROFILE } from './profile.mjs';
import { randomUUID } from 'node:crypto';

export const SYNTHETIC_URL = 'https://example.invalid/invoice?order=synthetic';
const lookup = dns.lookup;
export function syntheticDns(hostname, ...args) {
  return hostname === 'example.invalid'
    ? Promise.resolve([{ address: '203.0.113.10', family: 4 }])
    : lookup(hostname, ...args);
}
export function installSyntheticDns() {
  dns.lookup = syntheticDns;
  syncBuiltinESMExports();
}

export async function createSyntheticTask(
  store,
  runner,
  conversationId,
  profile = SYNTHETIC_PROFILE,
) {
  const saved = store.saveProfile({ ...profile });
  const input = store.createInput({ conversationId, urls: [SYNTHETIC_URL], decoded: true });
  return runner.create(
    {
      source: 'input',
      mode: 'dry_run',
      conversationId,
      inputId: input.id,
      profileId: saved.id,
      profileRevision: saved.revision,
    },
    randomUUID(),
  );
}

export function syntheticBrowser(file = 'invoice-demo.html') {
  return async (_engine, { onSession = () => {} } = {}) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
      const page = await context.newPage();
      const html = await readFile(new URL(`./pages/${file}`, import.meta.url), 'utf8');
      await page.route(SYNTHETIC_URL, (route) =>
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
      );
      onSession(null);
      let closing;
      return {
        browser,
        context,
        page,
        close: () => (closing ||= browser.close().then(() => ({ status: 'closed', local: true }))),
      };
    } catch (error) {
      await browser.close();
      throw error;
    }
  };
}

export async function writeSyntheticRule(directory, profile) {
  const handle = await syntheticBrowser()('light');
  try {
    await installGuard(handle.context, { demo: true });
    await handle.page.goto(SYNTHETIC_URL);
    const evidence = path.join(directory, 'evidence');
    await mkdir(evidence, { recursive: true });
    const tools = new InvoiceBrowserTools({
      page: handle.page,
      profile: { ...profile },
      directory: evidence,
    });
    let observation = await tools.observe();
    const buyer = observation.frames
      .flatMap((frame) => frame.controls)
      .find(
        (control) =>
          control.type === 'radio' &&
          control.text === '' &&
          control.label === (profile.type === 'personal' ? '个人' : '企业'),
      );
    if (!buyer) throw new Error('Synthetic buyer option missing');
    await tools.dispatch('invoice_select', { elementRef: buyer.elementRef, option: profile.type });
    for (const valueRef of [
      'title',
      ...(profile.type === 'enterprise' ? ['taxId'] : []),
      'email',
      ...(profile.phone ? ['phone'] : []),
    ]) {
      observation = await tools.observe();
      const control = observation.frames
        .flatMap((frame) => frame.controls)
        .find((item) => item.name === valueRef);
      await tools.dispatch('invoice_fill', { elementRef: control.elementRef, valueRef });
    }
    await tools.dispatch('invoice_finish', {});
    const pending = buildPending({
      tools,
      taskId: 'synthetic',
      initialUrl: SYNTHETIC_URL,
      initialProfile: profile,
      // Records match by engine; record under the default engine new tasks use.
      engine: 'light',
    });
    if (!pending) throw new Error('Synthetic record could not be built');
    const registry = new RuleRegistry(path.join(directory, 'rules'));
    await registry.learn(pending, 'trusted');
    return registry;
  } finally {
    await handle.close();
  }
}
