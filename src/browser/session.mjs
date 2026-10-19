import { chromium } from 'playwright';
import { Lexmount, disableLogging } from 'lexmount';
import { AppError } from '../core/validation.mjs';

disableLogging();
export async function openBrowser(engine, { demo = false, onSession = () => {} } = {}) {
  if (demo) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 430, height: 900 },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    return {
      browser,
      context,
      page,
      sessionId: null,
      close: async () => {
        await browser.close();
        return { status: 'closed', local: true };
      },
    };
  }
  if (!process.env.LEXMOUNT_API_KEY || !process.env.LEXMOUNT_PROJECT_ID)
    throw new AppError(
      '尚未配置 Lexmount，请在项目 .env 中设置 API Key 和 Project ID',
      400,
      'browser_not_configured',
    );
  const client = new Lexmount({ timeout: 25000 });
  let session, browser;
  try {
    session = await client.sessions.create({
      browserMode: engine,
      ...(engine === 'light'
        ? { enableLightmountLayout: true, enableLightmountResource: true }
        : {}),
      windowSize: '430,900',
      downloads: { enabled: false },
      recording: { persistent: false },
      enableCaptcha: false,
      pollTimeoutMs: 60000,
      pollIntervalMs: 1000,
    });
    onSession(session.id);
    browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 25000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error('No browser context');
    await context.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });
    const page = context.pages()[0] || (await context.newPage());
    await page.setViewportSize({ width: 430, height: 900 });
    let closing;
    return {
      browser,
      context,
      page,
      sessionId: session.id,
      close: () => (closing ??= cleanup(client, browser, session.id)),
    };
  } catch (error) {
    const id =
      session?.id ||
      error.sessionId ||
      String(error.message).match(/Timed out waiting for session ([\w-]+) to become active/)?.[1];
    if (id) {
      onSession(id);
      error.cleanup = await cleanup(client, browser, id);
    } else client.close();
    throw error;
  }
}
async function cleanup(client, browser, sessionId) {
  const result = {};
  try {
    if (browser) await browser.close();
    result.disconnected = true;
  } catch {
    result.disconnected = false;
  }
  try {
    await client.sessions.delete({ sessionId });
    for (let i = 0; i < 8; i++) {
      try {
        result.status = (await client.sessions.get(sessionId)).status;
      } catch (error) {
        if (error.statusCode === 404) result.status = 'closed';
        else throw error;
      }
      if (['closed', 'create_failed'].includes(result.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    if (!['closed', 'create_failed'].includes(result.status)) result.status = 'close_unconfirmed';
  } catch {
    result.status = 'close_unconfirmed';
  } finally {
    client.close();
  }
  return result;
}
export async function closeOrphan(sessionId) {
  const client = new Lexmount({ timeout: 15000 });
  return cleanup(client, null, sessionId);
}
