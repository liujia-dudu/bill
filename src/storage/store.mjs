import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { AppError, normalizeProfile, profileProblems } from '../core/validation.mjs';
import { companyNameKey, validPageTaxId } from '../core/tax-id.mjs';

const now = () => new Date().toISOString();
export class Store extends EventEmitter {
  constructor(directory) {
    super();
    this.db = new DatabaseSync(path.join(directory, 'invoice.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, request_key TEXT UNIQUE, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_actions (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    `);
    for (const task of this.list('tasks'))
      if (['running', 'queued'].includes(task.status))
        this.patchTask(task.id, {
          status: 'interrupted',
          phase: 'stopped',
          message: '服务重启，任务已暂停；请重新准备',
          finishedAt: now(),
        });
    for (const conversation of this.list('conversations')) {
      if (conversation.status === 'running' || conversation.deleting)
        this.write('conversations', {
          ...conversation,
          status: 'idle',
          deleting: false,
          interrupted: true,
        });
    }
    for (const message of this.list('messages')) {
      if (message.role === 'user' && ['queued', 'processing'].includes(message.status))
        this.patchMessage(message.id, { status: 'interrupted' });
      if (message.role === 'assistant' && message.status === 'thinking')
        this.patchMessage(message.id, {
          status: 'interrupted',
          text: message.text || '上次回复被中断，请继续发送消息。',
        });
    }
    // The old migration-only conversation is no longer a product entry point.
    // Preserve any real chat the user has since added to it, and keep old evidence on disk.
    const legacy = this.get('conversations', 'legacy-history');
    if (legacy && !this.messages(legacy.id).some((m) => m.role === 'user')) {
      for (const task of this.list('tasks').filter((t) => t.conversationId === legacy.id))
        this.patchTask(task.id, { conversationId: null, archived: true });
      for (const input of this.list('inputs').filter((i) => i.conversationId === legacy.id))
        this.write('inputs', { ...input, conversationId: null, archived: true });
      this.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(legacy.id);
      this.remove('conversations', legacy.id);
    } else if (legacy?.title === '历史开票记录') {
      this.patchConversation(legacy.id, { title: '之前的对话' });
    }
  }
  list(table) {
    return this.db
      .prepare(`SELECT document FROM ${this.table(table)} ORDER BY rowid DESC`)
      .all()
      .map((row) => JSON.parse(row.document));
  }
  table(table) {
    if (
      ![
        'profiles',
        'inputs',
        'tasks',
        'conversations',
        'messages',
        'memories',
        'tool_actions',
        'settings',
      ].includes(table)
    )
      throw new Error('Invalid table');
    return table;
  }
  get(table, id) {
    const row = this.db.prepare(`SELECT document FROM ${this.table(table)} WHERE id=?`).get(id);
    return row ? JSON.parse(row.document) : null;
  }
  remove(table, id) {
    this.db.prepare(`DELETE FROM ${this.table(table)} WHERE id=?`).run(id);
  }
  deleteConversation(id) {
    const taskIds = new Set(
      this.list('tasks')
        .filter((t) => t.conversationId === id)
        .map((t) => t.id),
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['inputs', 'tasks', 'tool_actions'])
        for (const item of this.list(table))
          if (item.conversationId === id) this.remove(table, item.id);
      for (const memory of this.list('memories'))
        if (memory.kind === 'experience' && taskIds.has(memory.source?.taskId))
          this.remove('memories', memory.id);
      this.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
      this.remove('conversations', id);
      this.invalidateModelMemory();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.emit('chat', id);
  }
  require(table, id) {
    const result = this.get(table, id);
    if (!result) throw new AppError('记录不存在', 404);
    return result;
  }
  write(table, item) {
    this.db
      .prepare(
        `INSERT INTO ${this.table(table)} (id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document`,
      )
      .run(item.id, JSON.stringify(item));
    return item;
  }
  saveProfile(raw, id) {
    const old = id ? this.require('profiles', id) : null;
    if (old && Number(raw.revision) !== old.revision)
      throw new AppError('资料已更新，请刷新后再保存', 409);
    const item = {
      ...normalizeProfile(raw),
      userId: 'local',
      id: old?.id || randomUUID(),
      revision: (old?.revision || 0) + 1,
      createdAt: old?.createdAt || now(),
      updatedAt: now(),
    };
    item.taxSource =
      item.type !== 'enterprise'
        ? null
        : raw.taxSource ||
          (old?.title === item.title && old?.taxId === item.taxId ? old.taxSource : null) || {
            kind: 'manual',
          };
    item.problems = profileProblems(item);
    item.ready = item.problems.length === 0;
    if (!this.list('profiles').length) item.isDefault = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (item.isDefault)
        for (const other of this.list('profiles'))
          if (other.id !== item.id && other.isDefault)
            this.write('profiles', { ...other, isDefault: false });
      this.write('profiles', item);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (old)
      for (const task of this.list('tasks'))
        if (task.profileId === item.id && task.status === 'awaiting_review')
          this.patchTask(task.id, {
            status: 'needs_changes',
            reviewToken: null,
            message: '开票资料已修改，旧审核已失效；请重新准备',
            reviewStatus: 'invalidated',
          });
    return item;
  }
  deleteProfile(id) {
    this.require('profiles', id);
    this.db.prepare('DELETE FROM profiles WHERE id=?').run(id);
    for (const task of this.list('tasks'))
      if (task.profileId === id && task.status === 'awaiting_review')
        this.patchTask(task.id, {
          status: 'needs_changes',
          reviewToken: null,
          message: '开票资料已删除，请重新选择并准备',
          reviewStatus: 'invalidated',
        });
    const remaining = this.list('profiles');
    if (remaining.length && !remaining.some((p) => p.isDefault))
      this.write('profiles', { ...remaining[0], isDefault: true });
    for (const memory of this.list('memories'))
      if (memory.profileId === id) this.forgetMemory(memory.id);
    this.invalidateModelMemory();
    for (const c of this.list('conversations')) {
      const patch = {};
      if (c.temporaryProfile?.sourceProfileId === id) patch.temporaryProfile = null;
      if (Object.keys(patch).length) this.patchConversation(c.id, patch);
    }
  }
  savePageTax(taskId, { title, taxId, source }) {
    const task = this.require('tasks', taskId);
    const profile = task.profile;
    if (
      task.status !== 'running' ||
      profile?.type !== 'enterprise' ||
      companyNameKey(title) !== companyNameKey(profile.title) ||
      !validPageTaxId(taxId) ||
      source?.kind !== 'invoice_page' ||
      source.title !== title ||
      source.taxId !== taxId
    )
      throw new AppError('页面税号证据与当前任务不一致');
    if (profile.taxId && profile.taxId !== taxId)
      throw new AppError('页面税号与原资料冲突，请人工核对', 409, 'tax_conflict');
    const taxSource = { ...source, taskId, conversationId: task.conversationId };
    let saved;
    if (task.temporaryProfile || task.source === 'demo') {
      // A one-task override must never silently become a shared company profile.
      saved = { ...profile, taxId, taxSource };
    } else {
      const current = this.get('profiles', task.profileId);
      if (!current || current.revision !== profile.revision)
        throw new AppError('查询期间资料已修改或删除，请重新准备', 409, 'profile_changed');
      saved = this.saveProfile({ ...current, taxId, taxSource }, current.id);
    }
    this.patchTask(taskId, {
      profile: saved,
      taxLookup: { status: 'verified', source: taxSource },
    });
    if (task.conversationId && this.get('conversations', task.conversationId))
      this.addMessage(task.conversationId, {
        role: 'event',
        kind: 'profile',
        profileId: saved.id,
        data: saved,
        scope: task.temporaryProfile || task.source === 'demo' ? 'conversation' : 'shared',
        text: task.temporaryProfile
          ? '已从开票页面核对税号，用于本次开票'
          : '已从开票页面核对并保存税号',
      });
    return saved;
  }
  createInput(data) {
    if (data.conversationId) {
      const conversation = this.require('conversations', data.conversationId);
      if (conversation.deleting) throw new AppError('对话正在删除', 409);
    }
    return this.write('inputs', { ...data, id: randomUUID(), createdAt: now() });
  }
  byRequestKey(key) {
    const row = this.db.prepare('SELECT document FROM tasks WHERE request_key=?').get(key);
    return row && JSON.parse(row.document);
  }
  createTask(data, key) {
    const old = this.byRequestKey(key);
    if (old) return old;
    const item = {
      ...data,
      id: randomUUID(),
      status: 'queued',
      phase: 'queued',
      message: '等待执行',
      createdAt: now(),
      updatedAt: now(),
      events: [],
      artifacts: [],
      fieldChecks: [],
      modelCalls: 0,
      simulation: data.mode === 'dry_run',
      actualSubmitted: false,
    };
    this.db
      .prepare('INSERT INTO tasks (id,request_key,document) VALUES (?,?,?)')
      .run(item.id, key, JSON.stringify(item));
    return item;
  }
  patchTask(id, patch) {
    const task = { ...this.require('tasks', id), ...patch, updatedAt: now() };
    this.db.prepare('UPDATE tasks SET document=? WHERE id=?').run(JSON.stringify(task), id);
    this.emit('task', task);
    return task;
  }
  event(id, phase, message) {
    const task = this.require('tasks', id);
    return this.patchTask(id, {
      phase,
      message,
      events: [...task.events, { phase, message, at: now() }],
    });
  }
  createConversation(title = '新对话', id = randomUUID()) {
    return this.write('conversations', {
      id,
      userId: 'local',
      title,
      status: 'idle',
      createdAt: now(),
      updatedAt: now(),
      sessionId: null,
      sessionEpoch: this.memoryEpoch(),
      temporaryProfile: null,
    });
  }
  patchConversation(id, patch) {
    return this.write('conversations', {
      ...this.require('conversations', id),
      ...patch,
      updatedAt: now(),
    });
  }
  memoryEpoch() {
    return this.get('settings', 'memory-epoch')?.value || 0;
  }
  invalidateModelMemory() {
    const value = this.memoryEpoch() + 1;
    this.write('settings', { id: 'memory-epoch', value });
    return value;
  }
  messages(conversationId) {
    return this.db
      .prepare('SELECT document FROM messages WHERE conversation_id=? ORDER BY rowid')
      .all(conversationId)
      .map((row) => JSON.parse(row.document));
  }
  addMessage(conversationId, data, requestKey = null) {
    this.require('conversations', conversationId);
    if (requestKey) {
      const existing = this.db
        .prepare('SELECT document FROM messages WHERE request_key=?')
        .get(requestKey);
      if (existing) return JSON.parse(existing.document);
    }
    const message = {
      ...data,
      id: randomUUID(),
      conversationId,
      userId: 'local',
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO messages(id,conversation_id,request_key,document) VALUES (?,?,?,?)')
      .run(message.id, conversationId, requestKey, JSON.stringify(message));
    this.patchConversation(conversationId, {});
    this.emit('message', message);
    return message;
  }
  patchMessage(id, patch) {
    const message = { ...this.require('messages', id), ...patch };
    this.db.prepare('UPDATE messages SET document=? WHERE id=?').run(JSON.stringify(message), id);
    this.emit('message', message);
    return message;
  }
  saveMemory({ id, kind = 'preference', subject, content, profileId = null, source }) {
    if (
      !['preference', 'alias', 'experience'].includes(kind) ||
      typeof subject !== 'string' ||
      !subject.trim() ||
      subject.length > 120 ||
      typeof content !== 'string' ||
      !content.trim() ||
      content.length > 1600
    )
      throw new AppError('记忆格式不正确');
    const old = id
      ? this.require('memories', id)
      : this.list('memories').find(
          (m) =>
            m.userId === 'local' &&
            m.kind === kind &&
            m.subject === subject &&
            m.status === 'active',
        );
    if (old) {
      this.write('memories', { ...old, status: 'superseded', updatedAt: now() });
    }
    return this.write('memories', {
      id: randomUUID(),
      userId: 'local',
      kind,
      subject,
      content,
      profileId,
      source,
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
      replaces: old?.id || null,
    });
  }
  forgetMemory(id) {
    const item = this.require('memories', id);
    this.write('memories', {
      id: item.id,
      userId: 'local',
      kind: item.kind,
      status: 'forgotten',
      createdAt: item.createdAt,
      updatedAt: now(),
    });
    this.invalidateModelMemory();
    return { forgotten: true };
  }
  recall(query = '') {
    const terms = query
      .toLowerCase()
      .split(/[\s,，、]+/)
      .filter(Boolean);
    const score = (text) =>
      terms.reduce((n, term) => n + (text.toLowerCase().includes(term) ? 1 : 0), 0);
    const profiles = this.list('profiles').map((p) => ({ ...p, userId: p.userId || 'local' }));
    const memories = this.list('memories').filter(
      (m) => m.status === 'active' && m.userId === 'local',
    );
    return {
      profiles: profiles
        .sort(
          (a, b) => Number(b.isDefault) - Number(a.isDefault) || score(b.title) - score(a.title),
        )
        .slice(0, 40),
      memories: memories
        .map((m) => ({ ...m, score: score(m.subject + ' ' + m.content) }))
        .filter((m) => !terms.length || m.score > 0 || m.kind === 'preference')
        .sort((a, b) => b.score - a.score)
        .slice(0, 30),
    };
  }
  close() {
    this.db.close();
  }
}
