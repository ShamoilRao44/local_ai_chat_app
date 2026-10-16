// Complete local chat interface: navigation, messages, model picker, and composer.
// The browser talks only to this app's same-origin REST API.
// Markdown is sanitized before it reaches the page; user messages stay plain text.
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const initialState = { chats: [], models: [], messages: {}, activeId: null, config: null, loadError: '' };

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw data.error || { kind: 'network', message: 'The local app could not complete the request.', details: {} };
  return data;
}

function Icon({ name, size = 18 }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    pencil: <><path d="m4 20 4.5-1 10.9-10.9a2.1 2.1 0 0 0-3-3L5.5 16 4 20Z" /><path d="m14.8 6.2 3 3" /></>,
    trash: <><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6" /><path d="M10 11v5m4-5v5" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3" /></>,
    down: <path d="m6 9 6 6 6-6" />,
    up: <path d="m6 15 6-6 6 6" />,
    send: <><path d="M22 2 11 13" /><path d="m22 2-7 20-4-9-9-4 20-7Z" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
    sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function AssistantMarkdown({ content }) {
  const containerRef = useRef(null);
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }) => {
    const safeLanguage = escapeHtml(lang || 'code');
    const safeCode = escapeHtml(text);
    return `<div class="code-block"><div class="code-header"><span>${safeLanguage}</span><button class="code-copy" type="button" data-code="${encodeURIComponent(text)}">Copy</button></div><pre><code>${safeCode}</code></pre></div>`;
  };
  renderer.link = ({ href, title, text }) => {
    const safeHref = escapeAttribute(href || '');
    const safeTitle = title ? ` title="${escapeAttribute(title)}"` : '';
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer"${safeTitle}>${text}</a>`;
  };
  const rawHtml = marked.parse(content, { renderer, breaks: true });
  const cleanHtml = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target', 'rel', 'data-code'] });

  async function copyCode(event) {
    const button = event.target.closest('.code-copy');
    if (!button) return;
    try {
      await navigator.clipboard.writeText(decodeURIComponent(button.dataset.code));
      button.textContent = 'Copied';
      setTimeout(() => { if (button.isConnected) button.textContent = 'Copy'; }, 1500);
    } catch { button.textContent = 'Copy failed'; }
  }

  return <div ref={containerRef} className="markdown-body" onClick={copyCode} dangerouslySetInnerHTML={{ __html: cleanHtml }} />;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function escapeAttribute(value) { return escapeHtml(value); }

function CopyButton({ value, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { setCopied(false); }
  }
  return <button className="quiet-button" type="button" onClick={copy} aria-label={`${label} message`} title={`${label} message`}><Icon name="copy" size={15} /><span>{copied ? 'Copied' : label}</span></button>;
}

function ErrorBox({ error, onRetry, onNewChat }) {
  return <div className="error-box" role="alert">
    <div className="error-main"><strong>{error.message}</strong>
      {error.kind === 'context' && <button className="text-button" onClick={onNewChat}>New chat</button>}
      <button className="text-button" onClick={onRetry}>Retry</button>
    </div>
    <details><summary>Details</summary><pre>{JSON.stringify(error.details || {}, null, 2)}</pre></details>
  </div>;
}

function UserMessage({ message, error, onRetry, onNewChat }) {
  return <div className="user-row" id={`message-${message.id}`}>
    <div className="user-content">
      <div className="user-bubble">{message.content}</div>
      {error && <ErrorBox error={error} onRetry={onRetry} onNewChat={onNewChat} />}
    </div>
  </div>;
}

