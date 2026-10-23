import { AppError } from '../core/validation.mjs';
import { inspectFields } from './fields.mjs';
import {
  AGREEMENT_TEXT,
  ALREADY_SUBMITTED_TEXT,
  EXPIRED_TEXT,
  ISSUED_TEXT,
  MARKETING_TEXT,
  SIDE_EFFECT_TEXT,
  WECHAT_ONLY_TEXT,
  inPage,
} from './wording.mjs';

const AGREEMENT_WORDS = { agreement: inPage(AGREEMENT_TEXT), marketing: inPage(MARKETING_TEXT) };

// Read rendered amounts, including readonly inputs omitted by innerText.
export function inspectInvoiceAmounts() {
  const amounts = [];
  const visible = (node) => {
    const rect = node?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const seen = new Set();
  for (const label of document.querySelectorAll(
    'label,.van-field__label,.van-cell__title,[data-field-label]',
  )) {
    const name = label.textContent?.replace(/[\s:：*＊]/g, '') || '';
    if (!/^(?:总金额|开票金额|发票金额|价税合计|合计金额)$/.test(name)) continue;
    const row =
      label.closest('.van-cell,.formItem,.el-form-item,.form-field,.field,[data-field]') ||
      label.parentElement;
    if (!visible(label) || !visible(row) || seen.has(row)) continue;
    seen.add(row);
    const input = [...row.querySelectorAll('input,output')].find(visible);
    const amountNode = [...row.querySelectorAll('.amt-num,.van-cell__value,[data-amount]')].find(
      visible,
    );
    // Cube renders its amount in spans; Vant renders it in a readonly input.
    // Stay inside this labelled row, and preserve an explicit zero input.
    const value = (
      input?.value ??
      amountNode?.innerText ??
      [...row.children]
        .filter((node) => node !== label && !node.contains(label) && visible(node))
        .map((node) => node.innerText || '')
        .join(' ')
    ).trim();
    const match = value.replaceAll(',', '').match(/^(?:[¥￥]\s*)?(\d+(?:\.\d{1,2})?)\s*(?:元)?$/);
    amounts.push({ label: name, value, amount: match ? Number(match[1]) : null });
  }
  return amounts;
}

// Agreement checkboxes ("我已阅读并同意《用户授权协议》"). Only the program ticks them,
// inside the user-confirmed submission; the fill Agent never can. Styled checkboxes
// (Element Plus) hide the input, so visibility and text come from its wrapper.
export function inspectAgreements({ attribute, words }) {
  const pattern = (word) => new RegExp(word.source, word.flags);
  const visible = (node) => {
    const rect = node?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const result = [];
  for (const [index, box] of [...document.querySelectorAll('input[type=checkbox]')].entries()) {
    if (box.disabled) continue;
    let holder = box.closest('label') || box.parentElement;
    for (let depth = 0; holder && depth < 4; depth++) {
      if ((holder.innerText || '').trim()) break;
      holder = holder.parentElement;
    }
    const text = (holder?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!pattern(words.agreement).test(text)) continue;
    // Marketing opt-ins are never ticked on the user's behalf.
    if (pattern(words.marketing).test(text)) continue;
    if (!visible(box) && !visible(box.closest('label')) && !visible(holder)) continue;
    if (attribute) box.setAttribute(attribute, String(index));
    result.push({ id: String(index), text, checked: box.checked });
  }
  return result;
}

// Program-only (never the fill Agent): tick each unticked agreement on the invoice
// page's own frames and report which stuck. An untrusted click passes the page guard,
// which only stops our trusted input. Text naming payment, codes or sending is skipped.
export async function tickAgreements(page) {
  const attribute = `data-invoice-agree-${Math.random().toString(16).slice(2, 10)}`;
  const origin = new URL(page.url()).origin;
  const results = [];
  for (const frame of page.frames()) {
    let frameOrigin;
    try {
      frameOrigin = new URL(frame.url() || 'about:blank').origin;
    } catch {
      continue;
    }
    if (frameOrigin !== origin && !(frameOrigin === 'null' && frame.parentFrame())) continue;
    for (const box of await frame.evaluate(inspectAgreements, {
      attribute,
      words: AGREEMENT_WORDS,
    })) {
      if (box.checked) continue;
      const result = { text: box.text, checked: false };
      results.push(result);
      if (SIDE_EFFECT_TEXT.test(box.text)) continue;
      const locator = frame.locator(`[${attribute}="${box.id}"]`);
      await locator.evaluate((node) => node.click());
      await page.waitForTimeout(300);
      result.checked = await locator.isChecked();
    }
  }
  return results;
}

// The review screenshot shows unticked agreements; label each one so the user knows
// it is ticked only after their confirmation. The label is drawn over the page
// (no layout change, no events) and removed right after the screenshot.
export async function screenshotWithAgreementNotes(page, options) {
  const attribute = `data-invoice-note-${Math.random().toString(16).slice(2, 10)}`;
  const marked = [];
  for (const frame of page.frames()) {
    try {
      const boxes = await frame.evaluate(inspectAgreements, { attribute, words: AGREEMENT_WORDS });
      marked.push(frame);
      const pending = boxes.filter((box) => !box.checked);
      if (!pending.length) continue;
      await frame.evaluate(
        ({ attribute, ids }) => {
          for (const id of ids) {
            const box = document.querySelector(`[${attribute}="${id}"]`);
            const anchor = [box, box?.closest('label'), box?.parentElement].find((node) => {
              const rect = node?.getBoundingClientRect();
              return rect && rect.width > 0 && rect.height > 0;
            });
            if (!anchor) continue;
            const rect = anchor.getBoundingClientRect();
            const note = document.createElement('div');
            note.setAttribute(`${attribute}-label`, '');
            note.textContent = '确认提交后自动勾选';
            Object.assign(note.style, {
              position: 'absolute',
              left: `${rect.left + window.scrollX}px`,
              top: `${rect.top + window.scrollY - 24}px`,
              padding: '2px 6px',
              background: '#fff7e6',
              border: '1px solid #fa8c16',
              borderRadius: '4px',
              color: '#d46b08',
              font: '12px/16px sans-serif',
              pointerEvents: 'none',
              zIndex: '2147483647',
            });
            document.body.append(note);
          }
        },
        { attribute, ids: pending.map((box) => box.id) },
      );
    } catch {
      // A frame that cannot be read is captured as is.
    }
  }
  try {
    await page.screenshot(options);
  } finally {
    for (const frame of marked)
      await frame
        .evaluate((attribute) => {
          document.querySelectorAll(`[${attribute}-label]`).forEach((node) => node.remove());
          document
            .querySelectorAll(`[${attribute}]`)
            .forEach((node) => node.removeAttribute(attribute));
        }, attribute)
        .catch(() => {});
  }
}

export function assertInvoiceAmounts(observation) {
  const amounts = observation.frames.flatMap((frame) => frame.amounts || []);
  const url = new URL(observation.url);
  const required =
    url.origin === 'https://pos.mzdpgroup.com' && url.pathname === '/mobile/inv/index.html';
  if (required && !amounts.length)
    throw new AppError('尚未读取到订单金额，已停止填写，请重试', 400, 'order_not_loaded');
  if (amounts.some((item) => item.amount === null))
    throw new AppError(
      '尚未读到有效订单金额，已停止填写，请重试或核对原页面',
      400,
      'order_not_loaded',
    );
  if (amounts.some((item) => item.amount <= 0))
    throw new AppError(
      '订单金额未加载成功或为 0，已停止填写，请重试或核对原页面',
      400,
      'invalid_invoice_amount',
    );
  return amounts;
}

export function watchInvoiceOrder(page) {
  const reads = new Map();
  const onResponse = (response) => {
    const url = new URL(response.url());
    if (
      !['https://cube-inv.jcsk100.com', 'https://ykb.jcsk100.com'].includes(url.origin) ||
      url.pathname !== '/api/cube-ar/arInvoicePre/billingCode' ||
      response.request().method() !== 'GET'
    )
      return;
    const serial = url.searchParams.get('serialNo');
    if (!serial) return;
    reads.set(
      serial,
      response
        .json()
        .then((body) => ({
          success: response.ok() && body.code === 200,
          amount: body.data?.data?.invoiceSum,
        }))
        .catch(() => ({ success: false })),
    );
  };
  page.on('response', onResponse);
  return {
    async wait(serial) {
      const started = Date.now();
      while (!reads.has(serial)) {
        if (Date.now() - started > 15000)
          throw new AppError('订单读取未完成，已停止填写，请重试', 400, 'order_not_loaded');
        await page.waitForTimeout(100);
      }
      let timer;
      let read;
      try {
        read = await Promise.race([
          reads.get(serial),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ success: false }), 15000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!read.success)
        throw new AppError('订单读取失败，已停止填写，请重试', 400, 'order_not_loaded');
      return read;
    },
    close: () => page.off('response', onResponse),
  };
}

export async function waitForInvoiceReady(page, orderRead) {
  const url = new URL(page.url());
  if (
    ['https://cube-inv.jcsk100.com', 'https://ykb.jcsk100.com'].includes(url.origin) &&
    url.hash.startsWith('#/qrCodeBilling?')
  ) {
    const serial = new URLSearchParams(url.hash.split('?')[1]).get('serialNo');
    if (!orderRead || !serial)
      throw new AppError('尚未核对订单读取结果，已停止填写', 400, 'order_not_loaded');
    const read = await orderRead.wait(serial);
    // Other result states may redirect to issued/expired pages; classify them
    // normally instead of treating the form's placeholder as an order amount.
    if (read.amount == null) {
      if (!new URL(page.url()).hash.startsWith('#/qrCodeBilling?')) return;
      throw new AppError('订单没有返回有效金额，已停止填写', 400, 'order_not_loaded');
    }
    const amount = Number(read.amount);
    if (!Number.isFinite(amount) || amount <= 0)
      throw new AppError('订单金额为 0 或无效，已停止填写', 400, 'invalid_invoice_amount');
    try {
      await page.waitForFunction(
        (expected) =>
          [...document.querySelectorAll('.formItem')].some(
            (row) =>
              row.querySelector('label')?.textContent.trim() === '开票金额' &&
              Number(row.querySelector('.amt-num')?.textContent.replaceAll(',', '').trim()) ===
                expected,
          ),
        amount,
        { timeout: 15000 },
      );
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      throw new AppError('页面金额与订单读取结果尚未一致，已停止填写', 400, 'order_not_loaded');
    }
    return;
  }
  if (url.origin !== 'https://pos.mzdpgroup.com' || url.pathname !== '/mobile/inv/index.html')
    return;
  try {
    await page.waitForFunction(
      () => {
        const label = [...document.querySelectorAll('.van-field__label')].find(
          (node) => node.textContent?.trim() === '总金额',
        );
        const value = label?.closest('.van-cell')?.querySelector('input')?.value || '';
        return /^¥\s*\d/.test(value) && Number(value.replace(/[¥,\s]/g, '')) > 0;
      },
      null,
      { timeout: 15000 },
    );
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    // Issued/expired redirects still need the normal page classification.
  }
}

// Playwright's evaluate has no timeout; light can leave it pending forever on pages it
// renders badly, so bound each read and report it as an observation failure.
const OBSERVE_TIMEOUT_MS = 10000;
function evaluateWithin(frame, fn, arg) {
  let timer;
  return Promise.race([
    frame.evaluate(fn, arg),
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new AppError('网页读取超时，未能识别页面内容', 400, 'page_observation_failed')),
        OBSERVE_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function observePage(page) {
  const frames = [];
  for (const [frameIndex, frame] of page.frames().entries()) {
    const data = await evaluateWithin(frame, () => {
      const clean = document.body?.cloneNode(true);
      clean?.querySelectorAll('script,style,noscript').forEach((node) => node.remove());
      return {
        title: document.title,
        innerText: document.body?.innerText?.slice(0, 20000) || '',
        contentText: clean?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 20000) || '',
        agreements: [...document.querySelectorAll('a')]
          .filter((node) => /协议|条款|隐私|agreement|terms/i.test(node.textContent || ''))
          .map((node) => ({
            text: node.textContent.trim(),
            target: node.getAttribute('href') || '',
          })),
        headings: [...document.querySelectorAll('h1,h2,h3,legend,[role=heading]')].map((node) =>
          node.textContent.trim(),
        ),
        selectedOptions: [...document.querySelectorAll('select')].map((node) =>
          [...node.selectedOptions].map((option) => option.textContent.trim()),
        ),
      };
    }).catch((error) => {
      if (frameIndex === 0 && error.code === 'page_observation_failed') throw error;
      return null;
    });
    if (data)
      frames.push({
        frameIndex,
        ...data,
        controls: (
          await evaluateWithin(frame, inspectFields, {
            selector: 'input,select,textarea,button,[role=button]',
          })
        )
          .slice(0, 100)
          .map((control) => ({
            ...control,
            id: control.stableId,
            disabled: !control.enabled,
          })),
        amounts: await evaluateWithin(frame, inspectInvoiceAmounts),
        agreementBoxes: await evaluateWithin(frame, inspectAgreements, { words: AGREEMENT_WORDS }),
      });
  }
  return { at: new Date().toISOString(), url: page.url(), frames };
}
export function classifyPage(observation) {
  const text = observation.frames.map((frame) => frame.innerText || frame.contentText).join('\n');
  if (ISSUED_TEXT.test(text))
    return {
      status: 'already_issued',
      message: '页面显示这笔订单已开过发票，已停止重复填写；如确需重开请先核对上一条记录',
    };
  if (ALREADY_SUBMITTED_TEXT.test(text))
    return { status: 'already_submitted', message: '页面显示已有开票申请，已停止新的填写申请' };
  if (WECHAT_ONLY_TEXT.test(text))
    return {
      status: 'unsupported_browser',
      reasonCode: 'client_required',
      message: '页面要求使用微信客户端',
    };
  if (EXPIRED_TEXT.test(text))
    return { status: 'failed', reasonCode: 'expired', message: '页面显示链接已失效或超过开票期限' };
  return null;
}
