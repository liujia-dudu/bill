import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const secretPatterns = [
  ['API key', /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  [
    'literal credential',
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"][^'"\r\n]{12,}['"]/gi,
  ],
];

export function privatePath(filename) {
  const name = filename.replaceAll('\\', '/');
  const base = path.posix.basename(name);
  return (
    /^(?:data|diagnostics|test-results|dist|coverage)\//i.test(name) ||
    /(?:^|\/)(?:node_modules|__pycache__|\.venv|venv|\.git)\//i.test(name) ||
    (base.startsWith('.env') && base !== '.env.example') ||
    /api[_-]?key.*\.csv(?:\.bak)?$/i.test(base) ||
    /^(?:\.npmrc|\.pypirc|\.netrc|credentials\.json|service-account.*\.json)$/i.test(base) ||
    /\.(?:pem|key|p12|pfx|sqlite(?:-.*)?|db(?:-.*)?|log|har)$/i.test(base) ||
    /^docs\/INVOICE_(?:CASES|URLS)\.md$/i.test(name)
  );
}

export function scanContent(filename, content, localSecrets = []) {
  const findings = [];
  for (const [reason, pattern] of secretPatterns) {
    for (const match of content.matchAll(pattern)) {
      findings.push({
        filename,
        line: content.slice(0, match.index).split('\n').length,
        reason,
      });
    }
  }
  for (const { name, value } of localSecrets) {
    if (content.includes(value)) findings.push({ filename, reason: `local ${name}` });
  }
  for (const match of content.matchAll(/(?:https?|wss?):\/\/[^\s"'<>`]+/g)) {
    try {
      const url = new URL(match[0]);
      // Deliberately invalid credentials used by the URL validation regression.
      if (match[0] === 'https://u:p@example.com') continue;
      if (url.username || url.password)
        findings.push({ filename, reason: 'URL contains credentials' });
    } catch {}
  }
  return findings;
}

export function checkPublish({ staged = false, root = ROOT } = {}) {
  const git = (args, options = {}) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options });
  const filenames = git(
    staged
      ? ['ls-files', '--cached', '-z']
      : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  )
    .split('\0')
    .filter(Boolean);
  const envFile = path.join(root, '.env');
  const localSecrets = existsSync(envFile)
    ? Object.entries(parseEnv(readFileSync(envFile, 'utf8')))
        .filter(
          ([name, value]) =>
            /KEY|TOKEN|SECRET|PASSWORD|PROJECT_ID|BASE_URL/i.test(name) && value.length >= 8,
        )
        .map(([name, value]) => ({ name, value }))
    : [];
  const findings = [];
  for (const filename of filenames) {
    if (privatePath(filename)) {
      findings.push({ filename, reason: 'private or generated file' });
      continue;
    }
    const bytes = staged
      ? git(['show', `:${filename}`], { encoding: 'buffer' })
      : readFileSync(path.join(root, filename));
    if (bytes.length > 1024 * 1024)
      findings.push({ filename, reason: 'file exceeds 1 MB; review before publishing' });
    if (bytes.includes(0)) {
      if (!/^tests\/fixtures\/.+\.(?:png|jpe?g|webp)$/i.test(filename))
        findings.push({ filename, reason: 'unexpected binary file' });
      continue;
    }
    findings.push(...scanContent(filename, bytes.toString('utf8'), localSecrets));
  }
  return { staged, files: filenames.length, localValuesChecked: localSecrets.length, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkPublish({ staged: process.argv.includes('--staged') });
  // Never print matched values or file contents, even on a failed check.
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.findings.length ? 1 : 0;
}
