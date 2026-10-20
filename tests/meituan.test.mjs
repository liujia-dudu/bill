import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { requestAllowed, installGuard } from '../src/browser/guard.mjs';
import { observePage, classifyPage } from '../src/browser/observe.mjs';
import { prepareInvoiceBrowser, pageAbnormality } from '../src/browser/preflight.mjs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/server/config.mjs';

const entryUrl =
  'https://invoice.meituan.com/invoice.html#/eInvoice?id=00000000-0000-0000-0000-000000000001&businessSource=zhineng_shouyin&businessSourceFrom=zhineng_shouyin_xiaopiaoma';
const endpoint = 'https://invoice.meituan.com/api/invoice/process/queryReceiptQrCode';
const payload = { url: entryUrl, appChannel: '', env: 3, identifyToken: '' };
const query = {
  url: endpoint,
  method: 'POST',
  resourceType: 'xhr',
  entryUrl,
  postData: JSON.stringify(payload),
};
const asset =
  'https://s3.meituan.net/static-prod01/com.sankuai.fsp.fe.feinvoice-files/static/build/js/invoice.1234567890abcdef.js';

const detail = 'https://invoice.meituan.com/api/invoice/process/queryInvoiceDetailByInvoiceId';

test('Meituan page requests pass like a normal browser; offline fixtures stay offline', () => {
  for (const request of [
    query,
    { ...query, url: detail },
    { url: asset, method: 'GET', resourceType: 'fetch' },
    {
      url: 'https://s3.meituan.net/v1/mss_x/thunders/prod/mt-invoice-result-tips/source/index.json',
      method: 'GET',
      resourceType: 'xhr',
    },
    { url: 'https://catfront.dianping.com/api/log', method: 'POST', resourceType: 'xhr' },
  ])
    assert.equal(requestAllowed(request), true, request.url);
  assert.equal(requestAllowed({ ...query, demo: true }), false);
});

test('the issued-invoice page loads its detail reads normally, while our own apply click is stopped', async () => {
  const browser = await chromium.launch({ headless: true });
  const received = [];
  const blocked = [];
  try {
    const context = await browser.newContext();
    const register = context.route.bind(context);
    context.route = (pattern, callback) =>
      register(pattern, (route) => {
        // Fulfil requests the real guard lets through; nothing reaches Meituan.
        route.continue = () => {
          const request = route.request();
          received.push(new URL(request.url()).pathname);
          if (request.url() === endpoint)
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({ code: 200, data: { alreadyIssued: true, amount: 2913 } }),
            });
          if (request.url() === detail)
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({ code: 200, data: { invoiceNo: '26112000000000000000' } }),
            });
          if (request.url() === asset)
            return route.fulfill({ contentType: 'text/javascript', body: '/* synthetic asset */' });
          return route.abort();
        };
        return callback(route);
      });
    const page = await context.newPage();
    await page.route('https://invoice.meituan.com/invoice.html', (route) => {
      const request = route.request();
      received.push(new URL(request.url()).pathname);
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<h2 id="state">加载中</h2>
          <button type="button" id="apply">申请开票</button>
          <script>window.applicationCount=0;
          document.querySelector('#apply').onclick=()=>window.applicationCount++;
          Promise.all([
            fetch(${JSON.stringify(asset)}),
            fetch(${JSON.stringify(endpoint)}, {method:'POST',body:JSON.stringify(${JSON.stringify(payload)})})
          ]).then(async ([asset,read])=>{
            const response=await read.json();
            document.querySelector('#state').textContent=response.data.alreadyIssued?'查看发票 2913 元':'待填写';
            return fetch(${JSON.stringify(detail)}, {method:'POST',body:'{}'});
          }).then((r)=>r.json()).then((d)=>{
            document.querySelector('#state').textContent+=' 发票号码 '+d.data.invoiceNo;
          }).catch(()=>{
            document.querySelector('#state').textContent+=' 网络异常, 请检查您的网络设置';
          });</script>`,
      });
    });
    await installGuard(context, { entryUrl, onBlocked: (record) => blocked.push(record) });
    await page.goto(entryUrl);
    await page.waitForFunction(() =>
      document.querySelector('#state').textContent.includes('发票号码'),
    );
    const text = await page.locator('#state').textContent();
    assert.ok(!text.includes('网络异常'), text);
    assert.equal(classifyPage(await observePage(page)).status, 'already_issued');
    await page.locator('#apply').click();
    assert.equal(await page.evaluate(() => window.applicationCount), 0);
    assert.ok(received.includes('/api/invoice/process/queryReceiptQrCode'));
    assert.ok(received.includes('/api/invoice/process/queryInvoiceDetailByInvoiceId'));
    assert.deepEqual(blocked, []);
  } finally {
    await browser.close();
  }
});

test('a real service error from the page is reported as a page error and does not invoke filling', async () => {
  await mkdir(path.join(ROOT, 'test-results'), { recursive: true });
  const directory = await mkdtemp(path.join(ROOT, 'test-results', 'meituan-guard-error-'));
  const browser = await chromium.launch({ headless: true });
  let prepared;
  try {
    const open = async (_engine, { onSession }) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('https://invoice.meituan.com/api/unreviewed/read', (route) =>
        route.fulfill({ status: 500, body: 'error' }),
      );
      await page.route('https://invoice.meituan.com/invoice.html', (route) =>
        route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<p id="state">加载中</p><input style="display:none">
          <script>fetch('/api/unreviewed/read').then((r)=>{ if(!r.ok) throw r; }).catch(()=>{
            document.querySelector('#state').textContent='网络异常, 请检查您的网络设置 提示 服务出错！请稍后再试！';
          });</script>`,
        }),
      );
      const wait = page.waitForTimeout.bind(page);
      page.waitForTimeout = (ms) => wait(ms === 2200 ? 100 : ms);
      onSession('synthetic-session');
      return {
        context,
        page,
        close: async () => {
          await context.close();
          return { status: 'closed' };
        },
      };
    };
    prepared = await prepareInvoiceBrowser({ engine: 'normal', url: entryUrl, directory, open });
    assert.equal(prepared.state.reasonCode, 'page_error');
    const evidence = JSON.parse(await readFile(path.join(directory, 'engine-check.json'), 'utf8'));
    assert.equal(evidence.attempts.length, 1);
    assert.equal(evidence.attempts[0].state.reasonCode, 'page_error');
    const observation = {
      frames: [
        {
          innerText: '提示\n服务出错！请稍后再试！\n知道了',
          controls: [
            { tag: 'button', visible: true, enabled: true, editable: true },
            { tag: 'input', visible: false, enabled: true, editable: true },
          ],
        },
      ],
    };
    assert.equal(pageAbnormality(observation).reasonCode, 'page_error');
  } finally {
    prepared?.orderRead.close();
    await prepared?.handle.close();
    await browser.close();
  }
});
