import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppError, digest } from '../core/validation.mjs';
import {
  domainName,
  validateFlow,
  validatePolicy,
  preparationReviewed,
  profileFields,
  parametersMatch,
} from './schema.mjs';
import { pageContract } from './contract.mjs';

export const defaultRulesDirectory = fileURLToPath(new URL('../adapters/', import.meta.url));
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};
export class RuleRegistry {
  constructor(directory = defaultRulesDirectory) {
    this.directory = path.resolve(directory);
  }
  async read(domain) {
    if (!domainName(domain)) throw new AppError('规则目录必须以完整域名命名', 400, 'invalid_rule');
    const root = await realpath(this.directory);
    const directory = path.join(root, domain);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new AppError('规则目录不能使用链接', 400, 'invalid_rule');
    const contents = [];
    for (const name of ['flow.json', 'policy.json']) {
      const file = path.join(directory, name);
      const fileStat = await lstat(file);
      if (!fileStat.isFile() || fileStat.size > 1024 * 1024 || !inside(root, await realpath(file)))
        throw new AppError('规则文件必须位于规则目录内', 400, 'invalid_rule');
      contents.push(await readFile(file, 'utf8'));
    }
    const flow = validateFlow(JSON.parse(contents[0]), domain);
    const policy = validatePolicy(JSON.parse(contents[1]), flow);
    return { domain, flow, policy, revision: digest(contents) };
  }
  async inspect() {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return { rules: [], problems: [] };
      throw error;
    }
    const rules = [],
      problems = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        if (
          entry.isDirectory() &&
          (await readdir(path.join(this.directory, entry.name))).length === 0
        )
          continue;
        rules.push(await this.read(entry.name));
      } catch (error) {
        problems.push({ domain: entry.name, code: error.code || 'invalid_rule' });
      }
    }
    return { rules, problems };
  }
  async select(observation, profile, engine = 'normal') {
    const url = new URL(observation.url);
    const { rules, problems } = await this.inspect();
    const sites = rules.filter((rule) => rule.flow.hosts.includes(url.hostname));
    const currentSignature = pageContract(observation, profile);
    const candidates = [];
    const fields = profileFields(profile);
    for (const rule of sites)
      for (const variant of rule.flow.variants) {
        const match = variant.match;
        if (
          variant.engine === engine &&
          url.protocol === match.protocol &&
          url.port === match.port &&
          url.pathname.startsWith(match.pathPrefix) &&
          parametersMatch(url, match.parameters) &&
          url.hash.startsWith(match.hashPrefix) &&
          match.buyerType === profile.type &&
          JSON.stringify([...match.profileFields].sort()) === JSON.stringify(fields) &&
          preparationReviewed(rule, variant) &&
          variant.steps[0].contract === currentSignature
        )
          candidates.push({ rule, variant });
      }
    if (candidates.length !== 1)
      return {
        source: 'agent',
        reason:
          candidates.length > 1
            ? 'ambiguous_rules'
            : sites.length
              ? 'contract_not_verified'
              : problems.some((problem) => problem.domain === url.hostname)
                ? 'invalid_rule'
                : 'new_page',
        signature: currentSignature,
        problems,
      };
    return {
      source: 'adapter',
      reason: 'verified_contract',
      signature: currentSignature,
      ...candidates[0],
    };
  }
  async assertUnchanged(snapshot) {
    try {
      const current = await this.read(snapshot.domain);
      if (
        current.revision === snapshot.revision &&
        digest(current.flow) === digest(snapshot.flow) &&
        digest(current.policy) === digest(snapshot.policy)
      )
        return;
    } catch {}
    throw new AppError('执行期间规则已修改、停用或删除，请重新准备', 409, 'rule_changed');
  }
}
