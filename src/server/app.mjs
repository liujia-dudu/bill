import express from 'express';
import multer from 'multer';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError, safeMessage } from '../core/validation.mjs';
import { Runner } from '../core/runner.mjs';
import { ChatService } from '../core/chat-service.mjs';
import { modelHealth } from '../agent/model-config.mjs';

export function createApp(store, config, { chatRun, taskRunner } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const runner = taskRunner || new Runner(store, config);
  const chat = new ChatService(store, config, {
    runner,
    ...(chatRun ? { run: chatRun } : {}),
  });
  app.use((req, res, next) => {
    const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
    if (!allowedHosts.has(req.headers.host))
      return res.status(403).json({ error: '仅允许本机访问' });
    if (
      req.headers.origin &&
      !new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]).has(
        req.headers.origin,
      )
    )
      return res.status(403).json({ error: '不允许跨站请求' });
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers['x-invoice-client'] !== 'local-app'
    )
      return res.status(403).json({ error: '请求来源无效' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.get('/api/health', (req, res) =>
    res.json({
      ok: true,
      version: '0.4.5',
      interface: 'conversation',
      submissionEnabled: true,
      submission: 'chat_confirmed_review',
      browserConfigured: Boolean(process.env.LEXMOUNT_API_KEY && process.env.LEXMOUNT_PROJECT_ID),
      ...modelHealth(),
      taxLookup: 'invoice_page',
    }),
  );
  // Read-only diagnostics; all product mutations go through scoped conversations.
  app.get('/api/profiles', (req, res) => res.json(store.list('profiles')));
  app.get('/api/tasks', (req, res) => res.json(store.list('tasks')));
  app.get('/api/conversations', (req, res) =>
    res.json(store.list('conversations').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
  );
  app.post('/api/conversations', (req, res) => res.status(201).json(store.createConversation()));
  app.get('/api/conversations/:id', (req, res) => res.json(chat.detail(req.params.id)));
  app.delete('/api/conversations/:id', async (req, res) =>
    res.json(await chat.deleteConversation(req.params.id)),
  );
  app.patch('/api/conversations/:id', (req, res) => {
    chat.conversation(req.params.id);
    if (typeof req.body.title !== 'string' || !req.body.title.trim() || req.body.title.length > 80)
      throw new AppError('请输入有效的对话标题');
    res.json(store.patchConversation(req.params.id, { title: req.body.title.trim() }));
  });
  app.post('/api/conversations/:id/messages', (req, res) =>
    res.status(202).json(chat.send(req.params.id, req.body, req.headers['idempotency-key'])),
  );
  app.post('/api/conversations/:id/actions', async (req, res) =>
    res.json(await chat.action(req.params.id, req.body)),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  });
  app.post('/api/conversations/:id/attachments', upload.single('file'), async (req, res) => {
    chat.conversation(req.params.id);
    res.status(201).json(await chat.attachments.upload(req.params.id, req.file));
  });
  app.get('/api/conversations/:id/attachments/:inputId', async (req, res) => {
    chat.conversation(req.params.id);
    const input = chat.attachments.require(req.params.id, req.params.inputId);
    if (!input.file || !/^[a-f0-9-]+\.(?:png|jpg|txt)$/.test(input.file))
      throw new AppError('附件不可用', 404);
    if (input.kind === 'text') res.setHeader('Content-Disposition', 'attachment');
    res.sendFile(path.join(config.dataDir, 'uploads', input.file));
  });
  app.get('/api/conversations/:id/tasks/:taskId/artifacts/:name', async (req, res) => {
    chat.conversation(req.params.id);
    const task = chat.requireTask(req.params.id, req.params.taskId);
    const artifact = task.artifacts.find((item) => item.name === req.params.name);
    if (
      !artifact ||
      !/^(?:pre-submit|post-submit|company-query|engine-check-(?:light|normal)|step-\d+)\.png$/.test(artifact.name)
    )
      throw new AppError('截图不存在', 404);
    const file = path.join(config.dataDir, 'artifacts', task.id, artifact.name);
    try {
      await stat(file);
    } catch {
      throw new AppError('截图文件已被移除', 404);
    }
    res.sendFile(file);
  });
  app.get('/api/conversations/:id/events', (req, res) => {
    chat.conversation(req.params.id);
    const id = req.params.id;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: changed\ndata: {}\n\n');
    const changed = (value) => {
      if (value === id || value?.conversationId === id) res.write('event: changed\ndata: {}\n\n');
    };
    store.on('message', changed);
    store.on('chat', changed);
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => {
      clearInterval(timer);
      store.off('message', changed);
      store.off('chat', changed);
    });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const message =
      error instanceof multer.MulterError
        ? '上传失败，请使用不超过 10 MB 的单个文件'
        : error.type === 'entity.too.large'
          ? '请求内容过大'
          : safeMessage(error);
    res
      .status(
        error instanceof AppError
          ? error.status
          : error instanceof multer.MulterError || error instanceof SyntaxError
            ? 400
            : 500,
      )
      .json({ error: message, code: error.code || 'request_failed' });
  });
  return { app, runner, chat };
}