function AssistantMessage({ message, collapsed, onToggle }) {
  const preview = message.content.replace(/\s+/g, ' ').slice(0, 100);
  return <article className={`assistant-message${collapsed ? ' is-collapsed' : ''}`}>
    <header className="message-header">
      <div><strong>Assistant</strong><span>{message.model || 'Model'}</span></div>
      <div className="message-actions"><CopyButton value={message.content} /><button className="icon-button" type="button" onClick={onToggle} aria-label={collapsed ? 'Expand response' : 'Collapse response'} title={collapsed ? 'Expand response' : 'Collapse response'}><Icon name={collapsed ? 'down' : 'up'} size={16} /></button></div>
    </header>
    {collapsed ? <button className="collapsed-preview" onClick={onToggle}>{preview}{message.content.length > 100 ? '...' : ''}</button> : <AssistantMarkdown content={message.content} />}
  </article>;
}

function Sidebar({ chats, activeId, busyIds, collapsed, onToggle, onNewChat, onOpenChat, onRename, onDelete }) {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');
  const [deleteId, setDeleteId] = useState(null);
  const groups = groupChats(chats);

  function beginRename(chat) { setEditingId(chat.id); setDraft(chat.title); }
  async function finishRename(id, save) {
    if (save && draft.trim()) await onRename(id, draft.trim());
    setEditingId(null);
  }

  return <aside className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}>
    <div className="sidebar-top"><button className="icon-button sidebar-toggle" onClick={onToggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><Icon name="sidebar" /></button>
      {!collapsed && <button className="new-chat-button" onClick={onNewChat}><Icon name="plus" size={17} /><span>New chat</span></button>}</div>
    {!collapsed && <div className="chat-groups">
      {groups.map(([label, items]) => items.length > 0 && <section className="chat-group" key={label}><h2>{label}</h2>
        {items.map((chat) => <div className={`chat-row${chat.id === activeId ? ' active' : ''}`} key={chat.id}>
          {editingId === chat.id ? <input className="rename-input" value={draft} autoFocus onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') finishRename(chat.id, true); if (event.key === 'Escape') finishRename(chat.id, false); }} onBlur={() => finishRename(chat.id, true)} aria-label="Chat title" /> : <button className="chat-select" onClick={() => onOpenChat(chat.id)} title={chat.title}>{busyIds.includes(chat.id) && <span className="row-spinner" aria-label="Request in progress" />}{chat.title}</button>}
          {deleteId === chat.id ? <div className="delete-confirm"><span>Delete this chat?</span><button onClick={() => { setDeleteId(null); onDelete(chat.id); }}>Delete</button><button onClick={() => setDeleteId(null)}>Cancel</button></div> : editingId !== chat.id && <div className="row-actions"><button className="icon-button" aria-label="Rename chat" title="Rename chat" onClick={() => beginRename(chat)}><Icon name="pencil" size={15} /></button><button className="icon-button" aria-label="Delete chat" title="Delete chat" onClick={() => setDeleteId(chat.id)}><Icon name="trash" size={15} /></button></div>}
        </div>)}
      </section>)}
      {chats.length === 0 && <p className="sidebar-empty">Your chats will appear here.</p>}
    </div>}
  </aside>;
}

function groupChats(chats) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const week = new Date(today); week.setDate(today.getDate() - 7);
  const groups = new Map([['Today', []], ['Yesterday', []], ['Previous 7 days', []], ['Older', []]]);
  for (const chat of chats) {
    const date = new Date(chat.updated_at);
    const key = date >= today ? 'Today' : date >= yesterday ? 'Yesterday' : date >= week ? 'Previous 7 days' : 'Older';
    groups.get(key).push(chat);
  }
  return [...groups.entries()];
}

function ModelPicker({ model, models, onModelChange, onSave }) {
  const isSaved = models.includes(model.trim());
  return <div className="model-picker"><label htmlFor="model-name">Model</label><input id="model-name" list="saved-models" value={model} onChange={(event) => onModelChange(event.target.value)} spellCheck="false" autoComplete="off" />
    <datalist id="saved-models">{models.map((name) => <option value={name} key={name} />)}</datalist>
    <button className="save-model" onClick={onSave} disabled={!model.trim() || isSaved} title={isSaved ? 'Model is already saved' : model.trim() ? 'Save model' : 'Enter a model name'}>Save</button>
  </div>;
}

