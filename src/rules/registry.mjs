import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, digest } from '../core/validation.mjs';
import { domainName, profileFields, RULE_SCHEMA_VERSION, validateRecord } from './schema.mjs';
import { pageContract } from './contract.mjs';

// Records are keyed by host + path (and hash route); query parameters such as order
// numbers never take part, so a new QR code for the same page finds the same record.
export function recordKey(value) {
  const url = new URL(value);
  return { host: url.hostname, path: url.pathname, hashPath: url.hash.split('?')[0] };
}

export class RuleRegistry {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.writing = Promise.resolve();
  }
  file(key) {
    if (!domainName(key.host)) throw new AppError('记录必须以完整域名索引', 400, 'invalid_rule');
    return path.join(
      this.directory,
      key.host,
      `${digest({ path: key.path, hashPath: key.hashPath }).slice(0, 24)}.json`,
    );
  }
  async read(key) {
    let content;
    try {
      content = await readFile(this.file(key), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return validateRecord(JSON.parse(content), key);
  }
  async select(observation, profile, engine = 'normal') {
    const key = recordKey(observation.url);
    const signature = pageContract(observation, profile);
    let record;
    try {
      record = await this.read(key);
    } catch {
      return { source: 'agent', reason: 'invalid_rule', signature, key };
    }
    const variant = record?.variants[profile.type];
    if (!variant) return { source: 'agent', reason: 'new_page', signature, key };
    const learned = {
      key,
      buyerType: profile.type,
      revision: variant.revision,
      level: variant.level,
    };
    if (
      variant.level === 'trusted' &&
      variant.engine === engine &&
      JSON.stringify(variant.profileFields) === JSON.stringify(profileFields(profile)) &&
      variant.steps[0].contract === signature
    )
      return { source: 'adapter', reason: 'trusted_record', signature, key, variant, learned };
    return {
      source: 'agent',
      reason: variant.level === 'trusted' ? 'record_not_matched' : 'hint_record',
      hint: variant.steps,
      signature,
      key,
      learned,
    };
  }
  // Serialised so concurrent decisions on the same page cannot lose a write.
  update(key, change) {
    const run = this.writing.then(async () => {
      let record;
      try {
        record = await this.read(key);
      } catch {
        record = null;
      }
      record ||= { schemaVersion: RULE_SCHEMA_VERSION, ...key, variants: {} };
      const result = change(record);
      const file = this.file(key);
      if (!Object.keys(record.variants).length && !record.entry) await rm(file, { force: true });
      else {
        validateRecord(record, key);
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(record, null, 2));
        await rename(temporary, file);
      }
      return result;
    });
    this.writing = run.catch(() => {});
    return run;
  }
  // A trusted record is replaced by any newer trusted one, but never downgraded by a hint.
  learn(pending, level) {
    const { key, buyerType, ...variant } = pending;
    return this.update(key, (record) => {
      const existing = record.variants[buyerType];
      if (level === 'hint' && existing?.level === 'trusted') return null;
      const learnedAt = new Date().toISOString();
      const next = { ...variant, level, learnedAt };
      next.revision = digest(next);
      record.variants[buyerType] = next;
      return next.revision;
    });
  }
  // Entries that a browser cannot handle (WeChat/app only), keyed by the entry URL's
  // host + path so the next QR code for it is answered without opening a browser.
  async entry(url) {
    try {
      return (await this.read(recordKey(url)))?.entry || null;
    } catch {
      return null;
    }
  }
  rememberEntry(url, outcome, taskId) {
    return this.update(recordKey(url), (record) => {
      record.entry = {
        status: outcome.status,
        reasonCode: outcome.reasonCode,
        message: outcome.message,
        source: 'page',
        sourceTaskId: taskId,
        learnedAt: new Date().toISOString(),
      };
    });
  }
  forgetEntry(url) {
    return this.update(recordKey(url), (record) => {
      delete record.entry;
    });
  }
  // Only the record this task used or produced is dropped; a newer one from another
  // task stays.
  discard(key, buyerType, revisions) {
    return this.update(key, (record) => {
      const existing = record.variants[buyerType];
      if (!existing || !revisions.includes(existing.revision)) return false;
      delete record.variants[buyerType];
      return true;
    });
  }
}
