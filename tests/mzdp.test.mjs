import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { requestAllowed, installGuard, pageGuard } from '../src/browser/guard.mjs';
import { observePage, assertInvoiceAmounts, waitForInvoiceReady } from '../src/browser/observe.mjs';
import { InvoiceBrowserTools } from '../src/agent/browser-tools.mjs';

const entryUrl = 'https://pos.mzdpgroup.com/mobile/inv/index.html?orderId=123456';
const companyTitle = '青禾合成科技有限公司';
function request(operation, payload, suffix = '') {
  return {
    url: `https://pos.mzdpgroup.com/mobile/invoiceNew.do?method=${operation}&ajaxUrl=y&json=${encodeURIComponent(JSON.stringify(payload))}${suffix}`,
    method: 'GET',
    resourceType: 'xhr',
    entryUrl,
    companyTitle,
  };
}

test('dispatcher reads pass like a normal browser; the page decides what to call', () => {
  // Submission safety is our own click guard, not filtering the page's requests.
  for (const value of [
    request('toFindInvoiceByOrder', { orderId: '123456' }, '&_=1792130000000'),
    request('toFindInvoiceHeader', { invoiceHeader: companyTitle }),
    { ...request('toFindInvoiceHeader', { invoiceHeader: companyTitle }), method: 'POST' },
  ])
    assert.equal(requestAllowed(value), true, value.url);
  assert.equal(
    requestAllowed({ ...request('toFindInvoiceByOrder', { orderId: '1' }), demo: true }),
    false,
  );
});

test('unlabelled Vant inputs and delayed div suggestions can verify page tax and amount without submission', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mzdp-page-'));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await installGuard(context, { demo: true });
    const page = await context.newPage();
    await page.setContent(
      await readFile(new URL('./fixtures/pages/invoice-vant-demo.html', import.meta.url), 'utf8'),
    );
    await page.evaluate(pageGuard);
    const profile = {
      type: 'enterprise',
      title: companyTitle,
      taxId: '',
      email: 'test@example.invalid',
    };
    const saved = [];
    const tools = new InvoiceBrowserTools({
      page,
      profile,
      directory,
      demo: true,
      onTaxVerified: (evidence) => {
        saved.push(evidence);
        return { taxId: evidence.taxId };
      },
    });
    const ref = async (label) =>
      (await tools.observe()).frames.flatMap((f) => f.controls).find((c) => c.label === label)
        ?.elementRef;
    const before = await observePage(page);
    assert.throws(() => assertInvoiceAmounts({ ...before, url: entryUrl }), /金额未加载/);
    await tools.fill({ elementRef: await ref('抬头名称'), valueRef: 'title' });
    const observation = await tools.observe();
    const candidate = observation.frames
      .flatMap((f) => f.controls)
      .find((c) => c.companySuggestion);
    assert.ok(candidate.actions.includes('choose_company'));
    await tools.chooseCompany({ elementRef: candidate.elementRef });
    await tools.readTax({ elementRef: await ref('企业税号') });
    assert.equal(saved.length, 1);
    assert.equal(profile.taxId, '91310000MA0000000Y');
    await tools.fill({ elementRef: await ref('邮箱地址'), valueRef: 'email' });
    await assert.rejects(tools.finish(), /金额未加载/);
    await page.locator('input[readonly]').evaluate((n) => {
      n.value = '¥168.50';
    });
    assert.equal(
      assertInvoiceAmounts({ ...(await observePage(page)), url: entryUrl })[0].amount,
      168.5,
    );
    assert.equal((await tools.finish()).readyForReview, true);
    assert.equal(await page.evaluate(() => window.submissionCount), 0);
    assert.ok(tools.result().checks.every((c) => c.matches));
    assert.throws(() => assertInvoiceAmounts({ url: entryUrl, frames: [] }), /尚未读取到/);
  } finally {
    await browser.close();
  }
});

test('order readiness waits for asynchronous amount instead of accepting initial zero', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<div class="van-cell"><div class="van-field__label">总金额</div><input value="¥0"></div><script>setTimeout(()=>document.querySelector('input').value='¥68.5',600)</script>`,
      }),
    );
    const page = await context.newPage();
    await page.goto(entryUrl);
    await waitForInvoiceReady(page);
    assert.equal(assertInvoiceAmounts(await observePage(page))[0].amount, 68.5);
  } finally {
    await browser.close();
  }
});
