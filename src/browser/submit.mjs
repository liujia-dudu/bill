import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, safeMessage } from '../core/validation.mjs';
import { classifyPage } from './observe.mjs';

// Runs only from Runner.decide after the user's own chat reply confirmed the
// screenshot. The fill Agent never reaches this module.
const SUBMIT = /提交|确认开票|申请开票|立即开票|submit|apply/i;
const UNSAFE = /验证码|发送|支付|购买|付款|pay|purchase|send/i;
const CONFIRM =
  /^(?:确认|确定|确认提交|确认开票|确认无误|提交|继续提交|立即开票|是|好|好的|ok|yes|confirm|submit)$/i;
const KNOWN_DIALOG = /确认|确定|提交|开票|核对|是否|无误|抬头|邮箱|税号|发票|信息/;
const SUCCESS =
  /提交成功|申请成功|开票成功|开具成功|已受理|受理成功|提交完成|申请已提交|发票已提交|开票申请已受理/;
const ERROR = /失败|错误|不能为空|请填写|请输入|格式不正确|有误|异常/;
const DIALOG =
  '[role=dialog],[role=alertdialog],[aria-modal=true],.van-dialog,.van-popup,.el-message-box,.el-dialog,.ant-modal,.weui-dialog,[class*=modal],[class*=dialog],[class*=popup]';

function scan({ attribute, dialog }) {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    );
  };
  const text = (el) => (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
  const fields = [...document.querySelectorAll('input,textarea,select')]
    .filter(
      (el) =>
        visible(el) &&
        !el.disabled &&
        !el.readOnly &&
        !['hidden', 'button', 'submit', 'radio', 'checkbox', 'reset', 'image'].includes(el.type),
    )
    .map((el) =>
      [el.tagName, el.name, el.id, el.placeholder, el.closest('label')?.innerText || ''].join('|'),
    );
  const dialogs = [...document.querySelectorAll(dialog)]
    .filter(visible)
    .map((el) => text(el).slice(0, 500))
    .filter(Boolean);
  const buttons = [];
  let index = 0;
  for (const el of document.querySelectorAll(
    'button,input[type=submit],input[type=button],a,[role=button]',
  )) {
    if (!visible(el) || el.disabled) continue;
    const id = String(index++);
    el.setAttribute(attribute, id);
    buttons.push({
      id,
      text: text(el).slice(0, 80),
      type: el.type || '',
      inDialog: Boolean(el.closest(dialog)),
    });
  }
  return { fields, dialogs, buttons, body: document.body?.innerText?.slice(0, 18000) || '' };
}

async function scanAll(page, attribute) {
  const frames = [];
  const origin = new URL(page.url()).origin;
  for (const frame of page.frames()) {
    if (frames.length > 10) break;
    let frameOrigin;
    try {
      frameOrigin = new URL(frame.url() || 'about:blank').origin;
    } catch {
      continue;
    }
    if (frameOrigin !== origin && !(frameOrigin === 'null' && frame.parentFrame())) continue;
    try {
      frames.push({ frame, ...(await frame.evaluate(scan, { attribute, dialog: DIALOG })) });
    } catch {
      // A frame detached during navigation; the next scan sees the new page.
    }
  }
  return frames;
}

// A write or page navigation to the invoice site after our click; plain GETs
// for images or scripts do not count as submitting.
const submissionSent = (released) =>
  released.some((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method) || r.type === 'document');
const flat = (frames, key) => frames.flatMap((frame) => frame[key]);
const buttonsOf = (frames) =>
  frames.flatMap((frame) => frame.buttons.map((button) => ({ ...button, frame: frame.frame })));

async function click(page, button, attribute) {
  await button.frame.evaluate(() => window.__invoiceSubmitPass?.(5000));
  await button.frame.locator(`[${attribute}="${button.id}"]`).click({ timeout: 10000 });
}

