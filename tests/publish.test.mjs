import test from 'node:test';
import assert from 'node:assert/strict';
import { privatePath, scanContent } from '../tools/check-publish.mjs';

test('publication check blocks private inputs and nested credential exports', () => {
  for (const filename of [
    '.env',
    '.env.production',
    'backup/.env.local',
    'exports/provider-apiKey-123.csv',
    'exports/provider-API_KEY.CSV',
    'data/invoice.sqlite',
    'diagnostics/report.json',
    'test-results/screenshot.png',
    'docs/INVOICE_URLS.md',
    '.npmrc',
    'nested/private.pem',
    'invoice.sqlite-wal',
    'traffic.har',
  ])
    assert.equal(privatePath(filename), true, filename);
  for (const filename of [
    '.env.example',
    'src/agent/model-config.mjs',
    'tests/fixtures/qr/demo.png',
  ])
    assert.equal(privatePath(filename), false, filename);
});

test('publication check detects secrets without returning their values', () => {
  const api = ['sk', 'a'.repeat(32)].join('-');
  const token = ['github', 'pat', 'b'.repeat(32)].join('_');
  const privateKey = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const local = 'local-' + 'c'.repeat(32);
  const findings = scanContent('demo.mjs', [api, token, privateKey, local].join('\n'), [
    { name: 'INVOICE_MODEL_API_KEY', value: local },
  ]);
  assert.equal(findings.length, 4);
  assert.equal(findings[0].line, 1);
  for (const secret of [api, token, privateKey, local])
    assert.equal(JSON.stringify(findings).includes(secret), false);
});

test('publication check allows empty examples but rejects embedded credentials', () => {
  assert.deepEqual(scanContent('.env.example', 'INVOICE_MODEL_API_KEY=\n'), []);
  assert.deepEqual(scanContent('test.mjs', 'https://u:p@example.com'), []);
  const credentialUrl = ['https://user', 'private@example.invalid'].join(':');
  assert.equal(scanContent('demo.mjs', credentialUrl).length, 1);
  assert.equal(scanContent('demo.mjs', "apiKey: '" + 'x'.repeat(32) + "'").length, 1);
});
