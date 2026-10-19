// Actual Harness recovery of an existing failed QR upload.
// A fake task executor keeps this routing check entirely off merchant pages.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configuration, ROOT } from '../src/server/config.mjs';
import { Store } from '../src/storage/store.mjs';
import { ChatService } from '../src/core/chat-service.mjs';
import { Runner } from '../src/core/runner.mjs';

const directory = path.resolve('test-results', `chat-qr-live-${Date.now()}`);
const config = configuration({ dataDir: directory });
const store = new Store(directory);
const runner = new Runner(store, config);
runner.execute = async (task) =>
  store.patchTask(task.id, {
    status: 'observed',
    message: '测试执行器已接收；未打开商家网页',
    finishedAt: new Date().toISOString(),
  });
const chat = new ChatService(store, config, { runner });
const report = { directory, passed: false, merchantPageOpened: false };
try {
  const c = store.createConversation();
  const profile = store.saveProfile({
    type: 'personal',
    title: '林知远',
    email: 'lin@example.invalid',
    isDefault: true,
  });
  const input = await chat.attachments.upload(c.id, {
    originalname: 'input.jpg',
    buffer: await readFile(path.join(ROOT, 'data/samples/t3/input.jpg')),
  });
  store.write('inputs', {
    ...input,
    decoded: true,
    urls: [],
    decodeError: '旧版本解码失败',
  });
  store.addMessage(c.id, {
    role: 'user',
    text: '开发票',
    attachments: [input.id],
    status: 'complete',
  });
  store.addMessage(c.id, {
    role: 'assistant',
    text: '这张图里的二维码没能可靠识别，请提供更清晰图片或完整网页链接。',
    status: 'complete',
  });
  const message = chat.send(
    c.id,
    { text: '继续用刚才这张二维码开发票，使用已保存的默认资料。' },
    crypto.randomUUID(),
  );
  await chat.active.get(c.id)?.promise;
  const reply = store.messages(c.id).find((m) => m.replyTo === message.id);
  assert.equal(reply?.status, 'complete', reply?.text);
  assert.ok(reply.modelCalls > 0);
  const decoded = store.get('inputs', input.id);
  const catalog = JSON.parse(await readFile(path.join(ROOT, 'data/samples/invoice-cases.json')));
  const expected = catalog.cases
    .find((item) => item.id === 't3')
    .qr_candidates.find((item) => item.decode_valid).original_url;
  assert.deepEqual(decoded.urls, [expected]);
  assert.equal(decoded.decodeError, null);
  const task = store.list('tasks').find((t) => t.conversationId === c.id);
  assert.ok(task, 'The real model must start an invoice task from the recovered attachment');
  assert.equal(task.url, expected);
  assert.equal(task.inputId, input.id);
  assert.equal(task.profileId, profile.id);
  assert.equal(task.mode, 'dry_run');
  assert.equal(task.actualSubmitted, false);
  report.calls = reply.modelCalls;
  report.model = reply.modelName;
  report.reply = reply.text;
  report.inputId = input.id;
  report.taskId = task.id;
  report.host = new URL(task.url).hostname;
  report.method = decoded.decodeMethod;
  report.evidence = decoded.decodeEvidence;
  report.passed = true;
} finally {
  await chat.close();
  await runner.close();
  store.close();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
