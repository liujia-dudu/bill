import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactProfile } from '../agent/browser-tools.mjs';
import {
  domainName,
  flowDigest,
  profileFields,
  RULE_SCHEMA_VERSION,
  captureParameters,
  validateFlow,
} from './schema.mjs';

export function buildCandidate({ tools, taskId, initialUrl, initialProfile, engine = 'normal' }) {
  const url = new URL(initialUrl);
  if (!tools.finished || !domainName(url.hostname)) return null;
  const variant = {
    id: 'default',
    engine,
    match: {
      protocol: url.protocol,
      port: url.port,
      pathPrefix: url.pathname,
      hashPrefix: url.hash.split('?')[0],
      parameters: captureParameters(url),
      buyerType: initialProfile.type,
      profileFields: profileFields(initialProfile),
    },
    steps: redactProfile(tools.preparationSteps, tools.profile),
  };
  const flow = {
    schemaVersion: RULE_SCHEMA_VERSION,
    id: url.hostname,
    hosts: [url.hostname],
    variants: [variant],
  };
  try {
    validateFlow(flow, url.hostname);
  } catch {
    return null;
  }
  return {
    sourceTaskId: taskId,
    domain: url.hostname,
    flowDigest: flowDigest(flow),
    enabled: false,
    reviewRequired: true,
    signatureComplete: false,
    actualSubmitted: false,
    flow,
    policy: { enabled: false, minSupervisedSuccess: 1, evidenceRefs: [], preparationReviews: [] },
    coverageGaps: [
      '页面契约摘要不等于完整协议及参数审核',
      '仅为探索候选，需人工核定范围并验证固定填写，不自动生效',
    ],
  };
}
export async function saveCandidate({ dataDir, ...args }) {
  const candidate = buildCandidate(args);
  if (!candidate) return null;
  const directory = path.join(dataDir, 'adapters', 'candidates');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${args.taskId}.json`), JSON.stringify(candidate, null, 2));
  return candidate;
}
