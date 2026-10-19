import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InvoiceBrowserTools, redactProfile } from '../src/agent/browser-tools.mjs';
import { pageGuard, installGuard } from '../src/browser/guard.mjs';
import { SYNTHETIC_PROFILE as DEMO_PROFILE } from './fixtures/profile.mjs';
import { pageContract } from '../src/rules/contract.mjs';
import { modelHealth } from '../src/agent/model-config.mjs';
import { observePage } from '../src/browser/observe.mjs';

async function fixture(html) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'invoice-agent-'));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await installGuard(context, { demo: true });
  const page = await context.newPage();
  await page.setContent(html);
  await page.evaluate(pageGuard);
  const tools = new InvoiceBrowserTools({ page, profile: DEMO_PROFILE, directory, demo: true });
  return { browser, page, tools };
}
const inputs = `<section><h2>购买方信息</h2><div class="field"><label for="name">单位名称 *</label><input id="name" required></div><div class="field"><label for="tax">统一社会信用代码 *</label><input id="tax" required></div><div class="field"><label for="mail">邮箱 *</label><input id="mail" required></div><button type="button">提交开票</button></section>`;
const all = (observation) => observation.frames.flatMap((frame) => frame.controls);

test('page contract changes with new required fields and profile scope', () => {
  const observation = {
    url: 'https://example.com/invoice',
    frames: [
      {
        title: 'Invoice',
        controls: [
          { tag: 'input', type: 'text', label: '单位名称', required: true, visible: true },
        ],
      },
    ],
  };
  const signature = pageContract(observation, DEMO_PROFILE);
  const changed = structuredClone(observation);
  changed.frames[0].controls.push({
    tag: 'input',
    label: '新增必填',
    required: true,
    visible: true,
  });
  assert.notEqual(pageContract(changed, DEMO_PROFILE), signature);
  assert.notEqual(pageContract(observation, { ...DEMO_PROFILE, phone: '13800000000' }), signature);
  assert.equal(
    pageContract(observation, { ...DEMO_PROFILE, email: 'new@example.invalid' }),
    signature,
  );
});
test('seller fields, submit actions, stale handles and undeclared values are rejected', async () => {
  const { browser, page, tools } = await fixture(
    `<section><h2>销售方信息</h2><label for="seller">单位名称</label><input id="seller"></section>${inputs}`,
  );
  try {
    let observation = await tools.observe();
    const seller = all(observation).find((c) => c.stableId === 'seller');
    assert.equal(seller.excludedSeller, true);
    await assert.rejects(
      tools.dispatch('invoice_fill', { elementRef: seller.elementRef, valueRef: 'title' }),
    );
    const submit = all(observation).find((c) => c.text === '提交开票');
    await assert.rejects(tools.dispatch('invoice_continue', { elementRef: submit.elementRef }));
    const name = all(observation).find((c) => c.stableId === 'name');
    await assert.rejects(
      tools.dispatch('invoice_fill', { elementRef: name.elementRef, valueRef: '__proto__' }),
    );
    await tools.observe();
    await assert.rejects(
      tools.dispatch('invoice_fill', { elementRef: name.elementRef, valueRef: 'title' }),
      /过期/,
    );
    observation = await tools.observe();
    const current = all(observation).find((c) => c.stableId === 'name');
    await page.locator('label[for=name]').evaluate((node) => (node.textContent = '销售方名称'));
    await assert.rejects(
      tools.dispatch('invoice_fill', { elementRef: current.elementRef, valueRef: 'title' }),
      /语义已变化/,
    );
  } finally {
    await browser.close();
  }
});
test('finish verifies every required field and cannot run on a partially filled page', async () => {
  const { browser, tools } = await fixture(inputs);
  try {
    const observation = await tools.observe();
    await assert.rejects(tools.dispatch('invoice_finish', {}), /必填项/);
    for (const [id, key] of [
      ['name', 'title'],
      ['tax', 'taxId'],
      ['mail', 'email'],
    ]) {
      const current = await tools.observe();
      const ref = all(current).find((c) => c.stableId === id).elementRef;
      await tools.dispatch('invoice_fill', { elementRef: ref, valueRef: key });
    }
    const result = await tools.dispatch('invoice_finish', {});
    assert.equal(result.readyForReview, true);
    assert.equal(result.submitted, false);
    assert.ok(tools.result().checks.every((c) => c.matches));
  } finally {
    await browser.close();
  }
});
test('profile redaction handles quotes and nested values without disclosing keys', () => {
  const profile = { ...DEMO_PROFILE, title: '公司 "特殊" 名称' };
  assert.deepEqual(redactProfile({ text: profile.title, list: [profile.email] }, profile), {
    text: '[profile.title]',
    list: ['[profile.email]'],
  });
  assert.equal(Object.hasOwn(modelHealth(), 'apiKey'), false);
});
test('changed native selection cannot be accepted as a reviewed value', async () => {
  const { browser, page, tools } = await fixture(
    `<section><h2>购买方信息</h2><div class="field"><label for="kind">抬头类型 *</label><select id="kind" required><option value="enterprise">企业</option><option value="personal">个人</option></select></div></section>${inputs}`,
  );
  try {
    for (const [id, key] of [
      ['name', 'title'],
      ['tax', 'taxId'],
      ['mail', 'email'],
    ]) {
      const observation = await tools.observe();
      await tools.dispatch('invoice_fill', {
        elementRef: all(observation).find((c) => c.stableId === id).elementRef,
        valueRef: key,
      });
    }
    const observation = await tools.observe();
    await tools.dispatch('invoice_select', {
      elementRef: all(observation).find((c) => c.stableId === 'kind').elementRef,
      option: 'enterprise',
    });
    await page.locator('#kind').selectOption('personal');
    await assert.rejects(tools.dispatch('invoice_finish', {}), /改写/);
  } finally {
    await browser.close();
  }
});
test('hidden required stars leave phone optional while visible and native requirements still block', async () => {
  const { browser, page, tools } = await fixture(`${inputs}
    <div class="field"><label for="phone"><i class="require" style="display:none">*</i>手机号码</label>
      <input id="phone"></div>`);
  try {
    const phone = (await tools.observe()).frames[0].controls.find((c) => c.stableId === 'phone');
    assert.equal(phone.label, '手机号码');
    assert.equal(phone.required, false);
    const initialPhone = (await observePage(page)).frames[0].controls.find((c) => c.id === 'phone');
    assert.equal(initialPhone.label, '手机号码');
    assert.equal(initialPhone.required, false);
    for (const [id, valueRef] of [
      ['name', 'title'],
      ['tax', 'taxId'],
      ['mail', 'email'],
    ])
      await tools.fill({
        elementRef: all(await tools.observe()).find((c) => c.stableId === id).elementRef,
        valueRef,
      });
    await page.locator('.require').evaluate((node) => {
      node.style.display = '';
    });
    await assert.rejects(tools.finish(), /手机号码/);
    await page.locator('.require').evaluate((node) => {
      node.style.display = 'none';
    });
    await page.locator('#phone').evaluate((node) => {
      node.required = true;
    });
    await assert.rejects(tools.finish(), /手机号码/);
    await page.locator('#phone').evaluate((node) => {
      node.required = false;
    });
    await page.locator('#phone').evaluate((node) => {
      node.setAttribute('aria-required', 'true');
    });
    await assert.rejects(tools.finish(), /手机号码/);
    await page.locator('#phone').evaluate((node) => {
      node.removeAttribute('aria-required');
    });
    assert.equal((await tools.finish()).readyForReview, true);
    assert.equal(await page.locator('#phone').inputValue(), '');
  } finally {
    await browser.close();
  }
});
