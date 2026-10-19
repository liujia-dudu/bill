// Inspect public static source and blocked request metadata; never send invoice API requests.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/server/config.mjs';

const directory = path.join(ROOT, 'diagnostics', 'meituan-read-review-20261016');
await mkdir(directory, { recursive: true });
const html = await readFile(
  path.join(ROOT, 'test-results/browser-engine-t5-1792147798916/desktop.html'),
  'utf8',
);
const urls = [
  ...new Set([...html.matchAll(/https:\/\/s3\.meituan\.net\/[^"<\s]+\.js/g)].map((m) => m[0])),
];
const findings = [];
for (const url of urls) {
  const parsed = new URL(url);
  if (
    parsed.origin !== 'https://s3.meituan.net' ||
    !parsed.pathname.startsWith(
      '/static-prod01/com.sankuai.fsp.fe.feinvoice-files/static/build/js/',
    )
  )
    throw new Error('Unexpected static source');
  const response = await fetch(url);
  if (!response.ok) throw new Error('Static source load failed');
  const source = await response.text();
  const name = path.basename(parsed.pathname);
  await writeFile(path.join(directory, name), source);
  const keywords = [
    'queryReceiptQrCode',
    'queryInvoice',
    'requestInvoice',
    'createInvoice',
    'invoice/process',
    'invoiceStatus',
  ];
  const excerpts = [];
  for (const keyword of keywords) {
    let from = 0;
    for (let count = 0; count < 15; count++) {
      const at = source.indexOf(keyword, from);
      if (at < 0) break;
      excerpts.push({ keyword, at, text: source.slice(Math.max(0, at - 700), at + 1400) });
      from = at + keyword.length;
    }
  }
  if (excerpts.length) findings.push({ name, excerpts });
}
await writeFile(path.join(directory, 'source-findings.json'), JSON.stringify(findings, null, 2));
console.log(JSON.stringify({ directory, sourceFiles: urls.length, findings }));
