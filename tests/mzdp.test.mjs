import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { requestAllowed, installGuard, applyPageGuard } from '../src/browser/guard.mjs';
import {
  observePage,
  assertInvoiceAmounts,
  waitForInvoiceReady,
  screenshotWithAgreementNotes,
  tickAgreements,
} from '../src/browser/observe.mjs';
import { InvoiceBrowserTools } from '../src/agent/browser-tools.mjs';
import { submitInvoice } from '../src/browser/submit.mjs';

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
    await applyPageGuard(page);
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

test('buyer type rendered as formless Vant buttons can be switched to personal without submitting', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mzdp-type-'));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const guard = await installGuard(context, { demo: true });
    const page = await context.newPage();
    await page.setContent(
      await readFile(
        new URL('./fixtures/pages/invoice-vant-buyer-type-demo.html', import.meta.url),
        'utf8',
      ),
    );
    await applyPageGuard(page);
    // A personal title of just "个人" must not hide the page's own type option.
    const profile = { type: 'personal', title: '个人', email: 'test@example.invalid' };
    const tools = new InvoiceBrowserTools({ page, profile, directory, demo: true });
    const controls = async () => (await tools.observe()).frames.flatMap((f) => f.controls);
    const button = async (text) => (await controls()).find((c) => c.text === text);
    const ref = async (label) => (await controls()).find((c) => c.label === label)?.elementRef;
    assert.deepEqual((await button('个人')).actions, ['select']);
    assert.deepEqual((await button('提交')).actions, []);
    await assert.rejects(
      tools.select({ elementRef: (await button('公司')).elementRef, option: '公司' }),
      /不一致/,
    );
    await tools.fill({ elementRef: await ref('抬头名称'), valueRef: 'title' });
    await tools.fill({ elementRef: await ref('邮箱地址'), valueRef: 'email' });
    await assert.rejects(tools.finish(), /抬头类型与资料不一致/);
    await tools.select({ elementRef: (await button('个人')).elementRef, option: '个人' });
    assert.equal((await button('个人')).pressed, true);
    assert.equal(await page.locator('#tax').isVisible(), false);
    assert.equal((await tools.finish()).readyForReview, true);
    assert.equal(await page.evaluate(() => window.submissionCount), 0);
    // Our own trusted clicks on submit-typed buttons stay blocked by the guard.
    await page.locator('#submit').click();
    assert.equal(await page.evaluate(() => window.submissionCount), 0);
    // The confirmed submission clicks the one real submit button, not the formless
    // 公司/个人 buttons that are type=submit by default.
    await submitInvoice({ page, guard, directory });
    assert.equal(await page.evaluate(() => window.submissionCount), 1);
  } finally {
    await browser.close();
  }
});

test('buyer type buttons inside a form are not selectable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mzdp-type-form-'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent(
      `<form><div class="van-cell"><div class="van-cell__title">抬头类型</div><button>公司</button><button>个人</button></div></form>`,
    );
    const tools = new InvoiceBrowserTools({
      page,
      profile: { type: 'personal', title: '张三', email: 'test@example.invalid' },
      directory,
      demo: true,
    });
    const controls = (await tools.observe()).frames.flatMap((f) => f.controls);
    assert.ok(controls.every((c) => !c.actions.includes('select')));
  } finally {
    await browser.close();
  }
});

test('a styled radio covered by a span (Element Plus) still switches buyer type', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'el-radio-'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    // The span sits on top of the real input and intercepts Playwright's click.
    await page.setContent(`<div class="formItem"><label class="item-label">开票类型</label>
      ${['company:企业', 'person:个人/非企业单位']
        .map((pair) => {
          const [value, text] = pair.split(':');
          return `<label class="el-radio" style="position:relative;display:inline-block;margin:8px">
            <span style="position:relative;display:inline-block;width:14px;height:14px">
              <input type="radio" name="t" value="${value}" ${value === 'company' ? 'checked' : ''}
                style="position:absolute;inset:0;margin:0;opacity:0">
              <span style="position:absolute;inset:0;border:1px solid #999;z-index:1"></span>
            </span><span>${text}</span></label>`;
        })
        .join('')}</div>`);
    const tools = new InvoiceBrowserTools({
      page,
      profile: { type: 'personal', title: '张三', email: 'test@example.invalid' },
      directory,
      demo: true,
    });
    const radio = (await tools.observe()).frames
      .flatMap((f) => f.controls)
      .find((c) => c.label === '个人/非企业单位');
    await tools.select({ elementRef: radio.elementRef, option: 'person' });
    assert.equal(await page.locator('input[value=person]').isChecked(), true);
  } finally {
    await browser.close();
  }
});

