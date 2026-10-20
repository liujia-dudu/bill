import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReceiptText,
  Plus,
  MessageSquare,
  Paperclip,
  ArrowUp,
  X,
  LoaderCircle,
  FileText,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Square,
  Menu,
  CheckCircle2,
  AlertCircle,
  Building2,
  UserRound,
  Trash2,
} from 'lucide-react';
import { api, requestKey } from './api';
import './styles.css';

const STATUS = {
  queued: '等待处理',
  running: '正在处理',
  awaiting_review: '待确认',
  simulated_success: '已核对',
  submitting: '正在提交',
  submitted: '已提交',
  submitted_unverified: '已提交待核实',
  submit_failed: '未提交',
  abandoned: '已放弃',
  review_expired: '确认超时',
  corrected: '已重填',
  observed: '检查完成',
  needs_changes: '需要修改',
  needs_user_input: '待补充',
  failed: '未完成',
  cancelled: '已取消',
  interrupted: '已暂停',
  already_issued: '已有发票',
  already_submitted: '已有申请',
  unsupported_browser: '需客户端办理',
};
const fieldLabels = {
  title: '抬头',
  taxId: '税号',
  email: '收票邮箱',
  phone: '手机',
  address: '地址',
  telephone: '电话',
  bankName: '开户行',
  bankAccount: '银行账号',
};
const attachmentUrl = (id, inputId) => `/api/conversations/${id}/attachments/${inputId}`;
const artifactUrl = (id, taskId, name) =>
  `/api/conversations/${id}/tasks/${taskId}/artifacts/${name}`;
