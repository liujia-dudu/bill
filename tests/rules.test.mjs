import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/server/config.mjs';
import { InvoiceBrowserTools } from '../src/agent/browser-tools.mjs';
import { RuleRegistry } from '../src/rules/registry.mjs';
import { executeRule } from '../src/rules/executor.mjs';
import { buildCandidate } from '../src/rules/candidate.mjs';
import { pageContract } from '../src/rules/contract.mjs';
import {
  flowDigest,
  validateFlow,
  validatePolicy,
  profileFields,
  captureParameters,
} from '../src/rules/schema.mjs';
import { observePage } from '../src/browser/observe.mjs';
import { installGuard, pageGuard } from '../src/browser/guard.mjs';

const host = 'invoice.example.invalid';
const profile = {
  type: 'enterprise',
  title: 'Synthetic Company',
  taxId: '91310000MA0000000Y',
  email: 'test@example.invalid',
};
const html = `<section><h2>购买方信息</h2>
<div class="field"><label for="name">单位名称 *</label><input id="name" required></div>
<div class="field"><label for="tax">税号 *</label><input id="tax" required></div>
<div class="field"><label for="mail">邮箱 *</label><input id="mail" required></div>
<button type="button" id="submit">提交开票</button>
</section><script>window.submissionCount=0;document.querySelector('#submit').onclick=()=>window.submissionCount++;</script>`;

async function workspace() {
  await mkdir(path.join(ROOT, 'test-results'), { recursive: true });
  const directory = await mkdtemp(path.join(ROOT, 'test-results', 'rules-'));
  const rulesDir = path.join(directory, 'rules');
  return { directory, rulesDir, registry: new RuleRegistry(rulesDir) };
}
function flowFor(signature) {
  return {
    schemaVersion: 1,
    id: host,
    hosts: [host],
    variants: [
      {
        id: 'default',
        engine: 'normal',
        match: {
          protocol: 'https:',
          port: '',
          pathPrefix: '/invoice',
          hashPrefix: '',
          parameters: captureParameters(new URL(observation.url)),
          buyerType: 'enterprise',
          profileFields: profileFields(profile),
        },
        steps: [{ action: 'finish', contract: signature }],
      },
    ],
  };
}
function reviewed(flow) {
  return {
    enabled: false,
    minSupervisedSuccess: 1,
    evidenceRefs: [],
    preparationReviews: [
      {
        variantId: 'default',
        flowDigest: flowDigest(flow),
        reviewedAt: '2026-10-16T00:00:00Z',
        signatureComplete: true,
        protocolReviewed: true,
        agreementVerified: true,
      },
    ],
  };
}
async function writeRule(rulesDir, flow, policy = reviewed(flow)) {
  const directory = path.join(rulesDir, host);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'flow.json'), JSON.stringify(flow));
  await writeFile(path.join(directory, 'policy.json'), JSON.stringify(policy));
}
const observation = {
  url: `https://${host}/invoice?order=synthetic`,
  frames: [
    {
      title: 'Invoice',
      controls: [
        { tag: 'input', type: 'text', label: '名称', visible: true, enabled: true, required: true },
      ],
    },
  ],
};
async function browserFixture(directory, content = html) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await installGuard(context, { demo: true });
  const page = await context.newPage();
  // Synthetic HTTPS origin, with no requests to an actual invoice site.
  await page.route(`https://${host}/**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: content }),
  );
  await page.goto(`https://${host}/invoice?order=synthetic`);
  await page.evaluate(pageGuard);
  const tools = new InvoiceBrowserTools({ page, profile: { ...profile }, directory, demo: true });
  return { browser, page, tools };
}
async function explore(tools) {
  for (const [id, valueRef] of [
    ['name', 'title'],
    ['tax', 'taxId'],
    ['mail', 'email'],
  ]) {
    const observed = await tools.observe();
    const control = observed.frames
      .flatMap((frame) => frame.controls)
      .find((c) => c.stableId === id);
    await tools.dispatch('invoice_fill', { elementRef: control.elementRef, valueRef });
  }
  await tools.dispatch('invoice_finish', {});
}

