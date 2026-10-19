import { loadEnvFile } from 'node:process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Lexmount, disableLogging } from 'lexmount';

const root = fileURLToPath(new URL('../../', import.meta.url));
loadEnvFile(path.join(root, '.env'));
disableLogging();
const client = new Lexmount({ timeout: 15000 });
const base = path.join(root, 'data', 'lexmount-observations');
try {
  for (const folder of await readdir(base, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const target = path.join(base, folder.name, 'summary.json');
    const report = JSON.parse(await readFile(target, 'utf8'));
    for (const item of report.cases) {
      if (!item.sessionId) continue;
      let status;
      for (let poll = 0; poll < 8; poll++) {
        try {
          status = (await client.sessions.get(item.sessionId)).status;
          if (['closed', 'create_failed'].includes(status)) break;
          if (poll === 0) await client.sessions.delete({ sessionId: item.sessionId });
        } catch (error) {
          if (error?.statusCode === 404 || error?.name === 'SessionNotFoundError') {
            status = 'not_found_after_close';
          } else status = `verification_error:${error?.name}`;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      item.cleanup.finalStatus = status;
      item.cleanup.verifiedAt = new Date().toISOString();
      console.log(JSON.stringify({ runId: report.runId, caseId: item.caseId, sessionStatus: status }));
    }
    await writeFile(target, JSON.stringify(report, null, 2));
  }
} finally { client.close(); }
