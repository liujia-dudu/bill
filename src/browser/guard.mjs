import { entryRule, isPublicHost, validatePublicUrl } from '../core/validation.mjs';
import { GUARDED_TEXT, inPage } from './wording.mjs';

// The registrable part of a host: example.com for inv.example.com, and
// example.com.cn for inv.example.com.cn.
export function siteOf(host) {
  const labels = String(host || '')
    .toLowerCase()
    .split('.');
  const country = /^(?:com|net|org|gov|edu|ac)\.[a-z]{2}$/.test(labels.slice(-2).join('.'));
  return labels.slice(country ? -3 : -2).join('.');
}

const PROBE_PATH = '/api/__invoice_guard_probe__';
// Pages load exactly as in a normal browser. Only private/intranet targets and
// our own self-check probe are refused; submission safety comes from never
// letting our own actions trigger it (see pageGuard), not from second-guessing
// the page's requests.
export function requestAllowed({ url, demo = false }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'about:' || parsed.protocol === 'blob:')
    return true;
  if (!['http:', 'https:'].includes(parsed.protocol) || !isPublicHost(parsed.hostname))
    return false;
  if (parsed.pathname === PROBE_PATH) return false;
  // Offline fixtures never reach the network.
  return !demo;
}

export function pageGuard(guarded) {
  // Stops only our own actions (trusted clicks/keys) that could submit. A pass
  // is granted by the controller after the user confirmed the screenshot in
  // chat; it covers one click before it expires.
  // The pass state lives on window (one per page). Listeners may be attached
  // more than once (document.open clears them), so a grant is remembered per event.
  if (!Object.hasOwn(window, '__invoiceSubmitPass')) {
    const state = { until: 0, used: true, granted: new WeakSet() };
    Object.defineProperty(window, '__invoiceSubmitPass', {
      value: Object.assign(
        (ms) => {
          state.until = Date.now() + Math.min(Math.max(Number(ms) || 0, 0), 10000);
          state.used = false;
        },
        { state },
      ),
    });
  }
  const pass = window.__invoiceSubmitPass.state;
  const guardedText = new RegExp(guarded.source, guarded.flags);
  const take = (event) => {
    if (pass.granted.has(event)) return true;
    if (pass.used || Date.now() > pass.until) return false;
    pass.used = true;
    pass.granted.add(event);
    return true;
  };
  const stop = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  // Only trusted input is ours (Playwright/CDP); page scripts run untouched.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.isTrusted && event.key === 'Enter') stop(event);
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted) return;
      const node = event.target.closest?.(
        'button, a, input[type=submit], input[type=checkbox], [role=button]',
      );
      if (!node) return;
      const text = (node.textContent || node.value || '').trim();
      if (
        node.matches('input[type=submit],input[type=checkbox]') ||
        node.type === 'submit' ||
        guardedText.test(text)
      ) {
        if (node.type !== 'checkbox' && take(event)) return;
        stop(event);
      }
    },
    true,
  );
}

// Installs the guard on an already loaded page (fixtures set with setContent).
export const applyPageGuard = (page) => page.evaluate(pageGuard, inPage(GUARDED_TEXT));

export async function installGuard(
  context,
  { demo = false, onBlocked = () => {}, onClientEntry = () => {} } = {},
) {
  const dns = new Map();
  // Requests seen while a user-confirmed submission is armed, kept as evidence.
  const released = [];
  let armed = null;
  await context.addInitScript(pageGuard, inPage(GUARDED_TEXT));
  await context.route('**/*', async (route) => {
    const request = route.request();
    const mainFrame = request.isNavigationRequest() && request.frame().parentFrame() === null;
    if (mainFrame && entryRule(request.url())) {
      onClientEntry(entryRule(request.url()));
      await route.abort('blockedbyclient');
      return;
    }
    const url = request.url();
    let allowed = requestAllowed({ url, demo });
    if (allowed && /^https?:/.test(url)) {
      // Re-resolve per host so a public name cannot point the browser at the intranet.
      const host = new URL(url).hostname;
      if (!dns.has(host))
        dns.set(
          host,
          validatePublicUrl(url)
            .then(() => true)
            .catch(() => false),
        );
      allowed = await dns.get(host);
    }
    if (!allowed) {
      let host = '',
        path = '';
      try {
        ({ hostname: host, pathname: path } = new URL(url));
      } catch {
        // Unparseable URLs are refused without detail.
      }
      onBlocked({ host, path, method: request.method(), type: request.resourceType() });
      await route.abort('blockedbyclient');
      return;
    }
    if (armed && Date.now() <= armed.until && /^https?:/.test(url) && released.length < 200) {
      const parsed = new URL(url);
      if (siteOf(parsed.hostname) === armed.site)
        released.push({
          at: new Date().toISOString(),
          host: parsed.hostname,
          path: parsed.pathname,
          method: request.method(),
          type: request.resourceType(),
        });
    }
    await route.continue();
  });
  return {
    // Called by the runner only after a user's confirmation in chat. Requests to the
    // page's own site, any subdomain (api.example.com for inv.example.com), are
    // recorded as its submission evidence.
    arm(ms, host) {
      armed = { until: Date.now() + Math.min(Math.max(ms, 0), 60000), site: siteOf(host) };
    },
    disarm() {
      armed = null;
    },
    get armed() {
      return Boolean(armed && Date.now() <= armed.until);
    },
    released,
  };
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