test('empty registry starts, and domain JSON additions/edits/deletions load without restart', async () => {
  const { rulesDir, registry } = await workspace();
  assert.equal((await registry.select(observation, profile)).reason, 'new_page');
  const flow = flowFor(pageContract(observation, profile));
  await writeRule(rulesDir, flow);
  const route = await registry.select(observation, profile);
  assert.equal(route.source, 'adapter');
  assert.equal(
    (
      await registry.select(
        { ...observation, url: `https://${host}.evil.invalid/invoice` },
        profile,
      )
    ).source,
    'agent',
  );
  assert.equal((await registry.select(observation, profile, 'light')).source, 'agent');
  assert.equal(
    (
      await registry.select(
        { ...observation, url: observation.url.replace('https:', 'http:') },
        profile,
      )
    ).source,
    'agent',
  );
  assert.equal(
    (
      await registry.select(
        { ...observation, url: `${observation.url}&invoiceType=other` },
        profile,
      )
    ).source,
    'agent',
  );
  assert.equal(
    (
      await registry.select(
        { ...observation, url: observation.url.replace('synthetic', 'another') },
        profile,
      )
    ).source,
    'agent',
  );
  const changed = structuredClone(observation);
  changed.frames[0].controls.push({ tag: 'input', required: true });
  assert.equal((await registry.select(changed, profile)).source, 'agent');
  flow.variants[0].steps[0].contract = pageContract(changed, profile);
  await writeRule(rulesDir, flow);
  assert.equal((await registry.select(changed, profile)).source, 'adapter');
  flow.variants[0].match.parameters.query.order = { kind: 'transaction' };
  await writeRule(rulesDir, flow);
  assert.equal(
    (
      await registry.select(
        { ...changed, url: changed.url.replace('synthetic', 'another') },
        profile,
      )
    ).source,
    'adapter',
  );
  await assert.rejects(registry.assertUnchanged(route.rule), { code: 'rule_changed' });
  await rm(path.join(rulesDir, host), { recursive: true });
  assert.equal((await registry.select(changed, profile)).reason, 'new_page');
});

test('unreviewed, partial, stale, ambiguous and malformed rules never run', async () => {
  const { rulesDir, registry } = await workspace();
  const flow = flowFor(pageContract(observation, profile));
  const policy = reviewed(flow);
  policy.preparationReviews = [];
  await writeRule(rulesDir, flow, policy);
  assert.equal((await registry.select(observation, profile)).source, 'agent');
  const partial = reviewed(flow);
  partial.preparationReviews[0].agreementVerified = false;
  await writeRule(rulesDir, flow, partial);
  assert.equal((await registry.select(observation, profile)).source, 'agent');
  const stale = reviewed(flow);
  flow.variants[0].match.pathPrefix = '/';
  await writeRule(rulesDir, flow, stale);
  assert.equal((await registry.select(observation, profile)).source, 'agent');
  const second = structuredClone(flow.variants[0]);
  second.id = 'second';
  flow.variants.push(second);
  const duplicatePolicy = reviewed(flow);
  duplicatePolicy.preparationReviews.push({
    ...duplicatePolicy.preparationReviews[0],
    variantId: 'second',
  });
  await writeRule(rulesDir, flow, duplicatePolicy);
  assert.equal((await registry.select(observation, profile)).reason, 'ambiguous_rules');
  await writeFile(path.join(rulesDir, host, 'flow.json'), '{broken');
  assert.equal((await registry.select(observation, profile)).reason, 'invalid_rule');
});

