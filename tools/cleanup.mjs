// Retention for local outputs that otherwise only grow. Runs before tests and on
// server start; never touches data/invoice.sqlite, samples, observations or .env.
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEEP = 3;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// "chat-e2e-1792480299238", "browser-engine-Ab12cd", "mzdp-update-20261016-152555" ->
// the kind of output, so retention counts runs of the same check together.
export function outputKind(name) {
  return name
    .replace(/\.[a-z]+$/i, '')
    .replace(/-\d{10,}$/, '')
    .replace(/-\d{8}(?:-\d{6})?$/, '')
    .replace(/-(?=[A-Za-z0-9]*[0-9A-Z])[A-Za-z0-9]{6}$/, '');
}

async function entries(directory) {
  const names = await readdir(directory).catch(() => []);
  return Promise.all(
    names.map(async (name) => {
      const full = path.join(directory, name);
      const info = await stat(full);
      return { name, path: full, mtime: info.mtimeMs, directory: info.isDirectory() };
    }),
  );
}

async function holdsDatabase(entry, depth = 2) {
  if (!entry.directory) return /\.sqlite$/.test(entry.name);
  if (depth === 0) return false;
  for (const child of await entries(entry.path))
    if (await holdsDatabase(child, depth - 1)) return true;
  return false;
}

async function findNodeModules(directory, found = [], depth = 3) {
  for (const entry of await entries(directory)) {
    if (!entry.directory) continue;
    if (entry.name === 'node_modules') found.push(entry.path);
    else if (depth > 0) await findNodeModules(entry.path, found, depth - 1);
  }
  return found;
}

const newestFirst = (a, b) => b.mtime - a.mtime;

export async function planCleanup(root, now = Date.now()) {
  const remove = [];
  const old = (entry) => now - entry.mtime > MAX_AGE_MS;

  // test-results: per kind keep the newest 3 from the last 7 days.
  const groups = new Map();
  for (const entry of await entries(path.join(root, 'test-results'))) {
    const kind = outputKind(entry.name);
    groups.set(kind, [...(groups.get(kind) || []), entry]);
  }
  for (const [kind, group] of groups)
    group.sort(newestFirst).forEach((entry, index) => {
      if (index >= KEEP || old(entry))
        remove.push({ path: entry.path, reason: `test-results ${kind}` });
    });

  // diagnostics: database backups are restore points, so keep the newest 3 at any age;
  // other investigation output goes after 7 days. node_modules can always be reinstalled.
  const diagnostics = path.join(root, 'diagnostics');
  const backups = [];
  for (const entry of await entries(diagnostics)) {
    if (await holdsDatabase(entry)) backups.push(entry);
    else if (old(entry)) remove.push({ path: entry.path, reason: 'diagnostics older than 7 days' });
  }
  backups
    .sort(newestFirst)
    .slice(KEEP)
    .forEach((entry) => remove.push({ path: entry.path, reason: 'diagnostics database backup' }));
  const removing = new Set(remove.map((item) => item.path));
  for (const modules of await findNodeModules(diagnostics))
    if (![...removing].some((parent) => modules.startsWith(parent + path.sep)))
      remove.push({ path: modules, reason: 'diagnostics node_modules' });

  // data/logs: plain age limit.
  for (const entry of await entries(path.join(root, 'data', 'logs')))
    if (entry.name !== 'cleanup.log' && old(entry))
      remove.push({ path: entry.path, reason: 'log older than 7 days' });
  return remove;
}

export async function runCleanup(root, { dryRun = false, now = Date.now() } = {}) {
  const plan = await planCleanup(root, now);
  if (dryRun || !plan.length) return plan;
  const logs = path.join(root, 'data', 'logs');
  await mkdir(logs, { recursive: true });
  const lines = [];
  for (const item of plan) {
    const relative = path.relative(root, item.path);
    try {
      await rm(item.path, { recursive: true, force: true, maxRetries: 3 });
      lines.push(`${new Date(now).toISOString()} removed ${relative} (${item.reason})`);
    } catch (error) {
      lines.push(`${new Date(now).toISOString()} failed ${relative}: ${error.message}`);
    }
  }
  await appendFile(path.join(logs, 'cleanup.log'), lines.join('\n') + '\n');
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dryRun = process.argv.includes('--dry-run');
  try {
    const plan = await runCleanup(root, { dryRun });
    if (dryRun)
      for (const item of plan) console.log(`${path.relative(root, item.path)}  (${item.reason})`);
    console.log(`cleanup: ${dryRun ? 'would remove' : 'removed'} ${plan.length} item(s)`);
  } catch (error) {
    // Housekeeping must never block tests or the server from starting.
    console.error(`cleanup skipped: ${error.message}`);
  }
}
