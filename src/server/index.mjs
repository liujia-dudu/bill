import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { configuration } from './config.mjs';
import { Store } from '../storage/store.mjs';
import { createApp } from './app.mjs';

const config = configuration();
const lockFile = path.join(config.dataDir, '.instance.lock');
function acquireLock() {
  try {
    const fd = openSync(lockFile, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try {
      owner = JSON.parse(readFileSync(lockFile, 'utf8')).pid;
    } catch {
      throw new Error('数据目录锁无法读取，请确认没有其他实例后移除 data/.instance.lock');
    }
    try {
      process.kill(owner, 0);
      throw new Error('已有实例在使用此数据目录');
    } catch (probe) {
      if (probe.code !== 'ESRCH') throw probe;
    }
    unlinkSync(lockFile);
    const fd = openSync(lockFile, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    closeSync(fd);
  }
}
acquireLock();
let store, runner, server, vite, chat;
const releaseLock = () => {
  try {
    if (JSON.parse(readFileSync(lockFile, 'utf8')).pid === process.pid) unlinkSync(lockFile);
  } catch {}
};
process.on('exit', releaseLock);
try {
  store = new Store(config.dataDir);
  const created = createApp(store, config);
  runner = created.runner;
  chat = created.chat;
  const app = created.app;
  if (process.argv.includes('--dev')) {
    const { createServer: createVite } = await import('vite');
    vite = await createVite({
      configFile: path.join(config.root, 'vite.config.mjs'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    if (!existsSync(path.join(config.root, 'dist/index.html')))
      throw new Error('请先运行 npm run build，或使用 npm run dev');
    app.use(express.static(path.join(config.root, 'dist')));
    app.get('/{*path}', (req, res) => res.sendFile(path.join(config.root, 'dist/index.html')));
  }
  await runner.recover();
  server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  console.log(`Invoice Desk running at http://127.0.0.1:${config.port} (real submission disabled)`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    await chat.close();
    await runner.close();
    for (let i = 0; runner.running && i < 40; i++)
      await new Promise((resolve) => setTimeout(resolve, 250));
    await vite?.close();
    server.closeAllConnections();
    store.close();
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error(error.message);
  await vite?.close();
  store?.close();
  releaseLock();
  process.exitCode = 1;
}