function Composer({ disabled, busy, onSend, onStop, inputRef }) {
  const [value, setValue] = useState('');
  function resize(element) { element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 192)}px`; }
  function submit() {
    if (!value.trim() || disabled || busy) return;
    onSend(value);
    setValue('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
  }
  return <div className="composer-wrap"><div className="composer">
    <textarea ref={inputRef} rows="1" value={value} disabled={disabled || busy} placeholder="Message" aria-label="Message" onChange={(event) => { setValue(event.target.value); resize(event.target); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
    <button className={`send-button${busy ? ' stop-button' : ''}`} type="button" disabled={disabled || (!busy && !value.trim())} onClick={busy ? onStop : submit} aria-label={busy ? 'Stop response' : 'Send message'} title={busy ? 'Stop' : 'Send'}><Icon name={busy ? 'stop' : 'send'} size={18} /></button>
  </div></div>;
}

function App() {
  const [state, setState] = useState(initialState);
  const [model, setModel] = useState('');
  const [collapsedSidebar, setCollapsedSidebar] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true');
  const [collapsedMessages, setCollapsedMessages] = useState({});
  const [busyIds, setBusyIds] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const requestsRef = useRef(new Map());
  const activeMessages = state.messages[state.activeId] || [];
  const activeChat = state.chats.find((chat) => chat.id === state.activeId);
  const isBusy = busyIds.includes(state.activeId);
  const lastAssistant = [...activeMessages].reverse().find((message) => message.role === 'assistant');
  const lastTokens = lastAssistant?.prompt_tokens;
  const estimate = Math.round(activeMessages.reduce((total, message) => total + message.content.length, 0) / 3.5);

  useEffect(() => { boot(); }, []);
  useEffect(() => {
    if (!isBusy) { setElapsed(0); return undefined; }
    const started = requestsRef.current.get(state.activeId)?.startedAt || Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isBusy, state.activeId]);
  useEffect(() => {
    const textarea = inputRef.current;
    if (textarea && !isBusy) textarea.focus();
  }, [state.activeId, isBusy]);
  useEffect(() => {
    if (atBottom && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [activeMessages, isBusy, state.activeId, atBottom]);
  useEffect(() => {
    function onKeyDown(event) {
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'k' || (event.shiftKey && event.key.toLowerCase() === 'o'))) {
        event.preventDefault(); createOrFocusChat();
      }
      if (event.key === 'Escape') document.activeElement?.blur();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  async function boot() {
    try {
      const [config, models, chats] = await Promise.all([api('/api/config'), api('/api/models'), api('/api/chats')]);
      const chosen = config.lastModel || config.defaultModel;
      setState((current) => ({ ...current, config, models, chats }));
      setModel(chosen);
      if (chats.length) await openChat(chats[0].id, false);
      else await createAndOpen(chosen);
    } catch (error) { setState((current) => ({ ...current, loadError: error.message || 'Could not load the local chat app.' })); }
  }

  async function refreshChats() {
    const chats = await api('/api/chats');
    setState((current) => ({ ...current, chats }));
    return chats;
  }

  async function openChat(id, focus = true) {
    setState((current) => ({ ...current, activeId: id }));
    if (!Object.hasOwn(state.messages, id)) {
      try {
        const messages = await api(`/api/chats/${id}/messages`);
        setState((current) => ({ ...current, messages: { ...current.messages, [id]: messages } }));
        setAtBottom(true);
      } catch (error) { setState((current) => ({ ...current, loadError: error.message || 'Could not load this chat.' })); }
    } else setAtBottom(true);
    const chat = state.chats.find((item) => item.id === id);
    if (chat?.model) setModel(chat.model);
    if (focus) setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function createAndOpen(chosenModel = model || state.config?.defaultModel) {
    const chat = await api('/api/chats', { method: 'POST', body: '{}' });
    setState((current) => ({ ...current, activeId: chat.id, chats: [chat, ...current.chats], messages: { ...current.messages, [chat.id]: [] } }));
    if (chosenModel) setModel(chosenModel);
    setAtBottom(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function createOrFocusChat() {
    if (activeChat && activeMessages.length === 0 && !isBusy) { inputRef.current?.focus(); return; }
    try { await createAndOpen(state.config?.lastModel || model || state.config?.defaultModel); }
    catch (error) { setState((current) => ({ ...current, loadError: error.message || 'Could not create a chat.' })); }
  }

  async function sendMessage(content, retry = false, retryId = null) {
    const chatId = state.activeId;
    if (!chatId || requestsRef.current.has(chatId)) return;
    const currentMessages = state.messages[chatId] || [];
    const optimisticId = retryId || `local-${Date.now()}`;
    if (!retry) {
      const optimistic = { id: optimisticId, chat_id: chatId, role: 'user', content, model, created_at: Date.now() };
      setState((current) => ({ ...current, messages: { ...current.messages, [chatId]: [...(current.messages[chatId] || []), optimistic] } }));
    } else {
      setState((current) => ({ ...current, messages: { ...current.messages, [chatId]: (current.messages[chatId] || []).map((message) => message.id === retryId ? { ...message, error: null } : message) } }));
    }
    setAtBottom(true);
    const controller = new AbortController();
    requestsRef.current.set(chatId, { controller, startedAt: Date.now(), stopped: false });
    setBusyIds((current) => current.includes(chatId) ? current : [...current, chatId]);
    try {
      const result = await api(`/api/chats/${chatId}/messages`, {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ content, model, retry }),
      });
      setState((current) => ({ ...current, messages: { ...current.messages, [chatId]: [
        ...(current.messages[chatId] || []).filter((message) => message.id !== optimisticId && !message.error),
        result.userMessage, result.assistantMessage,
      ] } }));
      await refreshChats();
    } catch (error) {
      const request = requestsRef.current.get(chatId);
      if (request?.stopped) return;
      const targetId = retryId || optimisticId;
      setState((current) => ({ ...current, messages: { ...current.messages, [chatId]: (current.messages[chatId] || []).map((message) => message.id === targetId ? { ...message, error } : message) } }));
    } finally {
      requestsRef.current.delete(chatId);
      setBusyIds((current) => current.filter((id) => id !== chatId));
      refreshChats().catch(() => {});
    }
  }

  function stopRequest() {
    const request = requestsRef.current.get(state.activeId);
    if (!request) return;
    request.stopped = true;
    request.controller.abort();
    const lastUser = [...activeMessages].reverse().find((message) => message.role === 'user');
    if (lastUser) {
      const stoppedError = { kind: 'stopped', message: 'Stopped', details: { status: null, body: 'The request was stopped.' } };
      setState((current) => ({ ...current, messages: { ...current.messages, [state.activeId]: (current.messages[state.activeId] || []).map((message) => message.id === lastUser.id ? { ...message, error: stoppedError } : message) } }));
    }
  }

  async function renameChat(id, title) {
    try {
      const chat = await api(`/api/chats/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
      setState((current) => ({ ...current, chats: current.chats.map((item) => item.id === id ? chat : item) }));
    } catch (error) { setState((current) => ({ ...current, loadError: error.message || 'Could not rename chat.' })); }
  }

  async function deleteChat(id) {
    try {
      await api(`/api/chats/${id}`, { method: 'DELETE' });
      const remaining = state.chats.filter((chat) => chat.id !== id);
      setState((current) => ({ ...current, chats: remaining, activeId: current.activeId === id ? null : current.activeId }));
      if (state.activeId === id) {
        if (remaining.length) await openChat(remaining[0].id);
        else await createAndOpen();
      }
    } catch (error) { setState((current) => ({ ...current, loadError: error.message || 'Could not delete chat.' })); }
  }

  async function saveModel() {
    try {
      const result = await api('/api/models', { method: 'POST', body: JSON.stringify({ name: model }) });
      setState((current) => ({ ...current, models: [...new Set([...current.models, result.name])].sort() }));
    } catch (error) { setState((current) => ({ ...current, loadError: error.message || 'Could not save model.' })); }
  }

  function toggleCollapse(id) { setCollapsedMessages((current) => ({ ...current, [id]: !current[id] })); }
  function toggleAll() {
    const assistantMessages = activeMessages.filter((message) => message.role === 'assistant');
    const shouldCollapse = assistantMessages.some((message) => !collapsedMessages[message.id]);
    setCollapsedMessages((current) => Object.fromEntries([...Object.entries(current), ...assistantMessages.map((message) => [message.id, shouldCollapse])]));
  }

  if (!state.config && !state.loadError) return <div className="loading-screen"><span className="spinner" />Loading local chats...</div>;
  if (state.loadError && !state.config) return <div className="startup-error"><strong>Local chat could not start</strong><p>{state.loadError}</p><button onClick={boot}>Try again</button></div>;

  return <main className="app-shell">
    <Sidebar chats={state.chats} activeId={state.activeId} busyIds={busyIds} collapsed={collapsedSidebar} onToggle={() => setCollapsedSidebar((value) => { localStorage.setItem('sidebar-collapsed', String(!value)); return !value; })} onNewChat={createOrFocusChat} onOpenChat={openChat} onRename={renameChat} onDelete={deleteChat} />
    <section className="chat-area">
      <header className="topbar"><div className="chat-title" title={activeChat?.title || 'New chat'}>{activeChat?.title || 'New chat'}</div>
        <div className="topbar-controls"><ModelPicker model={model} models={state.models} onModelChange={setModel} onSave={saveModel} />
          <span className="token-indicator">{lastTokens != null ? `last request: ${lastTokens} prompt tokens` : `~${estimate} tokens`}</span>
          {activeMessages.some((message) => message.role === 'assistant') && <button className="quiet-button collapse-all" onClick={toggleAll}>{activeMessages.filter((message) => message.role === 'assistant').every((message) => collapsedMessages[message.id]) ? 'Expand all' : 'Collapse all'}</button>}
        </div>
      </header>
      {state.loadError && <div className="inline-alert"><span>{state.loadError}</span><button onClick={() => setState((current) => ({ ...current, loadError: '' }))} aria-label="Dismiss">×</button></div>}
      <div className="message-scroll" ref={scrollRef} onScroll={(event) => { const element = event.currentTarget; const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 150; setAtBottom(nearBottom); }}>
        <div className="message-column">
          {activeMessages.length === 0 && !isBusy && <div className="empty-state"><h1>What can I help with?</h1><p>Enter sends · Shift+Enter adds a newline</p></div>}
          {activeMessages.map((message) => message.role === 'user'
            ? <UserMessage key={message.id} message={message} error={message.error} onRetry={() => sendMessage(message.content, true, message.id)} onNewChat={createOrFocusChat} />
            : <AssistantMessage key={message.id} message={message} collapsed={Boolean(collapsedMessages[message.id])} onToggle={() => toggleCollapse(message.id)} />)}
          {isBusy && <div className="assistant-message thinking"><div className="thinking-label"><span className="spinner" />Thinking... <span className="elapsed">{elapsed}s</span></div><button className="text-button" onClick={stopRequest}>Stop</button></div>}
        </div>
      </div>
      {!atBottom && <button className="jump-latest" onClick={() => { setAtBottom(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}>Jump to latest <Icon name="down" size={15} /></button>}
      <Composer disabled={!state.activeId} busy={isBusy} onSend={(content) => sendMessage(content)} onStop={stopRequest} inputRef={inputRef} />
    </section>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);