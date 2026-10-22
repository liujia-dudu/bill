import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export class AppError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
export const fieldNames = {
  title: '发票抬头',
  taxId: '税号',
  email: '收票邮箱',
  phone: '手机号码',
  address: '公司地址',
  telephone: '公司电话',
  bankName: '开户银行',
  bankAccount: '银行账号',
};
// Personal invoices rarely need a name; the conventional title is just "个人".
export const PERSONAL_TITLE = '个人';
export function normalizeProfile(value) {
  if (!value || !['enterprise', 'personal'].includes(value.type))
    throw new AppError('请选择企业或个人抬头');
  const profile = { type: value.type, isDefault: value.isDefault === true };
  for (const key of Object.keys(fieldNames)) {
    if (value[key] != null && typeof value[key] !== 'string')
      throw new AppError(`${fieldNames[key]}格式错误`);
    profile[key] = (value[key] || '').trim();
    if (profile[key].length > (key === 'address' ? 500 : 200))
      throw new AppError(`${fieldNames[key]}过长`);
  }
  profile.taxId = profile.taxId.toUpperCase();
  if (profile.type === 'personal') {
    for (const key of ['taxId', 'address', 'telephone', 'bankName', 'bankAccount'])
      profile[key] = '';
    profile.title ||= PERSONAL_TITLE;
  }
  return profile;
}
export function profileProblems(profile, full = true) {
  const problems = [];
  if (!profile.title) problems.push('请填写完整发票抬头');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) problems.push('请填写有效收票邮箱');
  if (
    full &&
    profile.type === 'enterprise' &&
    !/^(?:[A-Z0-9]{15}|[A-Z0-9]{18}|[A-Z0-9]{20})$/.test(profile.taxId)
  )
    problems.push('请核对企业税号（15、18 或 20 位字母数字）');
  if (profile.phone && !/^\+?[\d -]{7,20}$/.test(profile.phone)) problems.push('请核对手机号码');
  return problems;
}
export function parseWebUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 8192) throw new AppError('请输入完整网页地址');
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError('网页地址格式不正确');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new AppError('只支持不含登录凭据的 HTTP/HTTPS 地址');
  if (!isPublicHost(url.hostname)) throw new AppError('不支持本机或内网地址', 400, 'private_url');
  return url;
}
export function isPublicHost(host) {
  host = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    host === 'localhost' ||
    /\.(?:localhost|local|internal|lan)$/.test(host) ||
    (!host.includes('.') && !net.isIP(host))
  )
    return false;
  if (net.isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224 ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIP(host) === 6) return !/^(?:::|f[cd]|fe[89ab])/i.test(host);
  return true;
}
export async function validatePublicUrl(raw) {
  const url = parseWebUrl(raw);
  let addresses;
  try {
    addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  } catch {
    throw new AppError('无法解析目标网站地址', 400, 'dns_error');
  }
  if (!addresses.length || addresses.some((item) => !isPublicHost(item.address)))
    throw new AppError('目标地址解析到内网，已停止', 400, 'private_url');
  return url;
}
export function entryRule(raw, { mainFrame = true } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    ['kiwa-tech.com', 'www.kiwa-tech.com'].includes(url.hostname) &&
    url.pathname.startsWith('/scanIOrder')
  )
    return {
      status: 'unsupported_browser',
      reasonCode: 'known_client_entry',
      message: '此入口已标记为需要客户端打开（用户确认）',
      source: 'user_confirmed',
    };
  if (
    mainFrame &&
    url.protocol === 'https:' &&
    !url.port &&
    url.hostname === 'open.weixin.qq.com' &&
    url.pathname === '/connect/oauth2/authorize'
  )
    return {
      status: 'unsupported_browser',
      reasonCode: 'wechat_oauth_required',
      message: '此流程需要微信内授权，本环境无法办理；请在微信中扫码开具',
      source: 'redirect_rule',
    };
  return null;
}
export function safeMessage(error) {
  if (error instanceof AppError) return error.message;
  const message = String(error?.message || error).replace(
    /(?:https?|wss?):\/\/[^\s"'<>]+/g,
    '[地址已隐藏]',
  );
  if (/Executable doesn't exist/.test(message))
    return '本地演示浏览器未安装，请运行 npm run browser:install';
  if (/Timeout|timeout|timed out/i.test(message))
    return '网页操作超时，已停止。可查看截图后更换引擎或重新准备。';
  return '本次操作未完成，请检查网站状态和运行环境后重新准备。';
}
