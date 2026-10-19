// Explicit real Harness tests; only synthetic/local input and known client-entry classification.
import '../src/server/config.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { configuration, ROOT } from '../src/server/config.mjs';
import { Store } from '../src/storage/store.mjs';
import { Runner } from '../src/core/runner.mjs';
import { ChatService } from '../src/core/chat-service.mjs';

const directory = path.resolve('test-results', 'chat-live-' + Date.now());
const config = configuration({ dataDir: directory });
let store = new Store(directory),
  runner = new Runner(store, config),
  chat = new ChatService(store, config, { runner });
const report = { directory, checks: [] };
async function turn(id, text, attachments = []) {
  const user = chat.send(id, { text, attachments }, crypto.randomUUID());
  await chat.active.get(id)?.promise;
  const messages = store.messages(id);
  const response = messages.find((m) => m.replyTo === user.id);
  console.log(
    JSON.stringify({
      turn: text.slice(0, 25),
      status: response?.status,
      calls: response?.modelCalls,
      text: response?.text,
    }),
  );
  assert.equal(response?.status, 'complete', response?.text);
  return response;
}
try {
  const a = store.createConversation('资料与记忆'),
    b = store.createConversation('独立任务');
  await turn(
    a.id,
    '记住我的个人开票姓名是林知远，收票邮箱是 lin@example.invalid，以后默认用这个个人抬头。',
  );
  const profile = store.list('profiles').find((p) => p.title === '林知远');
  assert.ok(profile);
  assert.equal(profile.email, 'lin@example.invalid');
  assert.equal(profile.type, 'personal');
  assert.equal(profile.isDefault, true);
  report.checks.push('profile created by real model tool');
  const firstSession = store.get('conversations', a.id).sessionId;
  await turn(a.id, '这个对话的临时校验词是“银杏八十一”，不用长期记忆。');
  const continued = await turn(a.id, '这个对话刚才的临时校验词是什么？');
  assert.ok(continued.text.includes('银杏八十一'));
  assert.equal(store.get('conversations', a.id).sessionId, firstSession);
  report.checks.push('same Harness session resumed across turns');
  const across = await turn(b.id, '我默认的开票姓名和邮箱是什么？请查询已保存资料。');
  assert.ok(across.text.includes('林知远') && across.text.includes('lin@example.invalid'));
  assert.ok(!across.text.includes('银杏八十一'));
  report.checks.push('shared profile recalled without other conversation context');
  await turn(
    b.id,
    '这次改用个人抬头林小雨，邮箱 rain@example.invalid，只用于这一次，不要修改默认资料。',
  );
  assert.equal(store.list('profiles').find((p) => p.isDefault).title, '林知远');
  assert.equal(store.get('conversations', b.id).temporaryProfile?.title, '林小雨');
  report.checks.push('temporary override does not change shared default');
  const attachment = await chat.attachments.upload(b.id, {
    originalname: 'invoice.png',
    buffer: await readFile(path.join(ROOT, 'data/samples/t1/input.png')),
  });
  await turn(b.id, '这张帮我开发票。', [attachment.id]);
  for (let i = 0; i < 120 && runner.running; i++) await new Promise((r) => setTimeout(r, 250));
  const task = store.list('tasks').find((t) => t.conversationId === b.id);
  assert.ok(task);
  assert.equal(task.profile.title, '林小雨');
  assert.equal(task.actualSubmitted, false);
  assert.equal(task.status, 'unsupported_browser');
  assert.equal(store.get('conversations', b.id).temporaryProfile, null);
  report.checks.push('image processed and invoice task scoped, temporary profile consumed');
  await chat.close();
  await runner.close();
  store.close();
  store = new Store(directory);
  runner = new Runner(store, config);
  chat = new ChatService(store, config, { runner });
  const restored = await turn(a.id, '刚才这个对话的临时校验词是什么？');
  assert.ok(restored.text.includes('银杏八十一'));
  report.checks.push('conversation restores after service reconstruction');
  await turn(a.id, '忘掉并删除林知远这个开票资料，后面不要再使用。');
  assert.ok(!store.list('profiles').some((p) => p.title === '林知远'));
  report.checks.push('profile forgotten through chat');
  await turn(a.id, '请记住以后称呼我小林，这是长期偏好。');
  assert.ok(
    store.recall('').memories.some((m) => m.kind === 'preference' && m.content.includes('小林')),
  );
  const preference = await turn(b.id, '我希望你怎么称呼我？请查记忆。');
  assert.ok(preference.text.includes('小林'));
  await turn(a.id, '忘记并删除我的称呼偏好，后面不要再使用这个称呼。');
  assert.ok(!store.recall('').memories.some((m) => m.content.includes('小林')));
  const forgotten = await turn(b.id, '我现在保存的称呼偏好是什么？');
  assert.ok(!forgotten.text.includes('小林'));
  report.checks.push('cross-conversation preference persistence and explicit forgetting');
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  await chat.close();
  await runner.close();
  store.close();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
