import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { chromium } from 'playwright';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/storage/store.mjs';
import { configuration } from '../src/server/config.mjs';
import { Runner } from '../src/core/runner.mjs';
import { InvoiceBrowserTools } from '../src/agent/browser-tools.mjs';
import { installGuard, pageGuard } from '../src/browser/guard.mjs';
import { validCreditCode } from '../src/core/tax-id.mjs';

const title = '青禾合成科技有限公司';
const taxId = '91310000MA0000000Y';
const profile = { type: 'enterprise', title, taxId: '', email: 'test@example.invalid' };
const html = await readFile(
  new URL('./fixtures/pages/invoice-company-demo.html', import.meta.url),
  'utf8',
);
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'page-tax-'));
  const store = new Store(directory);
  const c = store.createConversation();
  const saved = store.saveProfile(profile);
  const task = store.createTask(
    { profile: saved, profileId: saved.id, conversationId: c.id, mode: 'dry_run', source: 'input' },
    crypto.randomUUID(),
  );
  store.patchTask(task.id, { status: 'running' });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await installGuard(context, { demo: true });
  const page = await context.newPage();
  await page.setContent(html);
  await page.evaluate(pageGuard);
  const tools = new InvoiceBrowserTools({
    page,
    profile: { ...saved },
    directory,
    demo: true,
    onTaxVerified: (evidence) => store.savePageTax(task.id, evidence),
  });
  const ref = async (predicate) =>
    (await tools.observe()).frames.flatMap((f) => f.controls).find(predicate)?.elementRef;
  const fillTitle = async () =>
    tools.fill({ elementRef: await ref((c) => c.stableId === 'buyer'), valueRef: 'title' });
  const choose = async () =>
    tools.chooseCompany({ elementRef: await ref((c) => c.role === 'option') });
  const read = async () => tools.readTax({ elementRef: await ref((c) => c.stableId === 'credit') });
  return {
    directory,
    store,
    page,
    tools,
    saved,
    task,
    ref,
    fillTitle,
    choose,
    read,
    close: async () => {
      await browser.close();
      store.close();
    },
  };
}
test('page lookup fills missing tax, saves provenance, and finishes without submission', async () => {
  assert.ok(validCreditCode(taxId));
  const e = await setup();
  try {
    await e.fillTitle();
    await e.choose();
    await e.read();
    const saved = e.store.get('profiles', e.saved.id);
    assert.equal(saved.taxId, taxId);
    assert.equal(saved.taxSource.kind, 'invoice_page');
    assert.equal(saved.taxSource.taskId, e.task.id);
    assert.equal(e.store.get('tasks', e.task.id).profile.revision, saved.revision);
    assert.equal(e.tools.profile.revision, saved.revision);
    const notices = () =>
      e.store
        .messages(e.store.get('tasks', e.task.id).conversationId)
        .filter((m) => m.kind === 'profile').length;
    assert.equal(notices(), 1);
    // A later task whose saved tax already matches the page: no re-save, no notice.
    const again = e.store.createTask(
      {
        profile: saved,
        profileId: saved.id,
        conversationId: e.store.get('tasks', e.task.id).conversationId,
        mode: 'dry_run',
        source: 'input',
      },
      crypto.randomUUID(),
    );
    e.store.patchTask(again.id, { status: 'running' });
    const evidence = { kind: 'invoice_page', title: saved.title, taxId: saved.taxId };
    const unchanged = e.store.savePageTax(again.id, {
      title: saved.title,
      taxId: saved.taxId,
      source: evidence,
    });
    assert.equal(unchanged.revision, saved.revision);
    assert.equal(e.store.get('profiles', e.saved.id).revision, saved.revision);
    assert.equal(e.store.get('tasks', again.id).taxLookup.status, 'verified');
    assert.equal(notices(), 1);
    await access(path.join(e.directory, 'company-query.png'));
    await e.tools.fill({
      elementRef: await e.ref((c) => c.stableId === 'email'),
      valueRef: 'email',
    });
    assert.equal((await e.tools.finish()).readyForReview, true);
    assert.equal(await e.page.evaluate(() => window.submissionCount), 0);
    assert.ok(e.tools.result().checks.every((c) => c.matches));
  } finally {
    await e.close();
  }
});
test('near matches, duplicate names and conflicting tax are never selected or saved', async () => {
  const e = await setup();
  try {
    await e.page.evaluate(() => (window.testCompanies[0].title += '北京分公司'));
    await e.fillTitle();
    await assert.rejects(e.choose(), /抬头不一致/);
    await e.page.evaluate(
      ({ title, taxId }) =>
        (window.testCompanies = [
          { title, taxId },
          { title, taxId },
        ]),
      { title, taxId },
    );
    await e.fillTitle();
    await assert.rejects(e.choose(), /同名企业/);
    await e.page.evaluate(({ title, taxId }) => (window.testCompanies = [{ title, taxId }]), {
      title,
      taxId,
    });
    e.tools.profile.taxId = '91310000MA00000008';
    await e.fillTitle();
    await assert.rejects(e.choose(), /冲突/);
    assert.equal(e.store.get('profiles', e.saved.id).taxId, '');
  } finally {
    await e.close();
  }
});
test('known tax selects the one complete match beside a name-only item and branch results', async () => {
  const e = await setup();
  try {
    e.tools.profile.taxId = taxId;
    await e.page.evaluate(
      ({ title, taxId }) => {
        window.testCompanies = [
          { title, taxId: '', hideTax: true },
          { title, taxId },
          { title: title + '广州分公司', taxId },
          { title: title + '宝安分公司', taxId },
        ];
      },
      { title, taxId },
    );
    await e.fillTitle();
    await assert.rejects(e.choose(), /名称和已有税号/);
    const exact = await e.ref((c) => c.role === 'option' && c.text.includes('|'));
    await e.tools.chooseCompany({ elementRef: exact });
    await e.read();
    assert.equal(e.store.get('profiles', e.saved.id).taxId, taxId);
    assert.equal(await e.page.evaluate(() => window.submissionCount), 0);
  } finally {
    await e.close();
  }
});
test('without a known tax, name-only and coded same-name results remain ambiguous', async () => {
  const e = await setup();
  try {
    await e.page.evaluate(
      ({ title, taxId }) => {
        window.testCompanies = [
          { title, hideTax: true },
          { title, taxId },
        ];
      },
      { title, taxId },
    );
    await e.fillTitle();
    const exact = await e.ref((c) => c.role === 'option' && c.text.includes('|'));
    await assert.rejects(e.tools.chooseCompany({ elementRef: exact }), /多个同名企业/);
    assert.equal(e.store.get('profiles', e.saved.id).taxId, '');
  } finally {
    await e.close();
  }
});
test('committed company label can be hidden during focus without losing title readback', async () => {
  const e = await setup();
  try {
    e.tools.profile.taxId = taxId;
    await e.page.evaluate(() => {
      const buyer = document.getElementById('buyer');
      const selected = document.createElement('span');
      selected.className = 'el-select__selected-item is-hidden';
      selected.style.display = 'none';
      buyer.after(selected);
      buyer.addEventListener('blur', () => {
        selected.classList.remove('is-hidden');
        selected.style.display = '';
      });
      document.getElementById('choices').addEventListener('click', () => {
        selected.textContent = buyer.value + ' | ' + document.getElementById('credit').value;
        buyer.value = '';
      });
    });
    await e.fillTitle();
    await e.choose();
    await e.read();
    await e.tools.fill({
      elementRef: await e.ref((c) => c.stableId === 'email'),
      valueRef: 'email',
    });
    assert.equal((await e.tools.finish()).readyForReview, true);
    assert.equal(await e.page.evaluate(() => window.submissionCount), 0);
  } finally {
    await e.close();
  }
});
test('residual tax without candidate code and field tampering cannot become page evidence', async () => {
  const e = await setup();
  try {
    await e.page.evaluate((tax) => {
      window.testCompanies[0].hideTax = true;
      document.getElementById('credit').value = tax;
    }, taxId);
    await e.fillTitle();
    await e.choose();
    await assert.rejects(e.read(), /残留/);
    await e.page.evaluate(() => {
      window.testCompanies[0].hideTax = false;
    });
    await e.fillTitle();
    await e.choose();
    await e.page.locator('#buyer').evaluate((n) => (n.value = '其他公司'));
    await assert.rejects(e.read(), /抬头发生变化/);
    assert.equal(e.store.get('profiles', e.saved.id).taxId, '');
  } finally {
    await e.close();
  }
});
test('concurrent profile edit blocks saving; temporary task preserves shared default', async () => {
  const e = await setup();
  try {
    await e.fillTitle();
    await e.choose();
    const updated = e.store.saveProfile(
      { ...e.saved, email: 'changed@example.invalid' },
      e.saved.id,
    );
    await assert.rejects(e.read(), /修改或删除/);
    assert.equal(e.store.get('profiles', e.saved.id).taxId, '');
    e.store.patchTask(e.task.id, { temporaryProfile: true });
    await e.read();
    assert.equal(e.store.get('tasks', e.task.id).profile.taxId, taxId);
    assert.deepEqual(e.store.get('profiles', e.saved.id), updated);
  } finally {
    await e.close();
  }
});
test('runner accepts missing tax for page discovery but rejects a malformed supplied tax', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tax-start-'));
  const config = configuration({ dataDir: directory });
  const store = new Store(directory),
    runner = new Runner(store, config);
  runner.pump = async () => {};
  t.mock.method(dns, 'lookup', async (hostname) => {
    assert.equal(hostname, 'example.invalid');
    return [{ address: '203.0.113.10', family: 4 }];
  });
  syncBuiltinESMExports();
  try {
    const c = store.createConversation();
    const input = store.createInput({
      conversationId: c.id,
      urls: ['https://example.invalid/invoice'],
    });
    const p = store.saveProfile(profile);
    const args = {
      source: 'input',
      conversationId: c.id,
      inputId: input.id,
      profileId: p.id,
      profileRevision: p.revision,
    };
    const task = await runner.create(args, crypto.randomUUID());
    assert.equal(task.profile.taxId, '');
    const updated = store.saveProfile({ ...p, taxId: '123' }, p.id);
    await assert.rejects(
      runner.create({ ...args, profileRevision: updated.revision }, crypto.randomUUID()),
      /税号/,
    );
  } finally {
    await runner.close();
    store.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
