import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactProfile } from '../agent/browser-tools.mjs';
import { domainName, profileFields, validateVariant } from './schema.mjs';
import { recordKey } from './registry.mjs';

export const PENDING_FILE = 'learned-steps.json';

// The steps of a completed fill, redacted to profile references. They stay with the
// task until the user's reply decides whether they become a hint or a trusted record.
export function buildPending({ tools, taskId, initialUrl, initialProfile, engine = 'normal' }) {
  if (!tools.finished) return null;
  const key = recordKey(initialUrl);
  if (!domainName(key.host)) return null;
  const pending = {
    key,
    buyerType: initialProfile.type,
    engine,
    profileFields: profileFields(initialProfile),
    steps: redactProfile(tools.preparationSteps, tools.profile),
    sourceTaskId: taskId,
  };
  const { key: _key, buyerType: _buyerType, ...variant } = pending;
  try {
    validateVariant({ ...variant, level: 'hint', learnedAt: 'pending' });
  } catch {
    return null;
  }
  return pending;
}
export async function savePending({ directory, ...args }) {
  const pending = buildPending(args);
  if (pending)
    await writeFile(path.join(directory, PENDING_FILE), JSON.stringify(pending, null, 2));
  return pending;
}
export async function readPending(directory) {
  try {
    return JSON.parse(await readFile(path.join(directory, PENDING_FILE), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