test('schema excludes executable code, arbitrary values and all submission actions', () => {
  const flow = flowFor('a'.repeat(64));
  assert.equal(validateFlow(flow, host), flow);
  for (const action of ['submit', 'click', 'evaluate', 'fetch', 'agree']) {
    const unsafe = structuredClone(flow);
    unsafe.variants[0].steps.unshift({ action, contract: 'a'.repeat(64) });
    assert.throws(() => validateFlow(unsafe, host), { code: 'invalid_rule' });
  }
  const script = structuredClone(flow);
  script.variants[0].script = 'dangerous()';
  assert.throws(() => validateFlow(script, host), { code: 'invalid_rule' });
  assert.throws(() => validatePolicy({ ...reviewed(flow), enabled: true }, flow), {
    code: 'invalid_rule',
  });
});

test('actual tool exploration exports a domain candidate and generic replay uses current profile without submission', async () => {
  const { directory, rulesDir, registry } = await workspace();
  const { browser, page, tools } = await browserFixture(directory);
  try {
    await explore(tools);
    const candidate = buildCandidate({
      tools,
      taskId: 'synthetic',
      initialUrl: page.url(),
      initialProfile: profile,
    });
    assert.ok(candidate);
    assert.equal(candidate.signatureComplete, false);
    assert.equal(candidate.actualSubmitted, false);
    assert.equal(candidate.flow.variants[0].steps.at(-1).action, 'finish');
    assert.ok(!JSON.stringify(candidate).includes(profile.email));
    assert.ok(!JSON.stringify(candidate).includes(profile.title));
    validateFlow(candidate.flow, host);
    const nextProfile = {
      ...profile,
      title: 'Another Synthetic Company',
      email: 'another@example.invalid',
    };
    await writeRule(rulesDir, candidate.flow, candidate.policy);
    await page.reload();
    assert.equal((await registry.select(await observePage(page), nextProfile)).source, 'agent');
    await writeRule(rulesDir, candidate.flow);
    const route = await registry.select(await observePage(page), nextProfile);
    assert.equal(route.source, 'adapter');
    const result = await executeRule({
      route,
      registry,
      page,
      profile: nextProfile,
      directory,
      demo: true,
    });
    assert.equal(result.modelCalls, 0);
    assert.ok(result.checks.every((check) => check.matches));
    assert.equal(await page.locator('#mail').inputValue(), nextProfile.email);
    assert.equal(await page.evaluate(() => window.submissionCount), 0);
    assert.ok((await readFile(path.join(directory, 'pre-submit.png'))).length);
    const snapshot = JSON.parse(await readFile(path.join(directory, 'rule-snapshot.json'), 'utf8'));
    assert.equal(snapshot.revision, result.ruleRevision);
  } finally {
    await browser.close();
  }
});

test('a rule change between actions stops before the next fill', async () => {
  const { directory, rulesDir, registry } = await workspace();
  const { browser, page, tools } = await browserFixture(directory);
  try {
    await explore(tools);
    const candidate = buildCandidate({
      tools,
      taskId: 'synthetic',
      initialUrl: page.url(),
      initialProfile: profile,
    });
    await writeRule(rulesDir, candidate.flow);
    await page.reload();
    const route = await registry.select(await observePage(page), profile);
    await assert.rejects(
      executeRule({
        route,
        registry,
        page,
        profile: { ...profile },
        directory,
        demo: true,
        onProgress: async () => {
          await writeFile(
            path.join(rulesDir, host, 'policy.json'),
            JSON.stringify({
              ...reviewed(candidate.flow),
              preparationReviews: [],
            }),
          );
        },
      }),
      { code: 'rule_changed' },
    );
    assert.equal(await page.locator('#tax').inputValue(), '');
    assert.equal(await page.evaluate(() => window.submissionCount), 0);
  } finally {
    await browser.close();
  }
});

