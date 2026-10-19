import { AppError } from '../core/validation.mjs';
import { inspectFields } from './fields.mjs';

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

export async function observePage(page) {
  const frames = [];
  for (const [frameIndex, frame] of page.frames().entries()) {
    const data = await frame
      .evaluate(() => {
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
      })
      .catch(() => null);
    if (data)
      frames.push({
        frameIndex,
        ...data,
        controls: (
          await frame.evaluate(inspectFields, {
            selector: 'input,select,textarea,button,[role=button]',
          })
        )
          .slice(0, 100)
          .map((control) => ({
            ...control,
            id: control.stableId,
            disabled: !control.enabled,
          })),
        amounts: await frame.evaluate(inspectInvoiceAmounts),
      });
  }
  return { at: new Date().toISOString(), url: page.url(), frames };
}
export function classifyPage(observation) {
  const text = observation.frames.map((frame) => frame.innerText || frame.contentText).join('\n');
  if (/发票已开具|开票成功|已开票|发票代码[\s\S]*发票号码|下载发票|查看发票/.test(text))
    return { status: 'already_issued', message: '页面显示已有发票，已停止新的填写申请' };
  if (/发票已提交|申请已提交|已申请开票|开票申请已受理/.test(text))
    return { status: 'already_submitted', message: '页面显示已有开票申请，已停止新的填写申请' };
  if (/请在微信|微信客户端|请使用微信/.test(text))
    return {
      status: 'unsupported_browser',
      reasonCode: 'client_required',
      message: '页面要求使用微信客户端',
    };
  if (/已过期|链接失效|超过开票|开票码已失效/.test(text))
    return { status: 'failed', reasonCode: 'expired', message: '页面显示链接已失效或超过开票期限' };
  return null;
}
