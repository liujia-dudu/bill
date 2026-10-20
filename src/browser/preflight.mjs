import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, entryRule, safeMessage } from '../core/validation.mjs';
import { openBrowser } from './session.mjs';
import { installGuard, verifyGuard } from './guard.mjs';
import { observePage, classifyPage, waitForInvoiceReady, watchInvoiceOrder } from './observe.mjs';

// These signals only request an engine recheck, never infer field mappings.
export function pageAbnormality(observation) {
  const text = observation.frames
    .map((frame) => frame.innerText || frame.contentText || '')
    .join('\n')
    .trim();
  const controls = observation.frames.flatMap((frame) => frame.controls || []);
  if (!text && !controls.some((control) => control.visible))
    return {
      status: 'failed',
      reasonCode: 'blank_page',
      message: '网页未显示可读取内容，已停止填写',
    };
  if (
    /Oops!\s*Something went wrong|^(?:Something went wrong|Internal Server Error|Application error)|页面(?:加载|访问)失败|系统异常|服务异常|服务出错|网络异常/i.test(
      text,
    ) &&
    !controls.some(
      (control) =>
        control.visible &&
        control.editable &&
        control.enabled &&
        (['input', 'textarea', 'select'].includes(control.tag) || control.isContentEditable),
    )
  )
    return {
      status: 'failed',
      reasonCode: 'page_error',
      message: '网页显示加载或服务错误，已停止填写',
    };
  return null;
}

// Client-only entries (WeChat OAuth, "open in WeChat") are the site's decision and were
// verified identical under both engines, so they are final rather than a light failure.
export function engineRecheckReason(state) {
  if (
    state?.status === 'failed' &&
    [
      'blank_page',
      'page_error',
      'access_error',
      'navigation_timeout',
      'navigation_error',
      'order_not_loaded',
      'page_observation_failed',
    ].includes(state.reasonCode)
  )
    return state.reasonCode;
  return null;
}

