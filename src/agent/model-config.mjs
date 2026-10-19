import { AppError } from '../core/validation.mjs';

export const HARNESS_VERSION = '0.2.1-alpha.4';
export function modelConfiguration(env = process.env) {
  const baseURL = (env.INVOICE_MODEL_BASE_URL || '').trim();
  const model = (env.INVOICE_MODEL_NAME || '').trim();
  const apiKey = env.INVOICE_MODEL_API_KEY || '';
  return {
    baseURL,
    model,
    apiKey,
    configured: Boolean(baseURL && model && apiKey),
    maxCalls: Number(env.INVOICE_MODEL_MAX_CALLS || 24),
    timeoutMs: Number(env.INVOICE_MODEL_TIMEOUT_MS || 900000),
  };
}
export function requireModelConfiguration() {
  const config = modelConfiguration();
  if (!config.configured)
    throw new AppError(
      '模型尚未配置：需要 INVOICE_MODEL_BASE_URL、INVOICE_MODEL_NAME 和 INVOICE_MODEL_API_KEY',
      400,
      'model_not_configured',
    );
  const parsed = new URL(config.baseURL);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new AppError('模型服务需使用不含登录信息的 HTTPS 地址', 400, 'invalid_model_config');
  if (
    !Number.isInteger(config.maxCalls) ||
    config.maxCalls < 1 ||
    config.maxCalls > 100 ||
    !Number.isFinite(config.timeoutMs) ||
    config.timeoutMs < 1000
  )
    throw new AppError('模型预算配置无效', 400, 'invalid_model_config');
  return config;
}
export function modelHealth() {
  const config = modelConfiguration();
  return {
    modelConfigured: config.configured,
    modelName: config.model || null,
    harnessVersion: HARNESS_VERSION,
    agentRuntime: 'deepseek-harness',
  };
}
