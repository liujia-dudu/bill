import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  AppError,
  digest,
  entryRule,
  profileProblems,
  safeMessage,
  validatePublicUrl,
} from './validation.mjs';
import { openBrowser, closeOrphan } from '../browser/session.mjs';
import { prepareInvoiceBrowser } from '../browser/preflight.mjs';
import { observePage, classifyPage, assertInvoiceAmounts } from '../browser/observe.mjs';
import { RuleRegistry } from '../rules/registry.mjs';
import { executeRule } from '../rules/executor.mjs';
import { runInvoiceAgent } from '../agent/run-invoice.mjs';
import { submitInvoice } from '../browser/submit.mjs';

export const REVIEW_WINDOW_MS = 5 * 60 * 1000;

export class Runner {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.rules = new RuleRegistry(config.rulesDir || path.join(config.root, 'src', 'adapters'));
    this.running = false;
    this.stopped = false;
    this.cancelled = new Set();
    this.activeHandle = null;
    this.agentAbort = null;
    this.idleWaiters = [];
    // Pages kept open while the user reviews the screenshot in chat.
    this.live = new Map();
    this.closing = new Map();
    this.submitting = new Map();
    this.reviewWindowMs = config.reviewWindowMs || REVIEW_WINDOW_MS;
    this.taskListener = (task) => {
      if (this.live.has(task.id) && task.status !== 'awaiting_review') void this.release(task.id);
    };
    store.on('task', this.taskListener);
  }
  async recover() {
    for (const task of this.store.list('tasks'))
      if (task.sessionId && !['closed', 'create_failed'].includes(task.cleanup?.status)) {
        const cleanup = await closeOrphan(task.sessionId).catch(() => ({
          status: 'close_unconfirmed',
        }));
        this.store.patchTask(task.id, { cleanup });
      }
  }
  async create(body, key) {
    // Real submission is never a task mode; it only follows a user's chat reply.
    if (!['dry_run', 'read_only'].includes(body.mode || 'dry_run'))
      throw new AppError('不支持未经用户确认的提交模式', 403, 'submission_requires_review');
    if (typeof key !== 'string' || key.length < 8 || key.length > 100)
      throw new AppError('缺少有效请求标识');
    const existing = this.store.byRequestKey(key);
    if (existing) {
      if (body.conversationId && existing.conversationId !== body.conversationId)
        throw new AppError('任务不属于当前对话', 403);
      return existing;
    }
    if (body.conversationId) this.store.require('conversations', body.conversationId);
    if (body.source !== 'input') throw new AppError('请选择二维码或网页地址');
    const input = this.store.require('inputs', body.inputId);
    const rawUrl = input.urls?.[Number(body.candidateIndex || 0)];
    if (!rawUrl) throw new AppError('没有可用的二维码地址，请选择候选或输入完整地址');
    await validatePublicUrl(rawUrl);
    const mode = body.mode || 'dry_run';
    const profile =
      mode === 'read_only'
        ? null
        : body.profileSnapshot || this.store.require('profiles', body.profileId);
    if (
      body.profileSnapshot &&
      (!body.conversationId || body.profileSnapshot.id !== `temporary-${body.conversationId}`)
    )
      throw new AppError('临时资料不属于当前对话', 403);
    if (body.conversationId && input.conversationId !== body.conversationId)
      throw new AppError('附件不属于当前对话', 403);
    if (mode === 'dry_run') {
      if (profile.revision !== Number(body.profileRevision))
        throw new AppError('资料已更新，请重新选择', 409);
      const problems = profileProblems(profile, Boolean(profile.taxId));
      if (problems.length) throw new AppError(problems.join('；'), 400, 'profile_incomplete');
    }
    const engine = body.engine || 'normal';
    if (!['normal', 'light'].includes(engine)) throw new AppError('不支持此浏览器引擎');
    if (this.store.list('tasks').some((task) => task.cleanup?.status === 'close_unconfirmed'))
      throw new AppError(
        '上次云会话尚未确认关闭，请先在任务详情重试关闭',
        409,
        'session_cleanup_required',
      );
    if (
      this.store.list('tasks').filter((task) => ['queued', 'running'].includes(task.status))
        .length >= 20
    )
      throw new AppError('等待任务过多，请稍后再试', 409, 'runner_busy');
    if (body.conversationId && this.store.require('conversations', body.conversationId).deleting)
      throw new AppError('对话正在删除', 409);
    const correctionNotes = body.correctionNotes || [];
    if (
      !Array.isArray(correctionNotes) ||
      correctionNotes.length > 5 ||
      correctionNotes.some((note) => typeof note !== 'string' || !note.trim() || note.length > 500)
    )
      throw new AppError('修正说明格式不正确');
    const task = this.store.createTask(
      {
        source: 'input',
        conversationId: body.conversationId || null,
        userId: 'local',
        temporaryProfile: Boolean(body.profileSnapshot),
        inputId: input.id,
        url: rawUrl,
        entryDigest: digest(rawUrl),
        profile,
        profileId: profile?.id || null,
        mode,
        engine,
        engineRequested: engine,
        title: new URL(rawUrl).hostname,
        coverageGaps: ['提交需用户在对话中确认截图后执行'],
        ...(correctionNotes.length
          ? { correctionNotes, correctedFrom: body.correctedFrom || null }
          : {}),
      },
      key,
    );
    this.pump().catch(() => {
      this.store.patchTask(task.id, {
        status: 'failed',
        message: '本地任务处理异常，请检查数据目录后重新准备',
        phase: 'finished',
      });
    });
    return task;
  }
  async pump() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const task = this.store
          .list('tasks')
          .filter((task) => task.status === 'queued')
          .at(-1);
        if (!task) break;
        await this.execute(task);
      }
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
  cancel(id) {
    const task = this.store.require('tasks', id);
    if (task.status === 'running') {
      this.cancelled.add(id);
      this.agentAbort?.abort();
      return this.store.event(id, 'cancelling', '正在停止操作并关闭会话');
    }
    if (['queued', 'awaiting_review'].includes(task.status))
      return this.store.patchTask(id, {
        status: 'cancelled',
        message: '任务已取消，未真实提交',
        finishedAt: new Date().toISOString(),
      });
    return task;
  }
  async waitForTask(id) {
    const started = Date.now();
    await this.closing.get(id);
    await this.submitting.get(id);
    while (this.store.get('tasks', id)?.status === 'running') {
      if (Date.now() - started > 30000) throw new AppError('任务仍在关闭，请稍后重试删除对话', 409);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  async execute(task) {
    const dir = path.join(this.config.dataDir, 'artifacts', task.id);
    await mkdir(dir, { recursive: true });
    const timings = [],
      blocked = [];
    let handle,
      orderRead,
      initialObservation,
      initialState,
      outcome,
      screenshotSaved = false;
    let actualEngine = task.engineRequested;
    const check = () => {
      if (this.cancelled.has(task.id) || this.stopped)
        throw new AppError('任务已取消', 400, 'cancelled');
      if (
        task.mode === 'dry_run' &&
        !task.temporaryProfile &&
        !this.store.get('profiles', task.profileId)
      )
        throw new AppError('使用的资料已删除，请重新选择', 400, 'profile_deleted');
      if (performance.now() - started > 15 * 60 * 1000)
        throw new AppError('任务已达到处理时间上限', 400, 'budget_exceeded');
    };
    const step = async (message, fn) => {
      check();
      this.store.event(task.id, 'processing', message);
      const at = performance.now();
      try {
        return await fn();
      } finally {
        timings.push({ name: message, ms: Math.round(performance.now() - at) });
      }
    };
    const screenshot = async () => {
      await handle.page.screenshot({
        path: path.join(dir, 'pre-submit.png'),
        fullPage: true,
        timeout: 15000,
      });
      screenshotSaved = true;
      const current = this.store.require('tasks', task.id);
      this.store.patchTask(task.id, {
        artifacts: [
          ...current.artifacts.filter((a) => a.name !== 'pre-submit.png'),
          { name: 'pre-submit.png', label: '填写检查截图', capturedAt: new Date().toISOString() },
        ],
      });
    };
    const started = performance.now();
    this.store.patchTask(task.id, { status: 'running', startedAt: new Date().toISOString() });
    try {
      check();
      if (task.source !== 'input')
        throw new AppError(
          '旧演示任务不再执行，请从当前对话重新提供入口',
          400,
          'unsupported_task_source',
        );
      const rule = entryRule(task.url);
      if (
        rule &&
        !(task.engineRequested === 'light' && rule.reasonCode === 'wechat_oauth_required')
      ) {
        outcome = rule;
        return;
      }
      const prepared = await prepareInvoiceBrowser({
        engine: actualEngine,
        url: task.url,
        directory: dir,
        open: this.config.openBrowser || openBrowser,
        check,
        step,
        onHandle: (active) => {
          this.activeHandle = active;
        },
        onBlocked: (record) => {
          if (blocked.length < 100) blocked.push(record);
        },
        onArtifact: (artifact) => {
          const current = this.store.require('tasks', task.id);
          this.store.patchTask(task.id, {
            artifacts: [
              ...current.artifacts.filter((item) => item.name !== artifact.name),
              artifact,
            ],
          });
        },
        onUpdate: (patch) => {
          this.store.patchTask(task.id, patch);
          if (patch.engineFallback?.result === 'checking')
            this.store.event(task.id, 'engine_recheck', 'light 页面异常，正在使用 normal 复核');
        },
      });
      handle = prepared.handle;
      orderRead = prepared.orderRead;
      initialObservation = prepared.observation;
      initialState = prepared.state;
      actualEngine = prepared.engine;
      if (initialState && !initialObservation) {
        outcome = initialState;
        await screenshot();
        return;
      }
      const before =
        initialObservation || (await step('识别页面与字段', () => observePage(handle.page)));
      await writeFile(path.join(dir, 'observation-before.json'), JSON.stringify(before, null, 2));
      const pageState = initialState || classifyPage(before);
      if (pageState) {
        outcome = pageState;
        await screenshot();
        return;
      }
      this.store.patchTask(task.id, {
        finalHost: new URL(handle.page.url()).hostname,
      });
      if (task.mode === 'read_only') {
        await screenshot();
        outcome = { status: 'observed', message: '只读检查完成，未填写或提交' };
        return;
      }
      const amounts = assertInvoiceAmounts(before);
      if (amounts.length)
        this.store.patchTask(task.id, {
          transaction: { amount: amounts[0].amount, amountSource: 'invoice_page' },
        });
      let result, preparationTools;
      const onTaxVerified = (evidence) => {
        check();
        const saved = this.store.savePageTax(task.id, evidence);
        Object.assign(task.profile, saved);
        return saved;
      };
      // A user correction means the reviewed result was wrong; let Harness re-analyse.
      const route = task.correctionNotes?.length
        ? { source: 'agent', reason: 'user_correction' }
        : await this.rules.select(before, task.profile, actualEngine);
      this.store.patchTask(task.id, {
        executionSource: route.source,
        routeReason: route.reason || 'verified_contract',
      });
      if (route.source === 'adapter') {
        try {
          result = await executeRule({
            route,
            registry: this.rules,
            page: handle.page,
            profile: task.profile,
            directory: dir,
            check,
            onTaxVerified,
            onProgress: (message) => this.store.event(task.id, 'rule_tool', message),
            onCheck: (checks) => this.store.patchTask(task.id, { fieldChecks: checks }),
          });
        } catch (error) {
          if (
            ![
              'ambiguous_field',
              'new_required_fields',
              'field_missing',
              'stale_element',
              'readback_mismatch',
              'rule_mismatch',
              'invalid_element',
            ].includes(error.code)
          )
            throw error;
          this.store.event(task.id, 'agent', '规则与当前页面不一致，交由 Harness 重新分析');
          preparationTools = error.preparationTools;
          this.store.patchTask(task.id, {
            executionSource: 'agent',
            routeReason: 'adapter_mismatch',
          });
        }
      }
      if (!result) {
        this.agentAbort = new AbortController();
        this.store.event(task.id, 'agent', 'Harness 正在分析页面并调用填写工具');
        result = await runInvoiceAgent({
          page: handle.page,
          profile: task.profile,
          taskId: task.id,
          dataDir: this.config.dataDir,
          directory: dir,
          engine: actualEngine,
          browserTools: preparationTools,
          corrections: task.correctionNotes,
          check,
          signal: this.agentAbort.signal,
          onProgress: (message) => this.store.event(task.id, 'agent_tool', message),
          onCheck: (checks) => this.store.patchTask(task.id, { fieldChecks: checks }),
          onTaxVerified,
          onRequest: (metrics) => {
            this.store.patchTask(task.id, {
              modelCalls: metrics.calls,
              modelName: metrics.model,
              modelToolCalls: metrics.toolCalls,
              harnessTools: metrics.toolNames,
            });
            this.store.event(task.id, 'model', `模型分析第 ${metrics.calls} 次`);
          },
        });
        this.agentAbort = null;
      }
      check();
      this.store.patchTask(task.id, {
        fieldChecks: result.checks,
        coverageGaps: result.coverageGaps,
        transaction: result.transaction || this.store.require('tasks', task.id).transaction,
        parameterSignature: result.signature,
        signatureComplete: result.signatureComplete === true,
        executionSource: result.executionSource || 'adapter',
        ...(result.ruleRevision
          ? {
              ruleDomain: result.ruleDomain,
              ruleId: result.ruleId,
              ruleVariant: result.ruleVariant,
              ruleRevision: result.ruleRevision,
            }
          : {}),
        ...(result.modelCalls
          ? {
              modelCalls: result.modelCalls,
              modelName: result.modelName,
              modelSteps: result.modelSteps,
              harnessVersion: result.harnessVersion,
              modelToolCalls: result.toolCalls,
              harnessClosed: result.harnessClosed,
            }
          : {}),
      });
      await writeFile(path.join(dir, 'field-check.json'), JSON.stringify(result.checks, null, 2));
      await writeFile(
        path.join(dir, 'trace.json'),
        JSON.stringify(
          {
            steps: result.checks,
            timings,
            mode: task.mode,
            engineRequested: task.engineRequested,
            engine: actualEngine,
            engineFallback: this.store.require('tasks', task.id).engineFallback,
            prepareOnly: true,
            platformAccepted: false,
          },
          null,
          2,
        ),
      );
      if (result.checks.some((field) => !field.matches))
        throw new AppError('填写值与资料不一致，已停止，请查看核对结果', 400, 'readback_mismatch');
      const after = await step('复核最终页面', () => observePage(handle.page));
      await writeFile(path.join(dir, 'observation-after.json'), JSON.stringify(after, null, 2));
      assertInvoiceAmounts(after);
      await step('保存填写截图', screenshot);
      check();
      outcome = {
        status: 'awaiting_review',
        message: '填写与核对完成，尚未提交。请在 5 分钟内回复：确认提交 / 指出要改的地方 / 放弃。',
        reviewToken: randomUUID(),
        evidenceDigest: digest({
          profile: task.profile,
          checks: result.checks,
          screenshot: 'pre-submit.png',
        }),
      };
      if (
        !task.temporaryProfile &&
        this.store.get('profiles', task.profileId)?.revision !== task.profile.revision
      )
        outcome = {
          status: 'needs_changes',
          message: '运行期间资料已更新，请用新资料重新准备',
          reviewStatus: 'invalidated',
        };
    } catch (error) {
      if (handle && !screenshotSaved) await screenshot().catch(() => {});
      const cancelled = error.code === 'cancelled';
      outcome = {
        status: cancelled
          ? 'cancelled'
          : error instanceof AppError &&
              [
                'missing_profile_field',
                'profile_deleted',
                'new_required_fields',
                'company_not_found',
                'ambiguous_company',
                'tax_conflict',
                'invalid_page_tax',
                'profile_changed',
              ].includes(error.code)
            ? 'needs_user_input'
            : 'failed',
        message: safeMessage(error),
        reasonCode: error.code || 'operation_failed',
      };
      if (error.cleanup) this.store.patchTask(task.id, { cleanup: error.cleanup });
    } finally {
      orderRead?.close();
      const keep =
        handle &&
        outcome?.status === 'awaiting_review' &&
        !this.cancelled.has(task.id) &&
        !this.stopped;
      if (handle && !keep) {
        this.store.event(task.id, 'closing', '保存结果并关闭浏览器');
        const cleanup = await handle.close().catch(() => ({ status: 'close_unconfirmed' }));
        this.store.patchTask(task.id, { cleanup });
        const attempts = this.store.require('tasks', task.id).engineAttempts;
        if (attempts?.length) {
          attempts.at(-1).cleanup = cleanup;
          this.store.patchTask(task.id, { engineAttempts: attempts });
          await writeFile(
            path.join(dir, 'engine-check.json'),
            JSON.stringify(
              {
                attempts,
                fallback: this.store.require('tasks', task.id).engineFallback,
                prepareOnly: true,
                actualSubmitted: false,
              },
              null,
              2,
            ),
          );
        }
      }
      if (this.cancelled.has(task.id))
        outcome = { status: 'cancelled', message: '任务已取消，未真实提交' };
      this.activeHandle = null;
      this.agentAbort = null;
      this.cancelled.delete(task.id);
      const stepImages = (await readdir(dir))
        .filter((name) => /^step-\d+\.png$/.test(name))
        .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
      const currentTask = this.store.require('tasks', task.id);
      if (existsSync(path.join(dir, 'company-query.png')))
        this.store.patchTask(task.id, {
          artifacts: [
            ...currentTask.artifacts.filter((a) => a.name !== 'company-query.png'),
            {
              name: 'company-query.png',
              label: '页面税号查询核对',
              capturedAt: currentTask.updatedAt,
            },
          ],
        });
      if (stepImages.length)
        this.store.patchTask(task.id, {
          artifacts: [
            ...this.store
              .require('tasks', task.id)
              .artifacts.filter((a) => !/^step-\d+\.png$/.test(a.name)),
            ...stepImages.map((name, index) => ({
              name,
              label: `填写步骤 ${index + 1}`,
              capturedAt: currentTask.updatedAt,
            })),
          ],
        });
      await writeFile(
        path.join(dir, 'network-guard.json'),
        JSON.stringify({ blocked, actualSubmitted: false }, null, 2),
      );
      if (keep)
        this.live.set(task.id, {
          handle,
          timer: setTimeout(() => void this.expire(task.id), this.reviewWindowMs),
        });
      this.store.patchTask(task.id, {
        ...outcome,
        phase: keep ? 'awaiting_review' : 'finished',
        timings,
        blockedRequests: blocked.length,
        finishedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        actualSubmitted: false,
        ...(keep
          ? {
              reviewReadyAt: new Date().toISOString(),
              reviewDeadline: new Date(Date.now() + this.reviewWindowMs).toISOString(),
            }
          : {}),
      });
    }
  }
  release(id) {
    const live = this.live.get(id);
    if (!live) return this.closing.get(id);
    this.live.delete(id);
    clearTimeout(live.timer);
    const closing = live.handle
      .close()
      .catch(() => ({ status: 'close_unconfirmed' }))
      .then((cleanup) => {
        if (this.store.get('tasks', id)) this.store.patchTask(id, { cleanup });
        return cleanup;
      })
      .finally(() => this.closing.delete(id));
    this.closing.set(id, closing);
    return closing;
  }
  notify(task, text) {
    const conversation =
      task.conversationId && this.store.get('conversations', task.conversationId);
    if (conversation && !conversation.deleting)
      this.store.addMessage(task.conversationId, { role: 'event', kind: 'notice', text });
  }
  expire(id) {
    const task = this.store.get('tasks', id);
    if (task?.status !== 'awaiting_review') return this.release(id);
    this.store.patchTask(id, {
      status: 'review_expired',
      phase: 'finished',
      reviewStatus: 'expired',
      reviewToken: null,
      message: '5 分钟内没有确认，页面已关闭，未提交。回复“重来”可重新填写。',
    });
    this.notify(
      task,
      '这张截图 5 分钟内没有确认，页面已关闭，未提交。需要的话回复“重来”重新填写。',
    );
    return this.release(id);
  }
  // Only ChatService calls the decisions below, after verifying the decision
  // comes from the user's own message in the current turn.
  requireReview(id) {
    const task = this.store.require('tasks', id);
    if (task.status !== 'awaiting_review' || !this.live.has(id))
      throw new AppError(
        '这张截图的确认已失效（可能已超时、已处理或服务重启），请回复“重来”重新填写',
        409,
        'review_inactive',
      );
    return task;
  }
  async submit(id) {
    const task = this.requireReview(id);
    if (Date.parse(task.reviewDeadline) <= Date.now()) {
      await this.expire(id);
      throw new AppError(
        '确认已超过 5 分钟，页面已关闭；请回复“重来”重新填写',
        409,
        'review_expired',
      );
    }
    if (
      !task.temporaryProfile &&
      this.store.get('profiles', task.profileId)?.revision !== task.profile?.revision
    )
      throw new AppError('资料已更新或删除，请重新填写', 409, 'profile_changed');
    if (
      !task.fieldChecks?.length ||
      task.fieldChecks.some((field) => !field.matches) ||
      !existsSync(path.join(this.config.dataDir, 'artifacts', id, 'pre-submit.png'))
    )
      throw new AppError('截图或字段核对不完整，不能提交', 409, 'evidence_incomplete');
    if (
      this.store
        .list('tasks')
        .some(
          (other) =>
            other.id !== id &&
            other.entryDigest === task.entryDigest &&
            (other.actualSubmitted === true || other.status === 'submitting'),
        )
    )
      throw new AppError('这个开票链接已经提交过，不能重复提交', 409, 'already_submitted_here');
    const live = this.live.get(id);
    this.live.delete(id);
    clearTimeout(live.timer);
    const patched = this.store.patchTask(id, {
      status: 'submitting',
      phase: 'submitting',
      message: '已收到确认，正在提交',
      reviewStatus: 'approved',
      reviewedAt: new Date().toISOString(),
      reviewToken: null,
    });
    const running = this.finishSubmit(id, live.handle).finally(() => this.submitting.delete(id));
    this.submitting.set(id, running);
    return patched;
  }
  async finishSubmit(id, handle) {
    const dir = path.join(this.config.dataDir, 'artifacts', id);
    let result;
    try {
      result = await submitInvoice({ page: handle.page, guard: handle.guard, directory: dir });
    } catch (error) {
      result = {
        status: 'submit_failed',
        reasonCode: error.code || 'submit_error',
        message: `${safeMessage(error)}，未提交`,
        actualSubmitted: false,
      };
    }
    const cleanup = await handle.close().catch(() => ({ status: 'close_unconfirmed' }));
    const task = this.store.require('tasks', id);
    const done = this.store.patchTask(id, {
      status: result.status,
      phase: 'finished',
      message: result.message,
      reasonCode: result.reasonCode || null,
      actualSubmitted: result.actualSubmitted === true,
      submittedAt: result.actualSubmitted ? new Date().toISOString() : null,
      submitRequests: result.released || 0,
      submitDialogs: result.dialogs || 0,
      simulation: false,
      cleanup,
      artifacts: result.screenshot
        ? [
            ...task.artifacts.filter((a) => a.name !== 'post-submit.png'),
            { name: 'post-submit.png', label: '提交结果', capturedAt: new Date().toISOString() },
          ]
        : task.artifacts,
    });
    this.notify(done, result.message);
    return done;
  }
  abandon(id, message = '已放弃，本次未提交，页面已关闭') {
    const task = this.store.require('tasks', id);
    if (task.status === 'review_expired') return task;
    if (task.status !== 'awaiting_review')
      throw new AppError('这张任务当前不在待确认状态', 409, 'review_inactive');
    return this.store.patchTask(id, {
      status: 'abandoned',
      phase: 'finished',
      reviewStatus: 'abandoned',
      reviewToken: null,
      message,
    });
  }
  supersede(id, newTaskId) {
    const task = this.store.require('tasks', id);
    if (!['awaiting_review', 'review_expired', 'needs_changes'].includes(task.status)) return task;
    return this.store.patchTask(id, {
      status: 'corrected',
      phase: 'finished',
      reviewStatus: 'corrected',
      reviewToken: null,
      supersededBy: newTaskId,
      message: '已按修正意见重新填写，本张未提交',
    });
  }
  async retryCleanup(id) {
    const task = this.store.require('tasks', id);
    if (!task.sessionId) return task;
    return this.store.patchTask(id, { cleanup: await closeOrphan(task.sessionId) });
  }
  async close() {
    this.stopped = true;
    this.store.off('task', this.taskListener);
    this.agentAbort?.abort();
    if (this.activeHandle) await this.activeHandle.close().catch(() => {});
    if (this.running) await new Promise((resolve) => this.idleWaiters.push(resolve));
    await Promise.allSettled([...this.submitting.values()]);
    await Promise.allSettled([...this.live.keys()].map((id) => this.release(id)));
    await Promise.allSettled([...this.closing.values()]);
  }
}