test('incomplete exploration cannot create a candidate, and mismatched replay fills nothing', async () => {
  const { directory, rulesDir, registry } = await workspace();
  const { browser, page, tools } = await browserFixture(directory);
  try {
    assert.equal(
      buildCandidate({
        tools,
        taskId: 'synthetic',
        initialUrl: page.url(),
        initialProfile: profile,
      }),
      null,
    );
    await explore(tools);
    const candidate = buildCandidate({
      tools,
      taskId: 'synthetic',
      initialUrl: page.url(),
      initialProfile: profile,
    });
    await writeRule(rulesDir, candidate.flow);
    await page.reload();
    const route = await registry.select(await observePage(page), profile);
    await page.locator('#tax').evaluate((node) => node.setAttribute('aria-required', 'false'));
    await page.locator('label[for=tax]').evaluate((node) => {
      node.textContent = '新的必填字段';
    });
    await assert.rejects(
      executeRule({ route, registry, page, profile: { ...profile }, directory, demo: true }),
      { code: 'rule_mismatch' },
    );
    assert.equal(await page.locator('#name').inputValue(), '');
  } finally {
    await browser.close();
  }
});

test('generic company lookup replay verifies page tax and keeps missing-tax profile scope', async () => {
  const { directory, rulesDir, registry } = await workspace();
  const content = await readFile(
    new URL('./fixtures/pages/invoice-company-demo.html', import.meta.url),
    'utf8',
  );
  const { browser, page, tools } = await browserFixture(directory, content);
  const initialProfile = { ...profile, title: '青禾合成科技有限公司', taxId: '' };
  tools.profile = { ...initialProfile };
  const act = async (name, predicate, args = {}) => {
    const observed = await tools.observe();
    const control = observed.frames.flatMap((frame) => frame.controls).find(predicate);
    await tools.dispatch(name, { elementRef: control.elementRef, ...args });
  };
  try {
    await act('invoice_open_choices', (c) => c.stableId === 'buyer');
    await act('invoice_fill', (c) => c.stableId === 'buyer', { valueRef: 'title' });
    await act('invoice_choose_company', (c) => c.role === 'option');
    await act('invoice_read_tax', (c) => c.stableId === 'credit');
    await act('invoice_fill', (c) => c.stableId === 'email', { valueRef: 'email' });
    await tools.dispatch('invoice_finish', {});
    const candidate = buildCandidate({
      tools,
      taskId: 'synthetic-tax',
      initialUrl: page.url(),
      initialProfile,
    });
    validateFlow(candidate.flow, host);
    assert.ok(!candidate.flow.variants[0].match.profileFields.includes('taxId'));
    assert.ok(!JSON.stringify(candidate).includes(initialProfile.title));
    assert.ok(!JSON.stringify(candidate).includes(profile.taxId));
    await writeRule(rulesDir, candidate.flow);
    await page.reload();
    let evidence;
    const replayProfile = { ...initialProfile };
    const route = await registry.select(await observePage(page), replayProfile);
    assert.equal(route.source, 'adapter');
    const result = await executeRule({
      route,
      registry,
      page,
      profile: replayProfile,
      directory,
      demo: true,
      onTaxVerified: async (value) => {
        evidence = value;
        return { taxId: value.taxId };
      },
    });
    assert.equal(evidence.taxId, profile.taxId);
    assert.equal(result.checks.find((check) => check.key === 'taxId').source, 'invoice_page');
    assert.equal(await page.evaluate(() => window.submissionCount), 0);
  } finally {
    await browser.close();
  }
});

