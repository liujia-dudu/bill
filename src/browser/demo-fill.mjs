import { digest, fieldNames } from '../core/validation.mjs';

export async function fillDemo(page, profile, step) {
  await step('选择购买方类型', () =>
    page.locator(`input[name=buyerType][value=${profile.type}]`).check(),
  );
  const fields = [
    'title',
    ...(profile.type === 'enterprise' ? ['taxId'] : []),
    'email',
    ...(profile.phone ? ['phone'] : []),
  ];
  const checks = [];
  for (const key of fields) {
    const input = page.locator(`[name=${key}]`);
    await step(`填写${fieldNames[key]}`, () => input.fill(profile[key]));
    await input.blur();
    const actual = await input.inputValue();
    checks.push({
      key,
      label: fieldNames[key],
      expected: profile[key],
      actual,
      matches: actual === profile[key],
      locator: `[name=${key}]`,
    });
  }
  return {
    checks,
    signature: digest({ platform: 'demo', type: profile.type }),
    coverageGaps: ['本地合成演示，不代表商家平台受理', '真实提交及服务端校验未验证'],
    transaction: { merchant: '青禾小馆（演示）', orderId: 'DEMO-001', amount: '268.00' },
  };
}
