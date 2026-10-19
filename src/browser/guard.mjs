import { entryRule, isPublicHost, validatePublicUrl } from '../core/validation.mjs';

const cubeHosts = new Set(['cube-inv.jcsk100.com', 'ykb.jcsk100.com']);
const cubeReads = new Set([
  '/api/cube-ar/arInvoicePre/billingCode',
  '/api/cube-ar/openApi/detail',
  '/api/cube-system/tenant/info',
  '/api/cube-agent/openApi/getCompanyConfig',
  '/api/cube-ar/arGoods/commonlGoods',
  '/api/cube-ar/openApi/getSignaTure',
  '/api/cube-ar/open-invoice/detail',
]);
function meituanReceiptEntry(raw) {
  try {
    const url = new URL(raw);
    const hash = new URLSearchParams(url.hash.split('?')[1]);
    return (
      url.origin === 'https://invoice.meituan.com' &&
      !url.username &&
      !url.password &&
      url.pathname === '/invoice.html' &&
      !url.search &&
      url.hash.startsWith('#/eInvoice?') &&
      [...hash.keys()].every((key) =>
        ['id', 'businessSource', 'businessSourceFrom'].includes(key),
      ) &&
      ['id', 'businessSource', 'businessSourceFrom'].every(
        (key) => hash.getAll(key).length === 1,
      ) &&
      /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(hash.get('id')) &&
      hash.get('businessSource') === 'zhineng_shouyin' &&
      hash.get('businessSourceFrom') === 'zhineng_shouyin_xiaopiaoma'
    );
  } catch {
    return false;
  }
}
export function requestAllowed({
  url,
  method,
  resourceType,
  postData,
  demo = false,
  entryUrl,
  companyTitle,
}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'about:') return true;
  if (!['http:', 'https:'].includes(parsed.protocol) || !isPublicHost(parsed.hostname))
    return false;
  if (demo) return false;
  if (
    parsed.hostname === 'invoice.meituan.com' &&
    parsed.pathname === '/api/invoice/process/queryReceiptQrCode'
  ) {
    // The page reads QR/order status here; invoice application uses a separate
    // endpoint. Bind the complete desktop payload to this task's original QR.
    if (
      parsed.origin !== 'https://invoice.meituan.com' ||
      parsed.search ||
      parsed.hash ||
      method !== 'POST' ||
      !['xhr', 'fetch'].includes(resourceType) ||
      !meituanReceiptEntry(entryUrl)
    )
      return false;
    try {
      const payload = JSON.parse(postData);
      return (
        Boolean(payload) &&
        !Array.isArray(payload) &&
        Object.keys(payload).length === 4 &&
        payload.url === entryUrl &&
        payload.appChannel === '' &&
        payload.env === 3 &&
        payload.identifyToken === ''
      );
    } catch {
      return false;
    }
  }
  if (
    parsed.origin === 'https://s3.meituan.net' &&
    meituanReceiptEntry(entryUrl) &&
    method === 'GET' &&
    !postData &&
    !parsed.search &&
    !parsed.hash &&
    ['xhr', 'fetch'].includes(resourceType) &&
    /^\/static-prod01\/com\.sankuai\.fsp\.fe\.feinvoice-files\/static\/build\/(?:js|css)\/[A-Za-z\d_@.-]+\.[a-f\d]{8,64}\.(?:js|css)$/.test(
      parsed.pathname,
    )
  )
    return true;
  if (parsed.hostname === 'pos.mzdpgroup.com' && parsed.pathname === '/mobile/invoiceNew.do') {
    // This dispatcher also handles invoice creation. Validate the operation
    // and its entire payload instead of allowing the path as a whole.
    if (
      parsed.origin !== 'https://pos.mzdpgroup.com' ||
      method !== 'GET' ||
      !['xhr', 'fetch'].includes(resourceType) ||
      postData ||
      [...parsed.searchParams.keys()].some(
        (key) => !['method', 'ajaxUrl', 'json', '_'].includes(key),
      ) ||
      ['method', 'ajaxUrl', 'json', '_'].some(
        (key) => parsed.searchParams.getAll(key).length > 1,
      ) ||
      parsed.searchParams.get('ajaxUrl') !== 'y' ||
      (parsed.searchParams.has('_') && !/^\d+$/.test(parsed.searchParams.get('_')))
    )
      return false;
    try {
      const payload = JSON.parse(parsed.searchParams.get('json'));
      const entry = new URL(entryUrl);
      if (
        entry.hostname !== 'pos.mzdpgroup.com' ||
        !['http:', 'https:'].includes(entry.protocol) ||
        entry.port ||
        !['/mobile/inv/index.html', '/mzdp_pos/inv.do'].includes(entry.pathname) ||
        !payload ||
        typeof payload !== 'object' ||
        Object.keys(payload).length !== 1
      )
        return false;
      if (parsed.searchParams.get('method') === 'toFindInvoiceByOrder')
        return (
          typeof payload.orderId === 'string' &&
          /^\d{1,80}$/.test(payload.orderId) &&
          entry.searchParams.getAll('orderId').length === 1 &&
          payload.orderId === entry.searchParams.get('orderId')
        );
      if (parsed.searchParams.get('method') === 'toFindInvoiceHeader')
        return (
          typeof companyTitle === 'string' &&
          companyTitle.length > 0 &&
          companyTitle.length <= 200 &&
          payload.invoiceHeader === companyTitle
        );
    } catch {
      return false;
    }
    return false;
  }
  if (
    cubeHosts.has(parsed.hostname) &&
    parsed.pathname === '/api/cube-ar/openApi/getInvoiceHead' &&
    method === 'POST'
  ) {
    try {
      const payload = JSON.parse(postData);
      return (
        Object.keys(payload).length === 1 &&
        typeof payload.name === 'string' &&
        payload.name.length <= 200
      );
    } catch {
      return false;
    }
  }
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (cubeHosts.has(parsed.hostname) && parsed.pathname.startsWith('/api/'))
    return cubeReads.has(parsed.pathname);
  if (
    /\/(?:api|rest|rpc)\//i.test(parsed.pathname) ||
    /(?:submit|saveBuyer|saveBilling|insertCard|sendSms|sendMail|applyInvoice|openInvoice)(?:[/?]|$)/i.test(
      parsed.pathname,
    )
  )
    return false;
  if (['xhr', 'fetch', 'websocket', 'eventsource'].includes(resourceType)) return false;
  return [
    'document',
    'script',
    'stylesheet',
    'image',
    'font',
    'media',
    'manifest',
    'other',
  ].includes(resourceType);
}

