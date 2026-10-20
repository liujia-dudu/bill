import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { patchHarnessSource, patchHarnessWindows } from '../tools/patch-harness-windows.mjs';

test('pinned Harness Windows patch is idempotent and refuses changed spawn code', async () => {
  const original = `const child = spawn(this.runtime.command, this.runtime.args, {
\t\t\tcwd: this.runtime.cwd,`;
  const patched = patchHarnessSource(original);
  assert.ok(patched.includes('windowsHide: true'));
  assert.equal(patchHarnessSource(patched), patched);
  assert.throws(() => patchHarnessSource('unknown SDK code'), /spawn code changed/);
  assert.throws(() => patchHarnessSource(original + original), /spawn code changed/);
  await patchHarnessWindows();
  assert.equal(await patchHarnessWindows(), false);
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const script of ['postinstall', 'predev', 'prestart'])
    assert.match(manifest.scripts[script], /^node tools\/patch-harness-windows\.mjs(?: && |$)/);
});

test('actual SDK transport launches hidden with piped stdio and closes its child', async (t) => {
  await patchHarnessWindows();
  const actualSpawn = childProcess.spawn;
  const launches = [];
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    const child = actualSpawn(command, args, options);
    launches.push({ command, args, options, child });
    return child;
  });
  syncBuiltinESMExports();
  const { HarnessClient } = await import('@deepseek-ai/dsh-sdk-client');
  const client = new HarnessClient({
    dshBin: fileURLToPath(new URL('./fixtures/harness-runtime.mjs', import.meta.url)),
    processCwd: process.cwd(),
    env: { ...process.env, INVOICE_SYNTHETIC_PROCESS_TEST: '1' },
    initializeTimeoutMs: 3000,
    requestTimeoutMs: 3000,
    shutdownTimeoutMs: 1000,
    disposeEofGraceMs: 1000,
  });
  try {
    const result = await client.initialize({ cwd: process.cwd() });
    assert.equal(result.serverInfo.name, 'synthetic-harness');
    assert.equal(launches.length, 1);
    const launch = launches[0];
    assert.equal(launch.command, process.execPath);
    assert.equal(launch.options.windowsHide, true);
    assert.deepEqual(launch.options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.ok(!launch.options.shell);
    assert.equal(launch.options.env.INVOICE_SYNTHETIC_PROCESS_TEST, '1');
    assert.equal(await client.getWorkingDirectory('synthetic-session'), process.cwd());
    await client.close();
    assert.ok(launch.child.exitCode !== null || launch.child.signalCode !== null);
  } finally {
    await client.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