test('a personal title in an allow-create combobox is kept only by choosing its exact option', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'el-select-'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    // Element Plus filterable select: typed text is dropped on blur unless an option is chosen.
    await page.setContent(`
      <div class="formItem"><label>*名称</label>
        <span class="el-select__selected-item"></span>
        <input role="combobox" id="name" />
        <ul role="listbox"></ul></div>
      <div class="formItem"><label>*收票邮箱</label><input id="email" /></div>
      <button type="button">提交开票</button>
      <script>
        const input = document.querySelector('#name'), list = document.querySelector('ul');
        const shown = document.querySelector('.el-select__selected-item');
        input.addEventListener('input', () => {
          list.innerHTML = '';
          for (const text of [input.value, input.value + '（近似）']) {
            const li = document.createElement('li');
            li.setAttribute('role', 'option');
            li.textContent = text;
            li.addEventListener('mousedown', (event) => {
              event.preventDefault();
              shown.textContent = text;
              list.innerHTML = '';
            });
            list.append(li);
          }
        });
        input.addEventListener('blur', () => { input.value = ''; list.innerHTML = ''; });
      </script>`);
    const tools = new InvoiceBrowserTools({
      page,
      profile: { type: 'personal', title: '张三', email: 'test@example.invalid' },
      directory,
      demo: true,
    });
    const controls = async () => (await tools.observe()).frames.flatMap((f) => f.controls);
    await tools.fill({
      elementRef: (await controls()).find((c) => c.role === 'combobox').elementRef,
      valueRef: 'title',
    });
    const options = (await controls()).filter((c) => c.role === 'option');
    await assert.rejects(
      tools.chooseCompany({ elementRef: options.find((c) => /近似/.test(c.text)).elementRef }),
      /完全一致/,
    );
    const again = (await controls()).filter((c) => c.role === 'option');
    await tools.chooseCompany({ elementRef: again.find((c) => !/近似/.test(c.text)).elementRef });
    await tools.fill({
      elementRef: (await controls()).find((c) => c.label === '*收票邮箱').elementRef,
      valueRef: 'email',
    });
    assert.equal((await tools.finish()).readyForReview, true);
    assert.equal(await page.locator('.el-select__selected-item').textContent(), '张三');
  } finally {
    await browser.close();
  }
});

test('the default personal title may leave an optional name empty; a real name must be filled', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-title-'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    const html = `<div class="formItem"><label>抬头名称</label><input id="title" /></div>
      <div class="formItem"><label>收票邮箱</label><input id="email" /></div>
      <button type="button">提交开票</button>`;
    for (const [title, finishes] of [
      ['个人', true],
      ['张三', false],
    ]) {
      await page.setContent(html);
      const tools = new InvoiceBrowserTools({
        page,
        profile: { type: 'personal', title, email: 'test@example.invalid' },
        directory,
        demo: true,
      });
      const email = (await tools.observe()).frames
        .flatMap((f) => f.controls)
        .find((c) => c.label === '收票邮箱');
      await tools.fill({ elementRef: email.elementRef, valueRef: 'email' });
      if (finishes) assert.equal((await tools.finish()).readyForReview, true);
      else await assert.rejects(tools.finish(), /title/);
    }
  } finally {
    await browser.close();
  }
});

test('the review screenshot labels an unticked agreement and leaves the page untouched', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agree-note-'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent(
      '<div style="margin-top:60px"><label><input type="checkbox" id="agree" /></label> 我已阅读并同意《用户授权协议》</div>',
    );
    const before = await page.content();
    let labelled = 0;
    page.screenshot = async () => {
      labelled = await page.getByText('确认提交后自动勾选').count();
    };
    await screenshotWithAgreementNotes(page, { path: path.join(directory, 'x.png') });
    assert.equal(labelled, 1);
    assert.equal(await page.content(), before);
    assert.equal(await page.locator('#agree').isChecked(), false);
  } finally {
    await browser.close();
  }
});

test('the program ticks agreements before review but never marketing or unsafe ones', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await installGuard(context, { demo: true });
    const page = await context.newPage();
    await page.setContent(`
      <div><label><span style="display:inline-block;width:14px;height:14px">
        <input type="checkbox" id="agree" style="position:absolute;width:0;height:0;opacity:0" />
      </span></label> 我已阅读并同意《用户授权协议》</div>
      <label><input type="checkbox" id="marketing" /> 同意接收营销短信</label>
      <label><input type="checkbox" id="pay" /> 同意《免密支付协议》</label>`);
    await applyPageGuard(page);
    const results = await tickAgreements(page);
    assert.deepEqual(
      results.map((r) => [/授权/.test(r.text), r.checked]),
      [
        [true, true],
        [false, false],
      ],
    );
    assert.equal(await page.locator('#agree').isChecked(), true);
    assert.equal(await page.locator('#marketing').isChecked(), false);
    assert.equal(await page.locator('#pay').isChecked(), false);
  } finally {
    await browser.close();
  }
});
