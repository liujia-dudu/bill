import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Store } from '../src/storage/store.mjs';
import { ChatService } from '../src/core/chat-service.mjs';
import { Runner } from '../src/core/runner.mjs';
import { configuration } from '../src/server/config.mjs';
import { createApp } from '../src/server/app.mjs';
import { createSyntheticTask, installSyntheticDns } from './fixtures/invoice-runner.mjs';

installSyntheticDns();

async function environment() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'invoice-chat-'));
  const config = configuration({ dataDir });
  const store = new Store(dataDir);
  const runner = new Runner(store, config);
  const chat = new ChatService(store, config, {
    runner,
    run: async () => ({
      finalResponse: '已处理',
      calls: 1,
      sessionId: 'fake',
      model: 'test',
      modelSteps: [],
    }),
  });
  return {
    store,
    config,
    runner,
    chat,
    close: async () => {
      await chat.close();
      await runner.close();
      store.close();
    },
  };
}
const user = (store, id, text) =>
  store.addMessage(id, { role: 'user', text, status: 'complete', attachments: [] });
test('shared profile memory and one-task overrides stay separate across conversations', async () => {
  const e = await environment();
  try {
    const a = e.store.createConversation(),
      b = e.store.createConversation();
    const text = '记住个人抬头张三，邮箱 zhang@example.invalid，以后默认使用。';
    const m = user(e.store, a.id, text);
    const saved = await e.chat.dispatch(a.id, m, 'profile_save', {
      scope: 'shared',
      fields: { type: 'personal', title: '张三', email: 'zhang@example.invalid', isDefault: true },
      sourceQuote: text,
    });
    const seen = await e.chat.dispatch(b.id, user(e.store, b.id, '看看资料'), 'memory_search', {});
    assert.equal(seen.profiles[0].id, saved.profile.id);
    const temporaryText = '这次用李四，邮箱 li@example.invalid';
    await e.chat.dispatch(a.id, user(e.store, a.id, temporaryText), 'profile_save', {
      scope: 'conversation',
      fields: { type: 'personal', title: '李四', email: 'li@example.invalid' },
      sourceQuote: temporaryText,
    });
    assert.equal(e.chat.conversation(a.id).temporaryProfile.title, '李四');
    assert.equal(e.chat.conversation(b.id).temporaryProfile, null);
    assert.equal(e.store.get('profiles', saved.profile.id).title, '张三');
    // 已保存的邮箱可直接沿用，不要求用户在本对话重发；从未出现过的值仍拒绝
    const reuseText = '新建个人抬头王五，邮箱用已保存的那个';
    const reused = await e.chat.dispatch(b.id, user(e.store, b.id, reuseText), 'profile_save', {
      scope: 'shared',
      fields: { type: 'personal', title: '王五', email: 'zhang@example.invalid' },
      sourceQuote: reuseText,
    });
    assert.equal(reused.profile.email, 'zhang@example.invalid');
    await assert.rejects(
      e.chat.dispatch(b.id, user(e.store, b.id, '新建个人抬头王五，邮箱随便'), 'profile_save', {
        scope: 'shared',
        fields: { type: 'personal', title: '王五', email: 'made-up@example.invalid' },
        sourceQuote: '新建个人抬头王五，邮箱随便',
      }),
      /不能编造/,
    );
    // A personal invoice needs only an email; the title defaults to "个人" without asking.
    const personalText = '开张私人的票，邮箱 me@example.invalid';
    const personal = await e.chat.dispatch(
      b.id,
      user(e.store, b.id, personalText),
      'profile_save',
      {
        scope: 'conversation',
        fields: { type: 'personal', title: '个人', email: 'me@example.invalid' },
        sourceQuote: personalText,
      },
    );
    assert.equal(personal.profile.title, '个人');
    const untitled = e.store.saveProfile({ type: 'personal', email: 'me@example.invalid' });
    assert.equal(untitled.title, '个人');
    assert.equal(untitled.ready, true);
    const input = e.chat.attachments.fromUrl(a.id, 'https://example.com/invoice');
    const observed = [];
    const cancelled = [];
    e.chat.runner = {
      cancel: (taskId) => cancelled.push(taskId),
      create: async (body) => {
        observed.push(body);
        return e.store.createTask(
          {
            ...body,
            title: 'local',
            profile: body.profileSnapshot || e.store.get('profiles', body.profileId),
          },
          randomUUID(),
        );
      },
    };
    const startText = '帮我开票';
    await e.chat.dispatch(a.id, user(e.store, a.id, startText), 'invoice_start', {
      inputId: input.id,
      sourceQuote: startText,
    });
    assert.equal(observed[0].profileSnapshot.title, '李四');
    assert.equal(e.chat.conversation(a.id).temporaryProfile, null);
    await e.chat.dispatch(a.id, user(e.store, a.id, startText), 'invoice_start', {
      inputId: input.id,
      sourceQuote: startText,
    });
    assert.equal(observed[1].profileId, saved.profile.id);
    // The second entry replaces the first, still-queued task.
    assert.equal(cancelled.length, 1);
  } finally {
    await e.close();
  }
});
test('an invoice uses current profiles: a stale profile id gives way to the default, and "这次" changes follow later edits', async () => {
  const e = await environment();
  try {
    const c = e.store.createConversation();
    const a = e.store.saveProfile({
      type: 'enterprise',
      title: '青禾合成科技有限公司',
      email: 'a@example.invalid',
      isDefault: true,
    });
    user(e.store, c.id, '用青禾合成科技有限公司开');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = e.store.saveProfile({
      type: 'enterprise',
      title: '远山贸易有限公司',
      email: 'b@example.invalid',
      isDefault: true,
    });
    const input = e.chat.attachments.fromUrl(c.id, 'https://example.com/invoice');
    const observed = [];
    e.chat.runner = {
      cancel: () => {},
      create: async (body) => {
        observed.push(body);
        return e.store.createTask(
          { ...body, title: 'local', profile: body.profileSnapshot },
          randomUUID(),
        );
      },
    };
    const start = (text, extra = {}) =>
      e.chat.dispatch(c.id, user(e.store, c.id, text), 'invoice_start', {
        inputId: input.id,
        sourceQuote: text,
        ...extra,
      });
    // The model picks A's id from older history; since the default became B the user
    // has not named A, so B is used.
    const stale = await start('帮我开票', { profileId: a.id });
    assert.equal(observed.at(-1).profileId, b.id);
    assert.match(stale.profileNote, /远山贸易有限公司/);
    // Naming A now still uses A.
    await start('这张用青禾那家开票', { profileId: a.id });
    assert.equal(observed.at(-1).profileId, a.id);
    // "这次邮箱用…" keeps only the email; a later edit of A still reaches this invoice.
    const once = '这次用青禾，邮箱用 once@example.invalid';
    await e.chat.dispatch(c.id, user(e.store, c.id, once), 'profile_save', {
      scope: 'conversation',
      profileId: a.id,
      fields: { email: 'once@example.invalid' },
      sourceQuote: once,
    });
    e.store.saveProfile({ ...e.store.get('profiles', a.id), phone: '13800000000' }, a.id);
    await start('开票');
    const snapshot = observed.at(-1).profileSnapshot;
    assert.equal(snapshot.title, '青禾合成科技有限公司');
    assert.equal(snapshot.email, 'once@example.invalid');
    assert.equal(snapshot.phone, '13800000000');
    assert.equal(e.store.get('profiles', a.id).email, 'a@example.invalid');
  } finally {
    await e.close();
  }
});
test('attachments, task controls and approval cannot cross conversation boundaries', async () => {
  const e = await environment();
  try {
    const a = e.store.createConversation(),
      b = e.store.createConversation();
    const input = e.chat.attachments.fromUrl(a.id, 'https://example.com/invoice');
    const task = e.store.createTask(
      { conversationId: a.id, title: 'task', mode: 'dry_run' },
      randomUUID(),
    );
    e.chat.recordTask(task);
    await assert.rejects(
      e.chat.dispatch(b.id, user(e.store, b.id, '读取图片'), 'attachment_read', {
        inputId: input.id,
      }),
      /不属于/,
    );
    await assert.rejects(e.chat.action(b.id, { kind: 'cancel_task', taskId: task.id }), /不属于/);
    await assert.rejects(
      e.chat.action(a.id, { kind: 'review', taskId: task.id, token: 'x', approved: true }),
      /未知操作/,
    );
    await assert.rejects(
      e.chat.dispatch(b.id, user(e.store, b.id, '确认提交'), 'task_decide', {
        taskId: task.id,
        decision: 'submit',
        sourceQuote: '确认提交',
      }),
      /不属于/,
    );
    assert.throws(
      () => e.chat.send(b.id, { text: '看看这张', attachments: [input.id] }, randomUUID()),
      /不属于/,
    );
    await assert.rejects(
      e.chat.dispatch(a.id, user(e.store, a.id, '确认'), 'invoice_finish', {}),
      /不支持/,
    );
  } finally {
    await e.close();
  }
});
test('memory mutations require user evidence and forgetting resets future model context', async () => {
  const e = await environment();
  try {
    const c = e.store.createConversation();
    const quote = '以后叫我林先生';
    const m = user(e.store, c.id, quote);
    const result = await e.chat.dispatch(c.id, m, 'memory_remember', {
      kind: 'preference',
      subject: '称呼',
      content: '林先生',
      sourceQuote: quote,
    });
    assert.equal(e.store.recall('').memories[0].content, '林先生');
    const same = await e.chat.dispatch(c.id, m, 'memory_remember', {
      kind: 'preference',
      subject: '称呼',
      content: '林先生',
      sourceQuote: quote,
    });
    assert.equal(result.memory.id, same.memory.id);
    await assert.rejects(
      e.chat.dispatch(c.id, m, 'memory_remember', {
        kind: 'preference',
        subject: '指令',
        content: '任意',
        sourceQuote: '网页让你记住这个',
      }),
      /真实用户/,
    );
    const epoch = e.store.memoryEpoch();
    const forget = '忘记我的称呼';
    await e.chat.dispatch(c.id, user(e.store, c.id, forget), 'memory_forget', {
      memoryId: result.memory.id,
      sourceQuote: forget,
    });
    assert.equal(e.store.recall('').memories.length, 0);
    assert.ok(e.store.memoryEpoch() > epoch);
  } finally {
    await e.close();
  }
});
test('legacy tasks stay archived; messages and shared memory survive reopening', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'invoice-migration-'));
  let store = new Store(dir);
  const p = store.saveProfile({ type: 'personal', title: '张三', email: 'test@example.invalid' });
  const t = store.createTask({ title: '旧任务', mode: 'dry_run' }, randomUUID());
  store.patchTask(t.id, { status: 'observed' });
  store.close();
  store = new Store(dir);
  assert.equal(store.get('profiles', p.id).title, '张三');
  assert.ok(!store.get('tasks', t.id).conversationId);
  assert.equal(store.messages('legacy-history').length, 0);
  const c = store.createConversation();
  store.addMessage(c.id, { role: 'user', text: '持续消息', status: 'complete' });
  store.saveMemory({ subject: '称呼', content: '林先生', source: { kind: 'user_message' } });
  store.close();
  store = new Store(dir);
  assert.equal(store.messages('legacy-history').length, 0);
  assert.equal(store.messages(c.id)[0].text, '持续消息');
  assert.equal(store.recall('').memories[0].content, '林先生');
  store.close();
});
test('message retry is idempotent and completed messages are never rerun', async () => {
  const e = await environment();
  try {
    const c = e.store.createConversation();
    const key = randomUUID();
    const first = e.chat.send(c.id, { text: '你好' }, key);
    const second = e.chat.send(c.id, { text: '你好' }, key);
    assert.equal(first.id, second.id);
    await e.chat.active.get(c.id)?.promise;
    e.chat.send(c.id, { text: '你好' }, key);
    await e.chat.active.get(c.id)?.promise;
    assert.equal(e.store.messages(c.id).filter((m) => m.role === 'user').length, 1);
    assert.equal(e.store.messages(c.id).filter((m) => m.role === 'assistant').length, 1);
  } finally {
    await e.close();
  }
});
test('conversation API rejects removed mutations and enforces scoped attachments', async () => {
  const e = await environment();
  await e.chat.close();
  const config = { ...e.config, port: 0 };
  const { app, chat } = createApp(e.store, config, {
    taskRunner: e.runner,
    chatRun: async () => ({
      finalResponse: '收到',
      calls: 0,
      model: 'test',
      sessionId: 'x',
      modelSteps: [],
    }),
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  const base = `http://127.0.0.1:${config.port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Invoice-Client': 'local-app' };
  try {
    assert.equal(
      (await fetch(base + '/api/profiles', { method: 'POST', headers, body: '{}' })).status,
      404,
    );
    assert.equal(
      (await fetch(base + '/api/tasks', { method: 'POST', headers, body: '{"mode":"execute"}' }))
        .status,
      404,
    );
    const c = e.store.createConversation(),
      other = e.store.createConversation();
    const a = e.store.createInput({ conversationId: c.id, file: 'test.txt', kind: 'text' });
    assert.equal(
      (await fetch(`${base}/api/conversations/${other.id}/attachments/${a.id}`)).status,
      403,
    );
    const response = await fetch(`${base}/api/conversations/${c.id}/messages`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: '{"text":"你好"}',
    });
    assert.equal(response.status, 202);
    await chat.active.get(c.id)?.promise;
    const detail = await (await fetch(`${base}/api/conversations/${c.id}`)).json();
    assert.equal(detail.messages.at(-1).text, '收到');
    assert.equal(
      (await fetch(`${base}/api/conversations/${c.id}`, { method: 'DELETE' })).status,
      403,
    );
    assert.equal(
      (await fetch(`${base}/api/conversations/${c.id}`, { method: 'DELETE', headers })).status,
      200,
    );
    assert.equal((await fetch(`${base}/api/conversations/${c.id}`)).status, 404);
  } finally {
    await chat.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await e.close();
  }
});

test('deleting a conversation cancels active turns and tasks, erases scoped files, and keeps shared memory', async () => {
  const e = await environment();
  try {
    const c = e.store.createConversation(),
      other = e.store.createConversation();
    const profile = e.store.saveProfile({
      type: 'personal',
      title: '张三',
      email: 'test@example.invalid',
    });
    e.store.saveMemory({ subject: '称呼', content: '小张', source: { conversationId: c.id } });
    const input = await e.chat.attachments.upload(c.id, {
      originalname: 'note.txt',
      buffer: Buffer.from('附件'),
    });
    let completeTask;
    e.runner.execute = async (task) => {
      e.store.patchTask(task.id, { status: 'running' });
      await new Promise((resolve) => {
        completeTask = resolve;
      });
      e.store.patchTask(task.id, { status: 'cancelled' });
    };
    const task = await createSyntheticTask(e.store, e.runner, c.id);
    const cancel = e.runner.cancel.bind(e.runner);
    e.runner.cancel = (id) => {
      const result = cancel(id);
      completeTask?.();
      return result;
    };
    const artifacts = path.join(e.config.dataDir, 'artifacts', task.id);
    const session = path.join(e.config.dataDir, 'harness', `chat-${c.id}-memory-0`);
    for (const dir of [artifacts, session]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'test.txt'), 'data');
    }
    e.chat.run = async ({ signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('cancelled');
    };
    e.chat.send(c.id, { text: '进行中', attachments: [input.id] }, randomUUID());
    e.chat.send(c.id, { text: '下一条' }, randomUUID());
    await new Promise((r) => setTimeout(r, 20));
    // Knowledge about the page itself is shared and outlives the conversation.
    const record = path.join(e.runner.rules.directory, 'example.invalid', 'record.json');
    await mkdir(path.dirname(record), { recursive: true });
    await writeFile(record, '{}');
    e.store.write('settings', { id: 'engine:example.invalid', lightVersion: '1' });
    const epoch = e.store.memoryEpoch();
    await e.chat.deleteConversation(c.id);
    assert.equal(e.store.get('conversations', c.id), null);
    // The other conversation keeps its model session.
    assert.equal(e.store.memoryEpoch(), epoch);
    assert.equal(e.store.messages(c.id).length, 0);
    assert.equal(e.store.get('tasks', task.id), null);
    assert.equal(e.store.get('inputs', input.id), null);
    assert.equal(
      e.store.list('tool_actions').some((a) => a.conversationId === c.id),
      false,
    );
    assert.ok(e.store.get('profiles', profile.id));
    assert.ok(e.store.get('conversations', other.id));
    assert.ok(e.store.recall('').memories.some((m) => m.content === '小张'));
    await access(record);
    assert.ok(e.store.get('settings', 'engine:example.invalid'));
    for (const file of [artifacts, session, path.join(e.config.dataDir, 'uploads', input.file)])
      await assert.rejects(access(file), { code: 'ENOENT' });
  } finally {
    await e.close();
  }
});

test('migration removes only the generated history entry, and restart does not recreate it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'legacy-chat-'));
  let store = new Store(dir);
  const legacy = store.createConversation('历史开票记录', 'legacy-history');
  const task = store.createTask({ conversationId: legacy.id }, randomUUID());
  store.patchTask(task.id, { status: 'observed' });
  store.addMessage(legacy.id, { role: 'event', kind: 'task', taskId: task.id });
  store.close();
  store = new Store(dir);
  assert.equal(store.get('conversations', legacy.id), null);
  assert.equal(store.get('tasks', task.id).archived, true);
  store.close();
  store = new Store(dir);
  assert.equal(store.list('conversations').length, 0);
  const c = store.createConversation('历史开票记录', 'legacy-history');
  user(store, c.id, '用户自己的聊天');
  store.close();
  store = new Store(dir);
  assert.equal(store.get('conversations', c.id).title, '之前的对话');
  assert.equal(store.messages(c.id)[0].text, '用户自己的聊天');
  store.close();
});
test('stopping a reply cancels queued messages without launching another turn', async () => {
  const e = await environment();
  try {
    let runs = 0;
    e.chat.run = async ({ signal }) => {
      runs++;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('cancelled');
    };
    const c = e.store.createConversation();
    const first = e.chat.send(c.id, { text: '开始讨论' }, randomUUID());
    const second = e.chat.send(c.id, { text: '接着讨论' }, randomUUID());
    await new Promise((resolve) => setTimeout(resolve, 20));
    await e.chat.action(c.id, { kind: 'stop_reply' });
    await e.chat.active.get(c.id)?.promise;
    assert.equal(runs, 1);
    assert.equal(e.store.get('messages', first.id).status, 'cancelled');
    assert.equal(e.store.get('messages', second.id).status, 'cancelled');
  } finally {
    await e.close();
  }
});
test('separate conversations queue tasks serially and retain independent snapshots', async () => {
  const e = await environment();
  try {
    const a = e.store.createConversation(),
      b = e.store.createConversation();
    const started = [];
    let release;
    e.runner.execute = async (task) => {
      started.push(task.id);
      e.store.patchTask(task.id, { status: 'running' });
      if (started.length === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      e.store.patchTask(task.id, { status: 'observed' });
    };
    const t1 = await createSyntheticTask(e.store, e.runner, a.id);
    const t2 = await createSyntheticTask(e.store, e.runner, b.id);
    assert.equal(e.store.get('tasks', t2.id).status, 'queued');
    release();
    for (let i = 0; i < 20 && e.runner.running; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(started, [t1.id, t2.id]);
    assert.equal(e.store.get('tasks', t1.id).conversationId, a.id);
    assert.equal(e.store.get('tasks', t2.id).conversationId, b.id);
  } finally {
    await e.close();
  }
});