export function pageGuard() {
  const stop = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener('submit', stop, true);
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter') stop(event);
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      const node = event.target.closest?.(
        'button, a, input[type=submit], input[type=checkbox], [role=button]',
      );
      if (!node) return;
      const text = (node.textContent || node.value || '').trim();
      if (
        node.matches('input[type=submit],input[type=checkbox]') ||
        node.type === 'submit' ||
        /提交|确认开票|申请开票|立即开票|发送|获取验证码|支付|购买|同意|submit|apply|confirm|agree|send|pay|purchase/i.test(
          text,
        )
      )
        stop(event);
    },
    true,
  );
  HTMLFormElement.prototype.submit = function () {
    throw new Error('真实提交已关闭');
  };
  HTMLFormElement.prototype.requestSubmit = function () {
    throw new Error('真实提交已关闭');
  };
  navigator.sendBeacon = () => false;
  window.open = () => null;
}

export async function installGuard(
  context,
  { demo = false, entryUrl, companyTitle, onBlocked = () => {}, onClientEntry = () => {} } = {},
) {
  const dns = new Map();
  await context.addInitScript(pageGuard);
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    const mainFrame = request.isNavigationRequest() && request.frame().parentFrame() === null;
    if (mainFrame && entryRule(request.url())) {
      onClientEntry(entryRule(request.url()));
      await route.abort('blockedbyclient');
      return;
    }
    const details = {
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      postData: request.postData(),
      demo,
      entryUrl,
      companyTitle,
    };
    let allowed = requestAllowed(details);
    if (allowed && /^https?:/.test(details.url)) {
      const host = new URL(details.url).hostname;
      if (!dns.has(host))
        dns.set(
          host,
          validatePublicUrl(details.url)
            .then(() => true)
            .catch(() => false),
        );
      allowed = await dns.get(host);
    }
    if (!allowed) {
      const url = new URL(request.url());
      onBlocked({
        host: url.hostname,
        path: url.pathname,
        ...(url.pathname === '/mobile/invoiceNew.do'
          ? { operation: url.searchParams.get('method') || '' }
          : {}),
        method: request.method(),
        type: request.resourceType(),
      });
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
}

export async function verifyGuard(page) {
  // A deliberately forbidden endpoint must be rejected before any page can receive profile values.
  const blocked = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/api/__invoice_guard_probe__', {
        method: 'POST',
        body: '{}',
      });
      return false;
    } catch {
      return true;
    }
  });
  if (!blocked) throw new Error('Request guard verification failed');
}