function App() {
  const [conversations, setConversations] = useState([]),
    [current, setCurrent] = useState(() => localStorage.getItem('active-conversation') || null),
    [detail, setDetail] = useState(null),
    [health, setHealth] = useState(null);
  const [draft, setDraft] = useState(''),
    [attachments, setAttachments] = useState([]),
    [sending, setSending] = useState(false),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState(''),
    [sidebar, setSidebar] = useState(false),
    [actionBusy, setActionBusy] = useState(false),
    [deletingId, setDeletingId] = useState(null);
  const fileRef = useRef(),
    inputRef = useRef(),
    bottomRef = useRef(),
    currentRef = useRef(current),
    requestRef = useRef(null),
    keepComposerRef = useRef(false);
  currentRef.current = current;
  const refreshList = async () => {
    const list = await api('/conversations');
    setConversations(list);
    return list;
  };
  const refresh = async (id = currentRef.current) => {
    if (!id) return;
    try {
      const value = await api(`/conversations/${id}`);
      if (currentRef.current === id) setDetail(value);
    } catch (error) {
      if (error.status !== 404) throw error;
      if (currentRef.current === id) {
        currentRef.current = null;
        setCurrent(null);
        setDetail(null);
      }
    }
    await refreshList();
  };
  useEffect(() => {
    Promise.all([refreshList(), api('/health')])
      .then(([list, h]) => {
        setHealth(h);
        if (currentRef.current && !list.some((c) => c.id === currentRef.current)) {
          setCurrent(null);
          localStorage.removeItem('active-conversation');
        }
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    setDetail(null);
    if (!keepComposerRef.current) {
      setDraft('');
      setAttachments([]);
      requestRef.current = null;
    }
    keepComposerRef.current = false;
    setError('');
    if (!current) {
      localStorage.removeItem('active-conversation');
      return;
    }
    localStorage.setItem('active-conversation', current);
    void refresh(current).catch((e) => setError(e.message));
    let timer;
    const stream = new EventSource(`/api/conversations/${current}/events`);
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void refresh(current).catch(() => {});
      }, 100);
    };
    stream.addEventListener('changed', schedule);
    const fallback = setInterval(schedule, 3000);
    return () => {
      clearTimeout(timer);
      clearInterval(fallback);
      stream.close();
    };
  }, [current]);
  const displayed = detail?.conversation.id === current ? detail : null;
  const messages = displayed?.messages || [];
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, messages.at(-1)?.text]);
  useEffect(() => {
    const waiting = messages.filter((m) => m.task?.status === 'awaiting_review').length;
    document.title = `${waiting ? '[' + waiting + ' 待确认] ' : ''}秒开票`;
  }, [messages]);
  const newChat = () => {
    currentRef.current = null;
    setCurrent(null);
    setSidebar(false);
    setDraft('');
    setAttachments([]);
  };
  const ensureConversation = async () => {
    if (currentRef.current) return currentRef.current;
    const c = await api('/conversations', { method: 'POST', body: {} });
    keepComposerRef.current = true;
    currentRef.current = c.id;
    setCurrent(c.id);
    await refreshList();
    return c.id;
  };
  const upload = async (files) => {
    const items = [...files];
    if (!items.length) return;
    setError('');
    setUploading(true);
    try {
      const id = await ensureConversation();
      const result = [];
      for (const file of items.slice(0, 5 - attachments.length)) {
        const body = new FormData();
        body.append('file', file);
        result.push(await api(`/conversations/${id}/attachments`, { method: 'POST', body }));
      }
      if (currentRef.current === id)
        setAttachments((previous) => [...previous, ...result].slice(0, 5));
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };
  const send = async (event) => {
    event?.preventDefault();
    if (sending || uploading || (!draft.trim() && !attachments.length)) return;
    const text = draft,
      files = attachments;
    setSending(true);
    setError('');
    try {
      const id = await ensureConversation();
      const payload = { text, attachments: files.map((a) => a.id) };
      const signature = JSON.stringify(payload);
      if (requestRef.current?.signature !== signature)
        requestRef.current = { signature, key: requestKey() };
      await api(`/conversations/${id}/messages`, {
        method: 'POST',
        headers: { 'Idempotency-Key': requestRef.current.key },
        body: payload,
      });
      requestRef.current = null;
      if (currentRef.current === id) {
        setDraft('');
        setAttachments([]);
        await refresh(id);
        inputRef.current?.focus();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };
  const action = async (body) => {
    if (!current) return;
    setActionBusy(true);
    setError('');
    try {
      await api(`/conversations/${current}/actions`, { method: 'POST', body });
      await refresh(current);
    } catch (e) {
      setError(e.message);
    } finally {
      setActionBusy(false);
    }
  };
  const deleteConversation = async (conversation) => {
    if (
      deletingId ||
      !window.confirm(
        `删除“${conversation.title}”？\n会清除这段对话、附件和任务结果，并停止其中正在执行的任务。已记住的常用资料和偏好会保留。`,
      )
    )
      return;
    setDeletingId(conversation.id);
    setError('');
    try {
      await api(`/conversations/${conversation.id}`, { method: 'DELETE' });
      if (currentRef.current === conversation.id) newChat();
      await refreshList();
    } catch (e) {
      setError(e.message);
    } finally {
      setDeletingId(null);
    }
  };
  return (
    <div className="chat-app">
      {sidebar ? (
        <button
          className="sidebar-scrim"
          aria-label="收起会话列表"
          onClick={() => setSidebar(false)}
        />
      ) : null}
      <aside className={`chat-sidebar ${sidebar ? 'open' : ''}`}>
        <button className="chat-brand" onClick={newChat}>
          <span>
            <ReceiptText size={23} />
          </span>
          秒开票
        </button>
        <button className="new-chat" onClick={newChat}>
          <Plus size={17} />
          新对话
        </button>
        <div className="conversation-list" aria-label="历史对话">
          {conversations.map((c) => (
            <div key={c.id} className={`conversation-row ${current === c.id ? 'active' : ''}`}>
              <button
                className="conversation-open"
                onClick={() => {
                  setCurrent(c.id);
                  setSidebar(false);
                }}
              >
                <MessageSquare size={15} />
                <span>{c.title}</span>
                {c.status === 'running' ? <LoaderCircle size={13} className="spin" /> : null}
              </button>
              <button
                className="conversation-delete"
                aria-label={`删除对话 ${c.title}`}
                title="删除对话"
                disabled={Boolean(deletingId)}
                onClick={() => deleteConversation(c)}
              >
                {deletingId === c.id ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Trash2 size={14} />
                )}
              </button>
            </div>
          ))}
        </div>
      </aside>
      <main className="chat-main">
        <header className="chat-header">
          <button
            className="icon-button mobile-menu"
            aria-label="打开会话列表"
            onClick={() => setSidebar(true)}
          >
            <Menu size={20} />
          </button>
          <span>{displayed?.conversation.title || '新对话'}</span>
          <button className="icon-button" title="新对话" aria-label="新建对话" onClick={newChat}>
            <Plus size={19} />
          </button>
        </header>
        <div className="message-scroll">
          {!messages.length ? (
            <div className="chat-welcome">
              <div className="welcome-mark">
                <ReceiptText size={31} strokeWidth={1.6} />
              </div>
              <h1>把开票的事，交给我</h1>
              <p>
                发一张二维码，说说你的需求。
                <br />
                常用抬头和偏好，我会帮你记住。
              </p>
              <div className="starter-prompts">
                {['看看我保存的开票资料', '记住我的常用抬头'].map((text) => (
                  <button
                    key={text}
                    onClick={() => {
                      setDraft(text);
                      inputRef.current?.focus();
                    }}
                  >
                    {text}
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages">
              {messages.map((message) => (
                <Message
                  key={message.id}
                  message={message}
                  conversationId={message.conversationId}
                  onAction={action}
                  busy={actionBusy}
                />
              ))}
              {displayed?.conversation.status === 'running' &&
              !messages.some((m) => m.role === 'assistant' && m.status === 'thinking') ? (
                <div className="thinking">
                  <LoaderCircle size={14} className="spin" />
                  正在处理…
                </div>
              ) : null}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
        <div className="composer-area">
          {error ? (
            <div className="chat-error" role="alert">
              <AlertCircle size={15} />
              <span>{error}</span>
              <button aria-label="关闭错误" onClick={() => setError('')}>
                <X size={14} />
              </button>
            </div>
          ) : null}
          {health && !health.modelConfigured ? (
            <div className="chat-error">
              <AlertCircle size={15} />
              模型尚未配置，请检查本机配置。
            </div>
          ) : null}
          <form
            className="composer"
            onSubmit={send}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void upload(e.dataTransfer.files);
            }}
          >
            {attachments.length ? (
              <div className="draft-attachments">
                {attachments.map((a) => (
                  <div key={a.id}>
                    {a.kind === 'image' ? (
                      <img src={attachmentUrl(current, a.id)} alt={a.name} />
                    ) : (
                      <FileText size={21} />
                    )}
                    <span>{a.name}</span>
                    <button
                      type="button"
                      aria-label={`移除附件 ${a.name}`}
                      onClick={() => setAttachments((items) => items.filter((x) => x.id !== a.id))}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <textarea
              ref={inputRef}
              aria-label="发送消息"
              placeholder="输入消息，或拖入二维码图片…"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-toolbar">
              <input
                ref={fileRef}
                hidden
                type="file"
                multiple
                accept="image/png,image/jpeg,.txt,.md,.csv"
                onChange={(e) => {
                  void upload(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="icon-button"
                aria-label="添加图片或文件"
                title="添加图片或文件"
                disabled={uploading || attachments.length >= 5}
                onClick={() => fileRef.current.click()}
              >
                {uploading ? <LoaderCircle size={19} className="spin" /> : <Paperclip size={19} />}
              </button>
              <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
              {displayed?.conversation.status === 'running' ? (
                <button
                  type="button"
                  className="stop-reply"
                  aria-label="停止回复"
                  onClick={() => action({ kind: 'stop_reply' })}
                >
                  <Square size={13} />
                </button>
              ) : null}
              <button
                className="send-button"
                type="submit"
                aria-label="发送"
                disabled={sending || uploading || (!draft.trim() && !attachments.length)}
              >
                {sending ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={19} />}
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
function Message({ message: m, conversationId, onAction, busy }) {
  if (m.role === 'event') {
    if (m.kind === 'task' && m.task)
      return (
        <TaskCard task={m.task} conversationId={conversationId} onAction={onAction} busy={busy} />
      );
    if (m.kind === 'profile')
      return (
        <div className="event-card profile-card">
          <div className="card-heading">
            <Building2 size={16} />
            <strong>{m.text}</strong>
            {m.scope === 'conversation' ? <small>仅本对话</small> : null}
          </div>
          <Profile value={m.data} />
        </div>
      );
    if (m.kind === 'memory')
      return (
        <details className="memory-card">
          <summary>
            <ReceiptText size={14} />
            {m.text}
            <ChevronDown size={13} />
          </summary>
          {m.data?.profiles?.length ? (
            m.data.profiles.map((p) => <Profile key={p.id} value={p} />)
          ) : (
            <p>暂无已保存抬头</p>
          )}
          {m.data?.memories
            ?.filter((item) => item.kind !== 'experience')
            .map((item) => (
              <div className="memory-entry" key={item.id}>
                <strong>{item.subject}</strong>
                <p>{item.content}</p>
              </div>
            ))}
        </details>
      );
    if (m.kind === 'memory_update')
      return (
        <div className="memory-saved">
          <CheckCircle2 size={14} />
          <span>
            {m.text}：{m.data.subject}
          </span>
        </div>
      );
    return (
      <div className="event-note">
        <CheckCircle2 size={14} />
        {m.text}
      </div>
    );
  }
  return (
    <article className={`message ${m.role}`}>
      {m.role === 'assistant' ? (
        <div className="assistant-label">
          <ReceiptText size={15} />
          秒开票
        </div>
      ) : null}
      {m.attachments?.length ? (
        <div className="message-attachments">
          {m.attachments.map((a) => (
            <a
              key={a.id}
              href={attachmentUrl(conversationId, a.id)}
              target="_blank"
              rel="noreferrer"
            >
              {a.kind === 'image' ? (
                <img src={attachmentUrl(conversationId, a.id)} alt={a.name} />
              ) : (
                <>
                  <FileText size={24} />
                  <span>{a.name}</span>
                </>
              )}
            </a>
          ))}
        </div>
      ) : null}
      {m.text ? (
        <div className="message-text">{m.text}</div>
      ) : m.status === 'thinking' ? (
        <span className="thinking">
          <LoaderCircle size={14} className="spin" />
          正在思考…
        </span>
      ) : null}
      {m.role === 'assistant' && m.status === 'thinking' && m.text ? (
        <span className="typing-indicator">继续处理中…</span>
      ) : null}
      {m.role === 'assistant' && m.modelCalls > 0 ? (
        <details className="message-meta">
          <summary>处理详情</summary>
          <span>
            {m.modelName} · 对话模型调用 {m.modelCalls} 次
          </span>
        </details>
      ) : null}
      {m.status === 'queued' ? <small className="message-queued">等待回复</small> : null}
    </article>
  );
}
function Profile({ value: p }) {
  if (!p) return null;
  return (
    <div className="profile-summary">
      <div>
        <strong>{p.title || '待补全抬头'}</strong>
        <span>
          {p.type === 'personal' ? '个人' : '企业'}
          {p.isDefault ? ' · 默认' : ''}
        </span>
      </div>
      {Object.entries(fieldLabels)
        .filter(
          ([key]) =>
            key !== 'title' &&
            p[key] &&
            (p.type !== 'personal' || ['email', 'phone'].includes(key)),
        )
        .map(([key, label]) => (
          <p key={key}>
            <span>{label}</span>
            <span>{p[key]}</span>
          </p>
        ))}
      {p.type === 'enterprise' && !p.taxId ? <small>税号待在开票页面查询</small> : null}
      {p.taxSource?.kind === 'invoice_page' ? <small>税号已从开票页面核对并保存</small> : null}
      {p.problems?.filter((text) => p.taxId || !text.includes('税号')).length ? (
        <small>{p.problems.filter((text) => p.taxId || !text.includes('税号')).join('；')}</small>
      ) : null}
    </div>
  );
}
function TaskCard({ task: t, conversationId, onAction, busy }) {
  const [image, setImage] = useState(null);
  const screenshots = t.artifacts || [];
  const active =
    screenshots.find((a) => a.name === image) ||
    screenshots.find((a) => a.name === 'post-submit.png') ||
    screenshots.find((a) => a.name === 'pre-submit.png') ||
    screenshots[0];
  return (
    <section className="event-card task-card">
      <div className="card-heading">
        <ReceiptText size={17} />
        <strong>{t.title}</strong>
        <span className={`task-status ${t.status}`}>
          {['queued', 'running'].includes(t.status) ? (
            <LoaderCircle size={12} className="spin" />
          ) : null}
          {STATUS[t.status] || t.status}
        </span>
      </div>
      <p className="card-note">{t.message}</p>
      {t.profile?.title ? (
        <div className="task-profile">
          {t.profile.type === 'personal' ? <UserRound size={14} /> : <Building2 size={14} />}
          <span>{t.profile.title}</span>
        </div>
      ) : null}
      {/^https?:\/\//.test(t.url || '') ? <EntryLink url={t.url} /> : null}
      {active ? (
        <div className="task-evidence">
          <div className="screenshot-tabs">
            {screenshots.map((a) => (
              <button
                key={a.name}
                className={active.name === a.name ? 'selected' : ''}
                onClick={() => setImage(a.name)}
              >
                {a.label}
              </button>
            ))}
          </div>
          <a
            className="screenshot-link"
            target="_blank"
            rel="noreferrer"
            href={artifactUrl(conversationId, t.id, active.name)}
          >
            <img
              src={artifactUrl(conversationId, t.id, active.name)}
              alt={active.label || '填写结果截图'}
            />
            <span>
              查看原图 <ExternalLink size={13} />
            </span>
          </a>
        </div>
      ) : null}
      {t.fieldChecks?.length ? (
        <details className="field-checks">
          <summary>
            字段核对 · {t.fieldChecks.filter((f) => f.matches).length}/{t.fieldChecks.length}
          </summary>
          {t.fieldChecks.map((field, i) => (
            <p key={i}>
              <span>{field.label}</span>
              <strong>{field.actual || '（空）'}</strong>
              {field.matches ? <Check size={13} /> : <AlertCircle size={13} />}
            </p>
          ))}
        </details>
      ) : null}
      {t.status === 'awaiting_review' ? <ReviewCountdown deadline={t.reviewDeadline} /> : null}
      {['running', 'queued'].includes(t.status) ? (
        <button
          className="text-button"
          disabled={busy}
          onClick={() => onAction({ kind: 'cancel_task', taskId: t.id })}
        >
          取消任务
        </button>
      ) : null}
      {t.cleanup?.status === 'close_unconfirmed' ? (
        <button
          className="text-button"
          onClick={() => onAction({ kind: 'retry_cleanup', taskId: t.id })}
        >
          重试关闭浏览器
        </button>
      ) : null}
      <details className="task-process">
        <summary>处理过程</summary>
        {t.events?.map((event, i) => (
          <p key={i}>{event.message}</p>
        ))}
        <p>
          {t.executionSource === 'agent' ? 'Harness 分析' : '规则处理'} · 执行模型调用{' '}
          {t.modelCalls || 0} 次
        </p>
      </details>
      {t.actualSubmitted === true ? (
        <small className="submission-fact submitted">已真实提交到开票平台。</small>
      ) : t.mode === 'dry_run' || t.simulation ? (
        <small className="submission-fact">未提交。</small>
      ) : null}
    </section>
  );
}
function EntryLink({ url }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="task-entry">
      <span>开票页面</span>
      <a href={url} target="_blank" rel="noreferrer noopener" title={url}>
        {url}
      </a>
      <button type="button" className="text-button" onClick={copy}>
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}
function ReviewCountdown({ deadline }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.floor(((deadline ? Date.parse(deadline) : now) - now) / 1000));
  return (
    <div className={`review-countdown${left ? '' : ' expired'}`}>
      <strong>
        {left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : '已超时'}
      </strong>
      <span>
        {left
          ? '内在对话里回复：确认提交 / 指出要改的地方 / 放弃'
          : '页面即将关闭，回复“重来”可重新填写'}
      </span>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);