test('generic native selection and multi-step replay preserve per-step screenshots', async () => {
  const { directory, rulesDir, registry } = await workspace();
  const content = await readFile(
    new URL('./fixtures/pages/invoice-agent-demo.html', import.meta.url),
    'utf8',
  );
  const { browser, page, tools } = await browserFixture(directory, content);
  const act = async (name, predicate, args = {}) => {
    const observed = await tools.observe();
    const control = observed.frames.flatMap((frame) => frame.controls).find(predicate);
    await tools.dispatch(name, { elementRef: control.elementRef, ...args });
  };
  try {
    await act('invoice_select', (c) => c.type === 'radio' && c.label === '企业', {
      option: 'company',
    });
    await act('invoice_fill', (c) => c.stableId === 'buyer', { valueRef: 'title' });
    await act('invoice_fill', (c) => c.stableId === 'credit', { valueRef: 'taxId' });
    await act('invoice_continue', (c) => c.stableId === 'next');
    await act('invoice_fill', (c) => c.stableId === 'delivery', { valueRef: 'email' });
    await tools.dispatch('invoice_finish', {});
    const candidate = buildCandidate({
      tools,
      taskId: 'synthetic-multistep',
      initialUrl: page.url(),
      initialProfile: profile,
    });
    assert.ok(
      candidate.flow.variants[0].steps.some((step) => step.action === 'continue' && step.target),
    );
    await writeRule(rulesDir, candidate.flow);
    await page.reload();
    const route = await registry.select(await observePage(page), profile);
    const result = await executeRule({
      route,
      registry,
      page,
      profile: { ...profile },
      directory,
      demo: true,
    });
    assert.ok(result.checks.every((check) => check.matches));
    assert.ok((await readFile(path.join(directory, 'step-0.png'))).length);
    assert.ok((await readFile(path.join(directory, 'pre-submit.png'))).length);
    assert.equal(await page.evaluate(() => window.submissionCount), 0);
  } finally {
    await browser.close();
  }
});

test('mid-flow mismatch preserves verified progress for Harness handoff', async () => {
  const { directory, rulesDir, registry } = await workspace();
  const { browser, page, tools } = await browserFixture(directory);
  try {
    await explore(tools);
    const candidate = buildCandidate({
      tools,
      taskId: 'synthetic-handoff',
      initialUrl: page.url(),
      initialProfile: profile,
    });
    const flow = candidate.flow;
    flow.variants[0].steps[1].contract = 'b'.repeat(64);
    flow.variants[0].steps[1].waitMs = 0;
    await writeRule(rulesDir, flow);
    await page.reload();
    const route = await registry.select(await observePage(page), profile);
    let handoff;
    await assert.rejects(
      executeRule({ route, registry, page, profile: { ...profile }, directory, demo: true }),
      (error) => {
        handoff = error.preparationTools;
        return error.code === 'rule_mismatch';
      },
    );
    assert.equal(handoff.checks.length, 1);
    assert.equal(handoff.checks[0].key, 'title');
    assert.equal(handoff.preparationSteps.length, 1);
    for (const [id, valueRef] of [
      ['tax', 'taxId'],
      ['mail', 'email'],
    ]) {
      const observed = await handoff.observe();
      const ref = observed.frames.flatMap((frame) => frame.controls).find((c) => c.stableId === id);
      await handoff.dispatch('invoice_fill', { elementRef: ref.elementRef, valueRef });
    }
    await handoff.dispatch('invoice_finish', {});
    assert.ok(handoff.result().checks.every((check) => check.matches));
    assert.equal(await page.evaluate(() => window.submissionCount), 0);
  } finally {
    await browser.close();
  }
});

test('screenshot failure cannot export a completed candidate', async () => {
  const { directory } = await workspace();
  const { browser, tools } = await browserFixture(directory);
  try {
    for (const [id, valueRef] of [
      ['name', 'title'],
      ['tax', 'taxId'],
      ['mail', 'email'],
    ]) {
      const observed = await tools.observe();
      const ref = observed.frames.flatMap((frame) => frame.controls).find((c) => c.stableId === id);
      await tools.dispatch('invoice_fill', { elementRef: ref.elementRef, valueRef });
    }
    tools.capture = async () => {
      throw new Error('Synthetic screenshot failure');
    };
    await assert.rejects(tools.dispatch('invoice_finish', {}), /screenshot failure/);
    assert.equal(tools.finished, false);
    assert.equal(
      buildCandidate({
        tools,
        taskId: 'synthetic-failed-shot',
        initialUrl: tools.page.url(),
        initialProfile: profile,
      }),
      null,
    );
  } finally {
    await browser.close();
  }
});
