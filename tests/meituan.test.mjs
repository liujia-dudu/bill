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

test('Meituan QR status read is bound to the exact original receipt entry and complete desktop payload', () => {
  assert.equal(requestAllowed(query), true);
  assert.equal(requestAllowed({ ...query, resourceType: 'fetch' }), true);
  const forbidden = [
    { ...query, url: endpoint.replace('queryReceiptQrCode', 'applyReceiptCodeInvoice') },
    { ...query, url: endpoint.replace('queryReceiptQrCode', 'applyInvoiceElec') },
    { ...query, url: endpoint.replace('queryReceiptQrCode', 'submitBatchInvoice') },
    { ...query, url: endpoint.replace('queryReceiptQrCode', 'sendEmailByInvoiceId') },
    { ...query, url: endpoint.replace('queryReceiptQrCode', 'queryInvoiceDetailByInvoiceId') },
    { ...query, method: 'GET' },
    { ...query, resourceType: 'document' },
    { ...query, demo: true },
    { ...query, url: endpoint + '?apply=true' },
    { ...query, url: endpoint + '#submit' },
    { ...query, url: endpoint.replace('https:', 'http:') },
    { ...query, url: endpoint.replace('invoice.meituan.com', 'invoice.meituan.com.evil.invalid') },
    { ...query, url: endpoint.replace('invoice.meituan.com', 'invoice.meituan.com:444') },
    { ...query, entryUrl: undefined },
    { ...query, entryUrl: entryUrl + '&submit=true' },
    { ...query, entryUrl: entryUrl + '&id=00000000-0000-0000-0000-000000000002' },
    { ...query, entryUrl: entryUrl.replace('#/eInvoice?', '#/other?') },
    { ...query, entryUrl: entryUrl.replace('zhineng_shouyin_xiaopiaoma', 'other') },
    { ...query, entryUrl: entryUrl.replace('invoice.html#', 'invoice.html?apply=true#') },
    { ...query, postData: '{bad' },
    { ...query, postData: 'null' },
    {
      ...query,
      postData: JSON.stringify({ ...payload, url: entryUrl.replace('000001', '000002') }),
    },
    { ...query, postData: JSON.stringify({ ...payload, apply: true }) },
    { ...query, postData: JSON.stringify({ ...payload, identifyToken: 'unreviewed-token' }) },
    { ...query, postData: JSON.stringify({ ...payload, appChannel: 'unreviewed-channel' }) },
    { ...query, postData: JSON.stringify({ ...payload, env: 2 }) },
    { ...query, postData: JSON.stringify({ ...payload, env: '3' }) },
    { ...query, postData: JSON.stringify({ url: entryUrl, appChannel: '', env: 3 }) },
  ];
  for (const request of forbidden) assert.equal(requestAllowed(request), false);
});

test('fetch-loaded static assets are restricted to the reviewed receipt source and hashed paths', () => {
  const base = { url: asset, method: 'GET', resourceType: 'fetch', entryUrl };
  assert.equal(requestAllowed(base), true);
  assert.equal(
    requestAllowed({
      ...base,
      url: asset.replace('/js/invoice.', '/css/invoice.').replace('.js', '.css'),
      resourceType: 'xhr',
    }),
    true,
  );
  for (const request of [
    { ...base, method: 'POST' },
    { ...base, postData: '{}' },
    { ...base, demo: true },
    { ...base, entryUrl: 'https://example.com/invoice' },
    { ...base, url: asset + '?submit=true' },
    { ...base, url: asset.replace('s3.meituan.net', 's3.meituan.net.evil.invalid') },
    { ...base, url: asset.replace('1234567890abcdef', 'unhashed') },
    { ...base, url: 'https://s3.meituan.net/api/submit.js' },
    { ...base, url: 'https://s3.meituan.net/unknown/config.json' },
    { ...base, url: 'https://invoice.meituan.com/api/unknown/read' },
  ])
    assert.equal(requestAllowed(request), false);
});

test('guard lets the page read QR state and classify an existing invoice, without permitting application', async () => {
  const browser = await chromium.launch({ headless: true });
  const received = [];
  const blocked = [];
  try {
    const context = await browser.newContext();
    const register = context.route.bind(context);
    context.route = (pattern, callback) =>
      register(pattern, (route) => {
        // Fulfill only requests that the real guard explicitly allows. No
        // synthetic page or API test reaches Meituan's servers.
        route.continue = () => {
          const request = route.request();
          received.push(new URL(request.url()).pathname);
          if (request.url() === endpoint)
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({ code: 200, data: { alreadyIssued: true, amount: 2913 } }),
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
          });</script>`,
      });
    });
    await installGuard(context, { entryUrl, onBlocked: (record) => blocked.push(record) });
    await page.goto(entryUrl);
    await page.waitForFunction(() =>
      document.querySelector('#state').textContent.includes('查看发票'),
    );
    assert.equal(classifyPage(await observePage(page)).status, 'already_issued');
    await page.locator('#apply').click();
    assert.equal(await page.evaluate(() => window.applicationCount), 0);
    assert.equal(
      await page.evaluate(async (url) => {
        try {
          await fetch(url.replace('queryReceiptQrCode', 'applyReceiptCodeInvoice'), {
            method: 'POST',
            body: '{}',
          });
          return false;
        } catch {
          return true;
        }
      }, endpoint),
      true,
    );
    assert.ok(received.includes('/api/invoice/process/queryReceiptQrCode'));
    assert.ok(!received.includes('/api/invoice/process/applyReceiptCodeInvoice'));
    assert.ok(
      blocked.some((record) => record.path === '/api/invoice/process/applyReceiptCodeInvoice'),
    );
  } finally {
    await browser.close();
  }
});

test('a service error caused by unknown blocked API reads records the guard cause and does not invoke filling', async () => {
  await mkdir(path.join(ROOT, 'test-results'), { recursive: true });
  const directory = await mkdtemp(path.join(ROOT, 'test-results', 'meituan-guard-error-'));
  const browser = await chromium.launch({ headless: true });
  let prepared;
  try {
    const open = async (_engine, { onSession }) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('https://invoice.meituan.com/invoice.html', (route) =>
        route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<p id="state">加载中</p><input style="display:none">
          <script>fetch('/api/unreviewed/read').catch(()=>{
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
    assert.equal(prepared.state.reasonCode, 'network_read_blocked');
    assert.ok(prepared.state.message.includes('安全拦截'));
    const evidence = JSON.parse(await readFile(path.join(directory, 'engine-check.json'), 'utf8'));
    assert.equal(evidence.attempts.length, 1);
    assert.equal(evidence.attempts[0].state.reasonCode, 'network_read_blocked');
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
