// Actual Harness conversation routing; fake task execution prevents opening a merchant page.
import assert from 'node:assert/strict';
import { writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { configuration } from '../src/server/config.mjs';
import { Store } from '../src/storage/store.mjs';
import { ChatService } from '../src/core/chat-service.mjs';
import { Runner } from '../src/core/runner.mjs';

const directory = path.resolve('test-results', `chat-tax-live-${Date.now()}`);
const config = configuration({ dataDir: directory });
const store = new Store(directory),
  runner = new Runner(store, config);
runner.execute = async (task) =>
  store.patchTask(task.id, {
    status: 'observed',
    message: '测试执行器已接收；未打开网页',
    finishedAt: new Date().toISOString(),
  });
const chat = new ChatService(store, config, { runner });
const report = { directory, passed: false, turns: [] };
async function turn(id, text) {
  const message = chat.send(id, { text }, crypto.randomUUID());
  await chat.active.get(id)?.promise;
  const reply = store.messages(id).find((m) => m.replyTo === message.id);
  assert.equal(reply?.status, 'complete', reply?.text);
  report.turns.push({ calls: reply.modelCalls, text: reply.text });
  console.log(JSON.stringify(report.turns.at(-1)));
}
try {
  const c = store.createConversation();
  await turn(
    c.id,
    '记住我的企业是青禾合成科技有限公司，收票邮箱 test@example.invalid，以后默认用这家。税号不知道，到开票页面查就好。',
  );
  const profile = store.list('profiles').find((p) => p.title === '青禾合成科技有限公司');
  assert.ok(profile);
  assert.equal(profile.taxId, '');
  await turn(
    c.id,
    '用刚才的公司资料帮我开票，入口 https://example.com/invoice ，税号在开票页面查询。',
  );
  const task = store.list('tasks').find((t) => t.conversationId === c.id);
  assert.ok(task, 'Missing-tax profile must reach invoice_start');
  assert.equal(task.profile.taxId, '');
  assert.equal(task.actualSubmitted, false);
  assert.equal(
    store.list('tool_actions').some((a) => /company_lookup/.test(a.name)),
    false,
  );
  const session = path.join(directory, 'harness', `chat-${c.id}-memory-${store.memoryEpoch()}`);
  await access(session);
  await chat.deleteConversation(c.id);
  await assert.rejects(access(session), { code: 'ENOENT' });
  assert.ok(store.get('profiles', profile.id));
  assert.equal(store.get('conversations', c.id), null);
  report.passed = true;
} finally {
  await chat.close();
  await runner.close();
  store.close();
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
