import { AppError, fieldNames } from '../core/validation.mjs';

export const RULE_SCHEMA_VERSION = 2;
export const identityKeys = [
  'tag',
  'type',
  'role',
  'label',
  'context',
  'placeholder',
  'name',
  'stableId',
];
export const ruleActions = {
  fill: 'invoice_fill',
  select: 'invoice_select',
  open_choices: 'invoice_open_choices',
  choose_company: 'invoice_choose_company',
  query_company: 'invoice_query_company',
  read_tax: 'invoice_read_tax',
  continue: 'invoice_continue',
  finish: 'invoice_finish',
};
const signature = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 2000;
const keys = (value, allowed) =>
  object(value) && Object.keys(value).every((key) => allowed.includes(key));
const fail = (message) => {
  throw new AppError(message, 400, 'invalid_rule');
};

export function domainName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9.-]+$/.test(value) || !value.includes('.'))
    return false;
  return (
    value.length <= 253 &&
    value
      .split('.')
      .every(
        (part) =>
          part.length > 0 && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part),
      )
  );
}

// A learned variant is the replayable record of one buyer type on one host + path.
export function validateVariant(variant) {
  if (
    !keys(variant, [
      'level',
      'engine',
      'profileFields',
      'steps',
      'sourceTaskId',
      'learnedAt',
      'revision',
    ]) ||
    !['hint', 'trusted'].includes(variant.level) ||
    !['normal', 'light'].includes(variant.engine) ||
    !text(variant.sourceTaskId) ||
    !text(variant.learnedAt) ||
    (variant.revision !== undefined && !signature(variant.revision)) ||
    !Array.isArray(variant.profileFields) ||
    !variant.profileFields.every((key) => Object.hasOwn(fieldNames, key)) ||
    new Set(variant.profileFields).size !== variant.profileFields.length
  )
    fail('记录必须明确可信级别、引擎和资料字段范围');
  if (
    !Array.isArray(variant.steps) ||
    !variant.steps.length ||
    variant.steps.length > 100 ||
    variant.steps.at(-1)?.action !== 'finish'
  )
    fail('流程必须以填写校验和截图结束');
  for (const [index, step] of variant.steps.entries()) {
    if (
      !keys(step, ['action', 'target', 'valueRef', 'option', 'contract', 'waitMs']) ||
      !Object.hasOwn(ruleActions, step.action) ||
      !signature(step.contract) ||
      (step.waitMs !== undefined &&
        (!Number.isInteger(step.waitMs) || step.waitMs < 0 || step.waitMs > 5000))
    )
      fail('流程含未知动作或缺少页面契约');
    if (step.action === 'finish') {
      if (
        index !== variant.steps.length - 1 ||
        step.target !== undefined ||
        step.valueRef !== undefined ||
        step.option !== undefined
      )
        fail('结束动作不能定位或操作提交控件');
    } else {
      const target = step.target;
      if (
        !keys(target, ['frameIndex', 'identity', 'text']) ||
        !Number.isInteger(target.frameIndex) ||
        target.frameIndex < 0 ||
        target.frameIndex > 10 ||
        !keys(target.identity, identityKeys) ||
        !text(target.identity.tag) ||
        !Object.values(target.identity).every(
          (value) => typeof value === 'string' && value.length <= 2000,
        ) ||
        (target.text !== undefined && typeof target.text !== 'string')
      )
        fail('动作必须使用结构化控件特征，不能使用脚本或任意选择器');
    }
    if (step.action === 'fill') {
      if (!Object.hasOwn(fieldNames, step.valueRef) || step.option !== undefined)
        fail('填写只能引用用户资料字段');
    } else if (step.valueRef !== undefined) fail('非填写动作不能提供资料值');
    if (step.action === 'select') {
      if (!text(step.option)) fail('选择动作必须明确选项');
    } else if (step.option !== undefined) fail('非选择动作不能提供选项');
  }
  return variant;
}

export function validateRecord(record, key) {
  if (
    !keys(record, ['schemaVersion', 'host', 'path', 'hashPath', 'variants']) ||
    record.schemaVersion !== RULE_SCHEMA_VERSION ||
    record.host !== key.host ||
    record.path !== key.path ||
    record.hashPath !== key.hashPath ||
    !keys(record.variants, ['enterprise', 'personal'])
  )
    fail('记录必须与域名和路径一致');
  for (const variant of Object.values(record.variants)) validateVariant(variant);
  return record;
}

export const profileFields = (profile) =>
  Object.keys(fieldNames)
    .filter((key) => profile[key])
    .sort();
