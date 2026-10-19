import { AppError, digest, fieldNames } from '../core/validation.mjs';

export const RULE_SCHEMA_VERSION = 1;
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

function validateParameters(parameters) {
  if (
    !keys(parameters, ['query', 'hashQuery']) ||
    !object(parameters.query) ||
    !object(parameters.hashQuery)
  )
    return false;
  return [parameters.query, parameters.hashQuery].every((group) =>
    Object.values(group).every(
      (parameter) =>
        keys(parameter, ['kind', 'values']) &&
        (parameter.kind === 'transaction'
          ? parameter.values === undefined
          : parameter.kind === 'exact' &&
            Array.isArray(parameter.values) &&
            parameter.values.length > 0 &&
            parameter.values.every((value) => typeof value === 'string' && value.length <= 8192)),
    ),
  );
}

export function captureParameters(url) {
  const capture = (params) =>
    Object.fromEntries(
      [...new Set(params.keys())].map((key) => [
        key,
        { kind: 'exact', values: params.getAll(key) },
      ]),
    );
  return {
    query: capture(url.searchParams),
    hashQuery: capture(
      new URLSearchParams(url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : ''),
    ),
  };
}

export function parametersMatch(url, parameters) {
  const current = captureParameters(url);
  return ['query', 'hashQuery'].every((kind) => {
    const expected = parameters[kind],
      actual = current[kind];
    if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(Object.keys(actual).sort()))
      return false;
    return Object.entries(expected).every(([key, parameter]) =>
      parameter.kind === 'transaction'
        ? actual[key].values.length === 1 && actual[key].values[0].length > 0
        : JSON.stringify(parameter.values) === JSON.stringify(actual[key].values),
    );
  });
}

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

export function validateFlow(flow, domain) {
  if (
    !keys(flow, ['schemaVersion', 'id', 'hosts', 'variants']) ||
    flow.schemaVersion !== RULE_SCHEMA_VERSION ||
    !text(flow.id) ||
    !Array.isArray(flow.hosts) ||
    !flow.hosts.length ||
    !flow.hosts.every(domainName) ||
    !flow.hosts.includes(domain) ||
    !Array.isArray(flow.variants) ||
    !flow.variants.length
  )
    fail('规则必须包含版本、域名和流程变体');
  const ids = new Set();
  for (const variant of flow.variants) {
    if (
      !keys(variant, ['id', 'match', 'engine', 'steps']) ||
      !text(variant.id) ||
      ids.has(variant.id) ||
      !['normal', 'light'].includes(variant.engine)
    )
      fail('流程变体标识或引擎无效');
    ids.add(variant.id);
    const match = variant.match;
    if (
      !keys(match, [
        'protocol',
        'port',
        'pathPrefix',
        'hashPrefix',
        'parameters',
        'buyerType',
        'profileFields',
      ]) ||
      !['https:', 'http:'].includes(match.protocol) ||
      typeof match.port !== 'string' ||
      (match.port !== '' && !/^\d{1,5}$/.test(match.port)) ||
      typeof match.pathPrefix !== 'string' ||
      !match.pathPrefix.startsWith('/') ||
      typeof match.hashPrefix !== 'string' ||
      (match.hashPrefix && !match.hashPrefix.startsWith('#')) ||
      !['enterprise', 'personal'].includes(match.buyerType) ||
      !validateParameters(match.parameters) ||
      !Array.isArray(match.profileFields) ||
      !match.profileFields.every((key) => Object.hasOwn(fieldNames, key)) ||
      new Set(match.profileFields).size !== match.profileFields.length
    )
      fail('流程必须明确入口、购买方类型和资料字段范围');
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
  }
  return flow;
}

export function validatePolicy(policy, flow) {
  if (
    !keys(policy, ['enabled', 'minSupervisedSuccess', 'evidenceRefs', 'preparationReviews']) ||
    policy.enabled !== false ||
    !Number.isInteger(policy.minSupervisedSuccess) ||
    policy.minSupervisedSuccess < 1 ||
    !Array.isArray(policy.evidenceRefs) ||
    !policy.evidenceRefs.every(text) ||
    !Array.isArray(policy.preparationReviews)
  )
    fail('当前仅允许填写测试配置，真实提交不能启用');
  for (const review of policy.preparationReviews) {
    if (
      !keys(review, [
        'variantId',
        'flowDigest',
        'reviewedAt',
        'signatureComplete',
        'protocolReviewed',
        'agreementVerified',
      ]) ||
      !flow.variants.some((variant) => variant.id === review.variantId) ||
      !signature(review.flowDigest) ||
      !text(review.reviewedAt) ||
      !Number.isFinite(Date.parse(review.reviewedAt)) ||
      !['signatureComplete', 'protocolReviewed', 'agreementVerified'].every(
        (key) => typeof review[key] === 'boolean',
      )
    )
      fail('填写审核记录无效');
  }
  return policy;
}

export const flowDigest = (flow) => digest(flow);
export const profileFields = (profile) =>
  Object.keys(fieldNames)
    .filter((key) => profile[key])
    .sort();
export function preparationReviewed(rule, variant) {
  return rule.policy.preparationReviews.some(
    (review) =>
      review.variantId === variant.id &&
      review.flowDigest === flowDigest(rule.flow) &&
      review.signatureComplete &&
      review.protocolReviewed &&
      review.agreementVerified,
  );
}
