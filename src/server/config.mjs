import { existsSync, mkdirSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
if (existsSync(path.join(ROOT, '.env'))) {
  const previous = { ...process.env };
  loadEnvFile(path.join(ROOT, '.env'));
  Object.assign(process.env, previous);
}
export function configuration(overrides = {}) {
  const dataDir = path.resolve(ROOT, process.env.INVOICE_AGENT_DATA_DIR || 'data');
  const config = {
    root: ROOT,
    dataDir,
    port: Number(process.env.INVOICE_AGENT_PORT || 3180),
    python: process.env.INVOICE_AGENT_PYTHON || 'python',
    ...overrides,
  };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
    throw new Error('Invalid port');
  for (const name of ['', 'uploads', 'artifacts', 'adapters', 'logs', 'tmp'])
    mkdirSync(path.join(config.dataDir, name), { recursive: true });
  return config;
}
