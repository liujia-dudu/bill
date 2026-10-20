import { RuleRegistry } from '../src/rules/registry.mjs';
import { preparationReviewed } from '../src/rules/schema.mjs';
const { rules, problems } = await new RuleRegistry().inspect();
for (const problem of problems) console.log(`${problem.domain}: 规则无效 (${problem.code})`);
for (const rule of rules) {
  const reviewed = rule.flow.variants.filter((variant) =>
    preparationReviewed(rule, variant),
  ).length;
  console.log(
    `${rule.domain}: JSON 有效，已审核填写变体 ${reviewed}/${rule.flow.variants.length}；规则本身不能提交，提交只在用户对话确认后执行`,
  );
}
if (!rules.length && !problems.length)
  console.log('无正式网站规则；新页面由 Harness 分析；提交只在用户对话确认后执行');
process.exitCode = problems.length ? 1 : 0;
