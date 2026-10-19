import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const supportedVersion = '0.2.1-alpha.4';
const original = `const child = spawn(this.runtime.command, this.runtime.args, {
\t\t\tcwd: this.runtime.cwd,`;
const patched = `const child = spawn(this.runtime.command, this.runtime.args, {
\t\t\twindowsHide: true,
\t\t\tcwd: this.runtime.cwd,`;

export function patchHarnessSource(source) {
  if (source.includes(patched)) return source;
  if (source.split(original).length !== 2)
    throw new Error('Harness SDK spawn code changed; review the Windows background launch patch');
  return source.replace(original, patched);
}

export async function patchHarnessWindows() {
  const manifestPath = fileURLToPath(
    import.meta.resolve('@deepseek-ai/dsh-sdk-client/package.json'),
  );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== supportedVersion)
    throw new Error('Harness SDK version changed; review the Windows background launch patch');
  const file = path.join(path.dirname(manifestPath), 'lib', 'index.js');
  const source = await readFile(file, 'utf8');
  const updated = patchHarnessSource(source);
  if (source === updated) return false;
  // The SDK has no public spawn-options hook. Keep this one-line patch scoped
  // to its pinned transport, preserving stdio, environment and disposal.
  const temporary = `${file}.invoice-windows.tmp`;
  await writeFile(temporary, updated);
  await rename(temporary, file);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = await patchHarnessWindows();
  console.log(
    changed
      ? 'Harness background launch patch applied'
      : 'Harness background launch patch verified',
  );
}