export async function submitInvoice({ page, guard, directory, check = () => {} }) {
  if (!guard) throw new AppError('提交拦截控制不可用，已停止', 400, 'guard_unavailable');
  const attribute = `data-invoice-submit-${Math.random().toString(16).slice(2, 10)}`;
  const record = { dialogs: [], clicks: [], startedAt: new Date().toISOString() };
  const before = await scanAll(page, attribute);
  const submits = buttonsOf(before).filter(
    (button) => (button.type === 'submit' || SUBMIT.test(button.text)) && !UNSAFE.test(button.text),
  );
  // Some mobile forms live inside a popup container; prefer buttons outside it.
  const outside = submits.filter((button) => !button.inDialog);
  const candidates = outside.length ? outside : submits;
  if (candidates.length !== 1)
    throw new AppError(
      candidates.length ? '页面有多个提交按钮，无法确定，已停止' : '找不到提交按钮，已停止',
      400,
      'submit_control_unclear',
    );
  const knownFields = new Set(flat(before, 'fields'));
  const knownDialogs = new Set(flat(before, 'dialogs'));
  const successBefore = SUCCESS.test(flat(before, 'body').join('\n'));
  let stop = null;
  const onDialog = async (dialog) => {
    const message = dialog.message().slice(0, 300);
    const accept =
      ['confirm', 'alert', 'beforeunload'].includes(dialog.type()) &&
      (dialog.type() !== 'confirm' || KNOWN_DIALOG.test(message));
    record.dialogs.push({ type: dialog.type(), message, accepted: accept });
    if (!accept) stop ||= { reason: 'unknown_dialog', text: message };
    await (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
  };
  page.on('dialog', onDialog);
  let result;
  try {
    guard.arm(30000, [new URL(page.url()).hostname]);
    const [button] = candidates;
    record.clicks.push({ text: button.text, kind: 'submit' });
    await click(page, button, attribute);
    for (let round = 0; round < 4 && !stop; round++) {
      await page.waitForTimeout(1200);
      check();
      const after = await scanAll(page, attribute);
      if (SUCCESS.test(flat(after, 'body').join('\n')) && !successBefore) break;
      const added = flat(after, 'fields').filter((field) => !knownFields.has(field));
      if (added.length) {
        stop = { reason: 'new_fields', text: `出现 ${added.length} 个新的填写项` };
        break;
      }
      const dialogs = flat(after, 'dialogs').filter((text) => !knownDialogs.has(text));
      if (!dialogs.length) break;
      const confirms = buttonsOf(after).filter(
        (button) => button.inDialog && CONFIRM.test(button.text),
      );
      if (
        round === 3 ||
        confirms.length !== 1 ||
        !dialogs.every((text) => KNOWN_DIALOG.test(text)) ||
        dialogs.some((text) => UNSAFE.test(text))
      ) {
        stop = { reason: 'unknown_dialog', text: dialogs.join(' / ').slice(0, 300) };
        break;
      }
      for (const text of dialogs) knownDialogs.add(text);
      record.clicks.push({ text: confirms[0].text, kind: 'dialog_confirm' });
      await click(page, confirms[0], attribute);
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const final = await scanAll(page, attribute);
    const text = flat(final, 'body').join('\n');
    const classified = classifyPage({ frames: [{ innerText: text }] });
    const succeeded =
      (!successBefore && SUCCESS.test(text)) ||
      ['already_issued', 'already_submitted'].includes(classified?.status);
    const sent = submissionSent(guard.released);
    const hint = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length <= 80 && ERROR.test(line));
    result = stop
      ? {
          status: 'needs_user_input',
          reasonCode: `submit_${stop.reason}`,
          message: `提交后页面出现${stop.reason === 'new_fields' ? '新的填写项' : '无法识别的提示'}，已停止，请查看截图${sent ? '；提交请求已发出，请勿重复办理' : ''}`,
          actualSubmitted: sent,
          stopText: stop.text,
        }
      : succeeded
        ? { status: 'submitted', message: '已提交，页面显示提交成功', actualSubmitted: true }
        : sent
          ? {
              status: 'submitted_unverified',
              message: `提交请求已发出，但页面未显示明确的成功结果${hint ? `（页面提示：${hint}）` : ''}；请勿重复提交，请自行核对`,
              actualSubmitted: true,
            }
          : {
              status: 'submit_failed',
              reasonCode: 'no_submit_request',
              message: `点击提交后页面没有发出提交请求${hint ? `（页面提示：${hint}）` : ''}，未提交`,
              actualSubmitted: false,
            };
  } catch (error) {
    const sent = submissionSent(guard.released);
    result = {
      status: sent ? 'submitted_unverified' : 'submit_failed',
      reasonCode: error.code || 'submit_error',
      message: sent
        ? `提交过程中出错（${safeMessage(error)}），但提交请求已发出；请勿重复提交，请自行核对`
        : `提交前出错：${safeMessage(error)}，未提交`,
      actualSubmitted: sent,
    };
  } finally {
    guard.disarm();
    page.off('dialog', onDialog);
  }
  try {
    await page.screenshot({
      path: path.join(directory, 'post-submit.png'),
      fullPage: true,
      timeout: 15000,
    });
    result.screenshot = 'post-submit.png';
  } catch (error) {
    result.screenshotError = safeMessage(error);
  }
  record.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(directory, 'submit-network.json'),
    JSON.stringify({ ...record, released: guard.released, result }, null, 2),
  );
  return { ...result, released: guard.released.length, dialogs: record.dialogs.length };
}