export async function prepareInvoiceBrowser({
  engine,
  url,
  directory,
  open = openBrowser,
  check = () => {},
  step = (_message, fn) => fn(),
  onUpdate = () => {},
  onHandle = () => {},
  onBlocked = () => {},
  onArtifact = () => {},
}) {
  const attempts = [];
  let fallback;
  const publish = async () => {
    await writeFile(
      path.join(directory, 'engine-check.json'),
      JSON.stringify({ attempts, fallback, prepareOnly: true, actualSubmitted: false }, null, 2),
    );
    onUpdate({ engineAttempts: attempts, ...(fallback ? { engineFallback: fallback } : {}) });
  };
  const capture = async (handle, attempt) => {
    const name = `engine-check-${attempt.engine}.png`;
    try {
      await handle.page.screenshot({
        path: path.join(directory, name),
        fullPage: true,
        timeout: 15000,
      });
      attempt.screenshot = name;
      onArtifact({
        name,
        label: `${attempt.engine} 页面复核`,
        capturedAt: new Date().toISOString(),
      });
    } catch (error) {
      attempt.screenshotError = safeMessage(error);
    }
  };
  for (const selected of engine === 'light' ? ['light', 'normal'] : ['normal']) {
    check();
    const attempt = { engine: selected, startedAt: new Date().toISOString() };
    attempts.push(attempt);
    let handle, orderRead, observation, state, clientEntry;
    let returned = false;
    let guarded = false;
    try {
      handle = await step(`连接 ${selected} 浏览器`, () =>
        open(selected, {
          onSession: (sessionId) => {
            attempt.sessionId = sessionId;
            onUpdate({ sessionId, cleanup: { status: 'active' } });
          },
        }),
      );
      onHandle(handle);
      onUpdate({ engine: selected });
      orderRead = watchInvoiceOrder(handle.page);
      handle.page.setDefaultTimeout(15000);
      const blocked = [];
      handle.guard = await step('启用提交拦截', () =>
        installGuard(handle.context, {
          onBlocked: (record) => {
            blocked.push(record);
            onBlocked({ ...record, engine: selected });
          },
          onClientEntry: (rule) => {
            clientEntry = rule;
          },
        }),
      );
      await step('检查请求拦截', async () => {
        await verifyGuard(handle.page);
        if (!blocked.some((record) => record.path === '/api/__invoice_guard_probe__'))
          throw new AppError('浏览器请求拦截未生效，已停止', 400, 'guard_verification_failed');
      });
      guarded = true;
      let loadFailure;
      try {
        await step('打开并观察网页', async () => {
          const response = await handle.page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          });
          attempt.httpStatus = response?.status() ?? null;
          if (attempt.httpStatus >= 400)
            throw new AppError(`网页返回 ${attempt.httpStatus}，无法继续`, 400, 'access_error');
          await handle.page.waitForTimeout(2200);
          if (!clientEntry) await waitForInvoiceReady(handle.page, orderRead);
        });
      } catch (error) {
        if (!clientEntry) {
          const reasonCode =
            error.name === 'TimeoutError'
              ? 'navigation_timeout'
              : /net::ERR_|Navigation failed/i.test(error.message || '')
                ? 'navigation_error'
                : error.code;
          if (
            ![
              'access_error',
              'navigation_timeout',
              'navigation_error',
              'order_not_loaded',
            ].includes(reasonCode)
          )
            throw error;
          loadFailure = { status: 'failed', reasonCode, message: safeMessage(error) };
        }
      }
      check();
      try {
        observation = await step('识别页面与字段', () => observePage(handle.page));
        attempt.observation = `engine-check-${selected}.json`;
        await writeFile(
          path.join(directory, attempt.observation),
          JSON.stringify(observation, null, 2),
        );
      } catch (error) {
        loadFailure ||= {
          status: 'failed',
          reasonCode: 'page_observation_failed',
          message: safeMessage(error),
        };
      }
      state =
        clientEntry ||
        (observation && entryRule(observation.url)) ||
        (observation && classifyPage(observation)) ||
        loadFailure ||
        (observation && pageAbnormality(observation)) ||
        null;
      attempt.state = state;
      attempt.finalHost = observation ? new URL(observation.url).hostname : null;
      attempt.finishedAt = new Date().toISOString();
      const reason = engineRecheckReason(state);
      if (state || fallback) await capture(handle, attempt);
      if (selected === 'light' && reason && guarded) {
        check();
        orderRead.close();
        orderRead = null;
        attempt.cleanup = await step('关闭 light 会话', () => handle.close());
        onHandle(null);
        onUpdate({ cleanup: attempt.cleanup });
        if (!['closed', 'create_failed'].includes(attempt.cleanup.status))
          throw new AppError(
            'light 会话尚未确认关闭，已停止 normal 复核，请先重试关闭',
            409,
            'session_cleanup_required',
          );
        handle = null;
        fallback = {
          from: 'light',
          to: 'normal',
          trigger: reason,
          result: 'checking',
          compatibilitySuspected: false,
          compatibilityConfirmed: false,
        };
        await publish();
        // light is already closed and recorded; skip the failure cleanup in finally.
        returned = true;
        continue;
      }
      if (fallback) {
        fallback.result = !state
          ? 'normal_page_ready'
          : engineRecheckReason(state)
            ? 'normal_page_abnormal'
            : 'normal_terminal_state';
        fallback.compatibilitySuspected = !state;
      }
      await publish();
      check();
      returned = true;
      return { handle, orderRead, observation, state, engine: selected };
    } catch (error) {
      attempt.error = { message: safeMessage(error), reasonCode: error.code || 'operation_failed' };
      if (handle && !attempt.screenshot) await capture(handle, attempt);
      if (fallback) fallback.result = 'normal_check_failed';
      if (error.cleanup) attempt.cleanup = error.cleanup;
      throw error;
    } finally {
      if (!returned) {
        orderRead?.close();
        if (handle) {
          attempt.cleanup = await handle.close().catch(() => ({ status: 'close_unconfirmed' }));
          onHandle(null);
        }
        if (attempt.cleanup) onUpdate({ cleanup: attempt.cleanup });
        attempt.finishedAt ||= new Date().toISOString();
        await publish();
      }
    }
  }
}
