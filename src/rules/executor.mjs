import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InvoiceBrowserTools } from '../agent/browser-tools.mjs';
import { observePage } from '../browser/observe.mjs';
import { AppError, fieldNames } from '../core/validation.mjs';
import { companyNameKey, pageCompanyCandidate } from '../core/tax-id.mjs';
import { pageContract } from './contract.mjs';
import { ruleActions } from './schema.mjs';

const mismatch = () => new AppError('规则与当前页面或控件不一致，需重新分析', 400, 'rule_mismatch');
function expand(text, profile) {
  return text.replace(/\[profile\.([a-zA-Z]+)\]/g, (_token, key) => {
    if (!Object.hasOwn(fieldNames, key) || !profile[key]) throw mismatch();
    return profile[key];
  });
}
function findTarget(tools, step, profile) {
  let matches = [...tools.refs.entries()].filter(
    ([, ref]) =>
      ref.frameIndex === step.target.frameIndex &&
      ref.control.visible &&
      ref.control.enabled &&
      Object.entries(step.target.identity).every(
        ([key, value]) => ref.identity[key] === expand(value, profile),
      ) &&
      (step.target.text === undefined || ref.control.text === expand(step.target.text, profile)),
  );
  if (step.action === 'choose_company') {
    matches = matches.filter(([, ref]) => {
      const company = pageCompanyCandidate(ref.control.text);
      return (
        company &&
        companyNameKey(company.title) === companyNameKey(profile.title) &&
        (!company.taxId || !profile.taxId || company.taxId === profile.taxId)
      );
    });
    const exactTax =
      profile.taxId &&
      matches.filter(([, ref]) => pageCompanyCandidate(ref.control.text)?.taxId === profile.taxId);
    if (exactTax?.length) matches = exactTax;
  }
  return matches.length === 1 ? matches[0][0] : null;
}

export async function executeRule({
  route,
  registry,
  page,
  profile,
  directory,
  check = () => {},
  ...options
}) {
  const { rule, variant } = route;
  await registry.assertUnchanged(rule);
  await writeFile(
    path.join(directory, 'rule-snapshot.json'),
    JSON.stringify(
      {
        domain: rule.domain,
        revision: rule.revision,
        flow: rule.flow,
        policy: rule.policy,
        variantId: variant.id,
        prepareOnly: true,
        actualSubmitted: false,
      },
      null,
      2,
    ),
  );
  const tools = new InvoiceBrowserTools({ page, profile, directory, check, ...options });
  try {
    for (const step of variant.steps) {
      const started = Date.now();
      let elementRef;
      for (;;) {
        check();
        await registry.assertUnchanged(rule);
        await tools.observe();
        const current = pageContract(await observePage(page), profile);
        elementRef = step.action === 'finish' ? null : findTarget(tools, step, profile);
        if (current === step.contract && (step.action === 'finish' || elementRef)) break;
        if (Date.now() - started >= (step.waitMs ?? 1500)) throw mismatch();
        await page.waitForTimeout(100);
      }
      await registry.assertUnchanged(rule);
      check();
      await tools.dispatch(ruleActions[step.action], {
        ...(elementRef ? { elementRef } : {}),
        ...(step.valueRef ? { valueRef: step.valueRef } : {}),
        ...(step.option ? { option: expand(step.option, profile) } : {}),
      });
    }
    await registry.assertUnchanged(rule);
  } catch (error) {
    error.preparationTools = tools;
    throw error;
  }
  return {
    ...tools.result(),
    executionSource: 'adapter',
    signature: route.signature,
    signatureComplete: true,
    modelCalls: 0,
    ruleDomain: rule.domain,
    ruleId: rule.flow.id,
    ruleVariant: variant.id,
    ruleRevision: rule.revision,
    coverageGaps: ['仅复用已审核的填写流程，未真实提交，平台受理及真实证据尚未验证'],
  };
}
