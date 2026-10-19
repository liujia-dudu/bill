import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT } from '../src/server/config.mjs';

const directory = path.join(ROOT, 'test-results', 'chat-e2e-' + Date.now());
await mkdir(directory, { recursive: true });
const port = 3197,
  base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(ROOT, 'tests/chat-fixture-server.mjs')], {
  cwd: directory,
  env: {
    ...process.env,
    INVOICE_AGENT_PORT: String(port),
    INVOICE_AGENT_DATA_DIR: path.join(directory, 'data'),
  },
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (data) => (output += data));
server.stderr.on('data', (data) => (output += data));
const report = { passed: false, checks: [], errors: [] };
let browser;
async function ready() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/api/health')).ok) return;
    } catch {}
    if (server.exitCode !== null) throw new Error(output);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Service not ready');
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(directory, name), fullPage: true });
}
try {
  await ready();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().startsWith(base + '/api/'))
      report.errors.push(`API HTTP ${r.status()}`);
  });
  await page.goto(base);
  await page.getByRole('heading', { name: '把开票的事，交给我' }).waitFor();
  await shot(page, '01-chat-home.png');
  assert.equal(await page.getByText('开票资料', { exact: true }).count(), 0);
  assert.equal(await page.locator('.topbar,.profile-modal').count(), 0);
  report.checks.push('chat-only interface, legacy form removed');
  const send = async (text) => {
    await page.getByRole('textbox', { name: '发送消息' }).fill(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector('.thinking,.typing-indicator,.message-queued'),
    );
  };
  await send('记住我的个人抬头是张三，邮箱 zhang@example.invalid，以后默认使用。');
  await page.getByText('已保存张三为默认个人抬头。', { exact: true }).waitFor();
  await shot(page, '02-chat-memory.png');
  const first = (await (await fetch(base + '/api/conversations')).json()).find((c) =>
    c.title.startsWith('记住我的个人'),
  );
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await send('我有哪些资料？');
  await page.getByText('张三 / zhang@example.invalid', { exact: true }).waitFor();
  const second = (await (await fetch(base + '/api/conversations')).json()).find(
    (c) => c.id !== first.id,
  );
  assert.notEqual(first.id, second.id);
  report.checks.push('shared profiles visible in another conversation');
  await send('这次用李四，邮箱 li@example.invalid');
  await page.getByText('本次使用李四，默认未变。', { exact: true }).waitFor();
  const profiles = await (await fetch(base + '/api/profiles')).json();
  assert.equal(profiles.find((p) => p.isDefault).title, '张三');
  const qrImage = execFileSync(
    process.env.INVOICE_AGENT_PYTHON || 'python',
    [path.join(ROOT, 'tests/fixtures/qr/synthetic.py')],
    { windowsHide: true },
  );
  await page.locator('input[type=file]').setInputFiles({
    name: 'synthetic.png',
    mimeType: 'image/png',
    buffer: qrImage,
  });
  await page.locator('.draft-attachments img').waitFor();
  await send('这张帮我开发票。');
  await page.getByRole('button', { name: '填写正确', exact: true }).waitFor({ timeout: 30000 });
  await shot(page, '03-chat-invoice.png');
  const tasks = await (await fetch(base + '/api/tasks')).json();
  const task = tasks.find((t) => t.conversationId === second.id);
  assert.ok(task);
  const illegal = await fetch(`${base}/api/conversations/${first.id}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Invoice-Client': 'local-app' },
    body: JSON.stringify({
      kind: 'review',
      taskId: task.id,
      token: task.reviewToken,
      approved: true,
    }),
  });
  assert.equal(illegal.status, 403);
  await page.getByRole('button', { name: '填写正确', exact: true }).click();
  await page.getByText('已核对', { exact: true }).waitFor();
  assert.equal((await (await fetch(base + '/api/tasks')).json())[0].actualSubmitted, false);
  report.checks.push('attachment, task card, screenshot review and cross-conversation denial');
  await page.reload();
  await page.getByText('已核对', { exact: true }).waitFor();
  report.checks.push('messages and task results survive reload');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, '05-mobile-chat.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await page.locator('.conversation-list button').filter({ hasText: first.title }).click();
  await page.getByText('已保存张三为默认个人抬头。', { exact: true }).waitFor();
  assert.equal(await page.locator('.task-card').count(), 0);
  report.checks.push('mobile conversation switch keeps tasks isolated');
  await page.getByRole('button', { name: '打开会话列表' }).click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: `删除对话 ${first.title}`, exact: true }).click();
  assert.ok(
    (await (await fetch(base + '/api/conversations')).json()).some((c) => c.id === first.id),
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: `删除对话 ${first.title}`, exact: true }).click();
  await page.getByRole('heading', { name: '把开票的事，交给我' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '打开会话列表' }).click();
  assert.equal(
    await page.getByRole('button', { name: `删除对话 ${first.title}`, exact: true }).count(),
    0,
  );
  assert.ok((await (await fetch(base + '/api/profiles')).json()).some((p) => p.title === '张三'));
  assert.equal(await page.getByText('历史开票记录', { exact: true }).count(), 0);
  report.checks.push(
    'delete/cancel on mobile, deletion persists after reload, shared profile preserved',
  );
  await shot(page, '06-history-after-delete.png');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  await browser?.close();
  server.kill();
  await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.once('exit', resolve);
    setTimeout(resolve, 3000);
  });
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(directory, 'server.log'), output);
  console.log(JSON.stringify({ directory, ...report }));
}
