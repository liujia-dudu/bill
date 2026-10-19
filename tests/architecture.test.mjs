import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parsers } from 'prettier/plugins/babel';
import { ROOT } from '../src/server/config.mjs';

async function modules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map((entry) => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory()
        ? modules(filename)
        : entry.name.endsWith('.mjs')
          ? [filename]
          : [];
    }),
  );
  return groups.flat();
}

test('production modules are reachable and do not import test fixtures', async () => {
  const sourceRoot = path.join(ROOT, 'src');
  const filenames = await modules(sourceRoot);
  const graph = new Map();
  for (const filename of filenames) {
    const source = await readFile(filename, 'utf8');
    assert.equal(
      /tests[\\/]+fixtures/.test(source),
      false,
      `${path.relative(ROOT, filename)} depends on test data`,
    );
    const ast = await parsers.babel.parse(source);
    const imports = ast.program.body
      .filter((node) => node.type === 'ImportDeclaration')
      .map((node) => node.source.value)
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) => path.resolve(path.dirname(filename), specifier));
    for (const dependency of imports)
      assert.ok(filenames.includes(dependency), `Invalid production import in ${filename}`);
    graph.set(filename, imports);
  }
  // Harness loads its tool plugin by YAML, not through the server's import graph.
  const patch = await readFile(path.join(sourceRoot, 'agent/harness.patch.yml'), 'utf8');
  assert.ok(patch.includes('name: ./harness-plugin.mjs'));
  const pending = [
    path.join(sourceRoot, 'server/index.mjs'),
    path.join(sourceRoot, 'agent/harness-plugin.mjs'),
  ];
  const reachable = new Set();
  while (pending.length) {
    const filename = pending.pop();
    if (reachable.has(filename)) continue;
    reachable.add(filename);
    pending.push(...(graph.get(filename) || []));
  }
  assert.deepEqual(
    filenames
      .filter((filename) => !reachable.has(filename))
      .map((filename) => path.relative(ROOT, filename)),
    [],
  );
});
