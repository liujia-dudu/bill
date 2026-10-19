import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  observePage,
  assertInvoiceAmounts,
  watchInvoiceOrder,
  waitForInvoiceReady,
} from '../src/browser/observe.mjs';

test('Cube span amount and Vant readonly amount both use their labelled row', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="formItem"><label class="item-label">开票金额</label>
        <span><span class="amt-unit">￥</span><span class="amt-num">346.25</span></span>
      </div>
      <div class="formItem"><label>公司税号</label><input value="123456789012345"></div>
    `);
    assert.deepEqual(assertInvoiceAmounts(await observePage(page)), [
      { label: '开票金额', value: '346.25', amount: 346.25 },
    ]);
    await page.setContent(`
      <div class="van-cell"><div class="van-field__label">总金额</div>
        <input readonly value="¥199">
      </div>
    `);
    assert.equal(assertInvoiceAmounts(await observePage(page))[0].amount, 199);
  } finally {
    await browser.close();
  }
});

test('plain displayed amounts, output values and hidden rows are handled without reading other fields', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="field"><label>价税合计</label><span>￥1,234.50 元</span></div>
      <div class="field"><label>发票金额</label><output>268.00</output></div>
      <div class="field" style="display:none"><label>总金额</label><input value="0"></div>
    `);
    assert.deepEqual(
      assertInvoiceAmounts(await observePage(page)).map((item) => item.amount),
      [1234.5, 268],
    );
    await page.setContent(`
      <div class="field"><label>开票金额</label><span>加载中</span></div>
      <div class="field"><label>订单号</label><span>34625</span></div>
    `);
    const observation = await observePage(page);
    assert.deepEqual(observation.frames[0].amounts, [
      { label: '开票金额', value: '加载中', amount: null },
    ]);
    assert.throws(
      () => assertInvoiceAmounts(observation),
      (error) => error.code === 'order_not_loaded',
    );
  } finally {
    await browser.close();
  }
});

test('zero inputs and zero spans stay blocked even with unrelated positive text nearby', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const body of [
      '<input readonly value="¥0"><span>199</span>',
      '<span><span class="amt-unit">￥</span><span class="amt-num">0</span></span>',
    ]) {
      await page.setContent(`<div class="formItem"><label>开票金额</label>${body}</div>`);
      const observation = await observePage(page);
      assert.equal(observation.frames[0].amounts[0].amount, 0);
      assert.throws(
        () => assertInvoiceAmounts(observation),
        (error) => error.code === 'invalid_invoice_amount',
      );
    }
  } finally {
    await browser.close();
  }
});

test('Cube waits for this order response before accepting its positive placeholder amount', async () => {
  const browser = await chromium.launch({ headless: true });
  let orderRead;
  try {
    const context = await browser.newContext();
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/'))
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            code: 200,
            data: { data: { invoiceSum: 346.25 } },
          }),
        });
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<div class="formItem"><label>开票金额</label><span class="amt-num">100.00</span></div>
          <script>setTimeout(async()=>{
            const response = await fetch('/api/cube-ar/arInvoicePre/billingCode?serialNo=test-order');
            const body = await response.json();
            document.querySelector('.amt-num').textContent = body.data.data.invoiceSum;
          },600)</script>`,
      });
    });
    const page = await context.newPage();
    orderRead = watchInvoiceOrder(page);
    await page.goto('https://cube-inv.jcsk100.com/h5/#/qrCodeBilling?serialNo=test-order');
    assert.equal(assertInvoiceAmounts(await observePage(page))[0].amount, 100);
    await waitForInvoiceReady(page, orderRead);
    assert.equal(assertInvoiceAmounts(await observePage(page))[0].amount, 346.25);
  } finally {
    orderRead?.close();
    await browser.close();
  }
});

test('failed or incomplete order responses never turn a positive placeholder into a loaded order', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const body of [
      { code: 500 },
      { code: 200, data: { data: {} } },
      { code: 200, data: { data: { invoiceSum: 0 } } },
    ]) {
      const context = await browser.newContext();
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return route.fulfill({
          contentType: url.pathname.startsWith('/api/')
            ? 'application/json'
            : 'text/html; charset=utf-8',
          body: url.pathname.startsWith('/api/')
            ? JSON.stringify(body)
            : '<div class="formItem"><label>开票金额</label><span class="amt-num">100.00</span></div>',
        });
      });
      const page = await context.newPage();
      const orderRead = watchInvoiceOrder(page);
      try {
        await page.goto('https://cube-inv.jcsk100.com/h5/#/qrCodeBilling?serialNo=test-order');
        await page.evaluate(() =>
          fetch('/api/cube-ar/arInvoicePre/billingCode?serialNo=test-order'),
        );
        await assert.rejects(waitForInvoiceReady(page, orderRead), (error) =>
          ['order_not_loaded', 'invalid_invoice_amount'].includes(error.code),
        );
      } finally {
        orderRead.close();
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
});
