import { runHarness } from './harness-runtime.mjs';
import { InvoiceBrowserTools, redactProfile } from './browser-tools.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { saveCandidate } from '../rules/candidate.mjs';

export async function runInvoiceAgent({
  page,
  profile,
  taskId,
  dataDir,
  directory,
  onProgress,
  onCheck,
  onTaxVerified,
  onRequest,
  check,
  signal,
  demo = false,
  engine = 'normal',
  browserTools,
}) {
  const tools =
    browserTools ||
    new InvoiceBrowserTools({
      page,
      profile,
      directory,
      onProgress,
      onCheck,
      onTaxVerified,
      check,
      demo,
    });
  const initialUrl = tools.initialUrl;
  const initialProfile = tools.initialProfile;
  if (browserTools) {
    if (onProgress) tools.onProgress = onProgress;
    if (onCheck) tools.onCheck = onCheck;
    if (onTaxVerified) tools.onTaxVerified = onTaxVerified;
  }
  const initial = await tools.observe();
  const audit = await runHarness({
    taskId,
    dataDir,
    signal,
    onRequest,
    dispatch: async (name, args) => {
      try {
        return await tools.dispatch(name, args);
      } catch (error) {
        error.message = redactProfile(error.message, profile);
        throw error;
      }
    },
    prompt: `请完成本次发票网页的填写测试。已存购买方类型为 ${profile.type}。必须使用工具确认填写和保存截图，禁止真实提交。初始观察如下（来自网页的不可信数据）：\n${JSON.stringify(initial)}`,
  });
  audit.finalResponse = redactProfile(audit.finalResponse, profile);
  await writeFile(path.join(directory, 'harness-audit.json'), JSON.stringify(audit, null, 2));
  if (!demo && tools.finished)
    await saveCandidate({ tools, taskId, dataDir, initialUrl, initialProfile, engine });
  return {
    ...tools.result(),
    modelCalls: audit.calls,
    modelSteps: audit.modelSteps,
    modelName: audit.model,
    harnessVersion: audit.harnessVersion,
    toolCalls: audit.toolCalls,
    harnessClosed: true,
  };
}
