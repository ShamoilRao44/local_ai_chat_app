// Local Express API and one-time in-memory browser bundle.
// The model key stays on this server and is sent only to the configured endpoint.
// Chat history and compacted context are stored locally for model requests.
if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error('This app requires Node.js 18 or newer.');
  process.exit(1);
}

import 'dotenv/config';
import express from 'express';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import {
  addMessage, createChat, deleteChat, flushDatabaseSync, getChatContext, getDatabasePath,
  getMessages, getSetting, listChats, listModels, renameChat, saveChatContext, saveModel,
  setSetting, touchChat,
} from './db.js';

const app = express();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const defaultModel = process.env.DEFAULT_MODEL || 'qwen3-coder-next-sd-dev';
const endpoint = process.env.LLM_BASE_URL || 'http://172.31.8.100:9005/v1/chat/completions';
const apiKey = process.env.LLM_API_KEY || '';
const systemPrompt = process.env.SYSTEM_PROMPT || 'You are a helpful, concise coding assistant. Prefer clear step-by-step reasoning, minimal fluff, and runnable code examples when relevant.';
const temperature = Number.isFinite(Number(process.env.TEMPERATURE)) ? Number(process.env.TEMPERATURE) : 0.1;
const timeoutSeconds = Number.isFinite(Number(process.env.REQUEST_TIMEOUT_SECONDS))
  ? Math.max(1, Number(process.env.REQUEST_TIMEOUT_SECONDS)) : 1500;
const inFlight = new Set();
const SUMMARY_CHUNK_CHARS = 6000;
const MAX_SUMMARY_CHARS = 3500;

app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

let browserBundle;
try {
  const result = await build({
    entryPoints: ['app.jsx'],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    target: ['chrome120'],
  });
  browserBundle = result.outputFiles[0].text;
} catch (error) {
  console.error('Could not bundle app.jsx:', error);
  process.exit(1);
}

// ---- Browser shell and config ----
app.get('/', (_request, response) => {
  response.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Local AI Chat</title><link rel="stylesheet" href="/style.css"></head>
<body><div id="root"></div><script src="/app.js" defer></script></body></html>`);
});
app.get('/style.css', (_request, response) => response.sendFile(fileURLToPath(new URL('./style.css', import.meta.url))));
app.get('/app.js', (_request, response) => response.type('application/javascript').send(browserBundle));

app.get('/api/config', (_request, response) => {
  response.json({ defaultModel, hasApiKey: Boolean(apiKey), lastModel: getSetting('last_model') });
});

// ---- Chats API ----
app.get('/api/chats', (_request, response) => response.json(listChats()));

app.post('/api/chats', (_request, response) => {
  response.status(201).json(createChat(getSetting('last_model') || defaultModel));
});

app.patch('/api/chats/:id', (request, response, next) => {
  const title = typeof request.body?.title === 'string' ? request.body.title.trim() : '';
  if (!title || title.length > 100) return next(httpError(400, 'validation', 'Title must be between 1 and 100 characters.'));
  const chat = renameChat(request.params.id, title);
  if (!chat) return next(httpError(404, 'not_found', 'Chat not found.'));
  response.json(chat);
});

app.delete('/api/chats/:id', (request, response, next) => {
  if (inFlight.has(request.params.id)) {
    return next(httpError(409, 'busy', 'Wait for the current request to finish before deleting this chat.'));
  }
  deleteChat(request.params.id);
  response.json({ ok: true });
});

app.get('/api/chats/:id/messages', (request, response, next) => {
  if (!listChats().some((chat) => chat.id === request.params.id)) {
    return next(httpError(404, 'not_found', 'Chat not found.'));
  }
  response.json(getMessages(request.params.id));
});

app.post('/api/chats/:id/compact', async (request, response, next) => {
  const { mode, model } = request.body || {};
  if (!['standard', 'full'].includes(mode)) {
    return next(httpError(400, 'validation', 'Compaction mode must be standard or full.'));
  }
  if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 200)) {
    return next(httpError(400, 'validation', 'Model must be 1 to 200 characters.'));
  }
  const chat = listChats().find((item) => item.id === request.params.id);
  if (!chat) return next(httpError(404, 'not_found', 'Chat not found.'));
  const chatId = chat.id;
  if (inFlight.has(chatId)) return next(httpError(409, 'busy', 'A request is already running for this chat.'));
  if (!apiKey) return next(httpError(503, 'config', 'LLM_API_KEY is missing in .env'));

  inFlight.add(chatId);
  try {
    const history = getMessages(chatId);
    if (!history.length) throw httpError(400, 'validation', 'There are no messages to compact.');
    const existingContext = getChatContext(chatId);
    const previousThroughId = existingContext?.through_message_id || 0;
    const uncompressedMessages = history.filter((message) => message.id > previousThroughId);
    const chosenModel = model?.trim() || chat.model || getSetting('last_model') || defaultModel;
    let messagesToCompact;
    let retainedMessages = 0;

    if (mode === 'full') {
      messagesToCompact = uncompressedMessages;
    } else {
      const recentStart = standardCompactionStart(history);
      const retained = history.slice(recentStart);
      retainedMessages = retained.length;
      const retainedStartId = retained[0]?.id ?? Number.POSITIVE_INFINITY;
      messagesToCompact = uncompressedMessages.filter((message) => message.id < retainedStartId);
    }

    if (!messagesToCompact.length) {
      response.json({
        mode, changed: false, summarizedMessages: 0, retainedMessages,
        message: mode === 'standard'
          ? 'No older messages to compact; standard mode keeps the most recent exchanges.'
          : 'This chat is already fully compacted.',
      });
      return;
    }

    const fragments = [];
    if (existingContext?.summary) {
      fragments.push({ role: 'summary', content: `Previously compacted conversation:\n${existingContext.summary}` });
    }
    for (const message of messagesToCompact) {
      fragments.push({
        role: message.role,
        content: `${message.role === 'user' ? 'User' : 'Assistant'} message ${message.id}:\n${message.content}`,
      });
    }

    const summary = await compactFragments(fragments, chosenModel, response);
    const throughMessageId = messagesToCompact[messagesToCompact.length - 1].id;
    const context = saveChatContext(chatId, summary, throughMessageId);
    response.json({
      mode, changed: true, summarizedMessages: messagesToCompact.length, retainedMessages,
      throughMessageId: context.through_message_id,
    });
  } catch (error) {
    if (response.destroyed || !response.writable) return;
    next(error);
  } finally {
    inFlight.delete(chatId);
  }
});

app.post('/api/chats/:id/messages', async (request, response, next) => {
  const { content, model, retry = false } = request.body || {};
  if (typeof content !== 'string' || !content.trim() || content.length > 200000) {
    return next(httpError(400, 'validation', 'Message must be 1 to 200,000 characters.'));
  }
  if (typeof model !== 'string' || !model.trim() || model.length > 200) {
    return next(httpError(400, 'validation', 'Model must be 1 to 200 characters.'));
  }
  const chat = listChats().find((item) => item.id === request.params.id);
  if (!chat) return next(httpError(404, 'not_found', 'Chat not found.'));
  const chatId = chat.id;
  if (inFlight.has(chatId)) return next(httpError(409, 'busy', 'A request is already running for this chat.'));

  const chosenModel = model;
  inFlight.add(chatId);
  try {
    const previousMessages = getMessages(chatId);
    const shouldGenerateTitle = chat.title === 'New chat'
      && !previousMessages.some((message) => message.role === 'assistant');
    let userMessage;
    if (retry === true) {
      userMessage = [...previousMessages].reverse().find((message) => message.role === 'user' && message.content === content);
      if (!userMessage) throw httpError(400, 'validation', 'The message to retry was not found in this chat.');
    } else {
      userMessage = addMessage(chatId, 'user', content, chosenModel);
      touchChat(chatId, chosenModel);
      setSetting('last_model', chosenModel);
    }

    if (!apiKey) throw httpError(503, 'config', 'LLM_API_KEY is missing in .env');

    const history = getMessages(chatId);
    const context = getChatContext(chatId);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...(shouldGenerateTitle ? [{
        role: 'system',
        content: 'This is the first assistant response in a new chat. Return only a valid JSON object with exactly two string fields: "title" and "response". The title should be a concise, descriptive chat title of at most 100 characters, based on the user request. The response should answer the user normally.',
      }] : []),
      ...(context ? [{
        role: 'system',
        content: `Conversation summary from earlier messages:\n${context.summary}`,
      }] : []),
      ...history
        .filter((message) => !context || message.id > context.through_message_id)
        .map(({ role, content: messageContent }) => ({ role, content: messageContent })),
    ];
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
    const abortForTimeout = () => controller.abort(timeoutSignal.reason);
    timeoutSignal.addEventListener('abort', abortForTimeout, { once: true });
    const abortForDisconnect = () => {
      if (!response.writableEnded) controller.abort(new Error('Browser disconnected'));
    };
    response.on('close', abortForDisconnect);

    let upstreamResponse;
    let responseBody;
    try {
      upstreamResponse = await fetch(endpoint, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: chosenModel, messages, stream: false, temperature, enable_thinking: false,
        }),
        signal: controller.signal,
      });
      responseBody = await upstreamResponse.text();
    } catch (error) {
      if (response.destroyed || !response.writable) return;
      throw classifyNetworkError(error, endpoint, apiKey);
    } finally {
      response.off('close', abortForDisconnect);
      timeoutSignal.removeEventListener('abort', abortForTimeout);
    }

    let parsed;
    try { parsed = JSON.parse(responseBody); } catch { parsed = null; }
    if (!upstreamResponse.ok) {
      throw classifyUpstreamError(upstreamResponse.status, responseBody, apiKey);
    }
    let reply = parsed?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string') {
      throw httpError(502, 'upstream', 'The model server returned no assistant message.', {
        status: upstreamResponse.status,
        body: redact(responseBody || JSON.stringify(parsed), apiKey).slice(0, 2000),
      });
    }

    let generatedTitle;
    if (shouldGenerateTitle) {
      try {
        const structuredReply = parseTitleAndResponse(reply);
        generatedTitle = structuredReply.title;
        reply = structuredReply.response;
      } catch {
        throw httpError(502, 'upstream', 'The model server did not return a valid chat title and response.', {
          status: upstreamResponse.status,
          body: redact(reply, apiKey).slice(0, 2000),
        });
      }
    }

    const usage = parsed?.usage || {};
    const assistantMessage = addMessage(chatId, 'assistant', reply, chosenModel,
      Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
      Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null);
    if (generatedTitle && listChats().find((item) => item.id === chatId)?.title === 'New chat') {
      renameChat(chatId, generatedTitle);
    }
    touchChat(chatId, chosenModel);
    setSetting('last_model', chosenModel);
    response.json({ userMessage, assistantMessage });
  } catch (error) {
    if (response.destroyed || !response.writable) return;
    next(error);
  } finally {
    inFlight.delete(chatId);
  }
});

// ---- Saved models API ----
app.get('/api/models', (_request, response) => response.json(listModels()));

app.post('/api/models', (request, response, next) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  if (!name || name.length > 200) return next(httpError(400, 'validation', 'Model name must be 1 to 200 characters.'));
  saveModel(name);
  setSetting('last_model', name);
  response.status(201).json({ name });
});

// ---- Error handling and startup ----
app.use((error, _request, response, _next) => {
  const status = Number.isInteger(error.status) ? error.status : 500;
  const payload = {
    kind: error.kind || 'server',
    message: error.publicMessage || 'The request could not be completed.',
    details: error.details || { status, body: status === 500 ? 'Internal server error.' : '' },
  };
  response.status(status).json({ error: payload });
});

function httpError(status, kind, message, details) {
  const error = new Error(message);
  error.status = status;
  error.kind = kind;
  error.publicMessage = message;
  error.details = details || { status, body: '' };
  return error;
}

function parseTitleAndResponse(reply) {
  const json = reply.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
  const result = JSON.parse(json);
  if (typeof result?.title !== 'string' || typeof result?.response !== 'string') {
    throw new Error('The model response must include title and response strings.');
  }
  const title = result.title.replace(/\s+/g, ' ').trim();
  const response = result.response.trim();
  if (!title || !response) throw new Error('The model response must not be empty.');
  return { title: Array.from(title).slice(0, 100).join(''), response };
}

function standardCompactionStart(messages) {
  let start = Math.max(0, messages.length - 4);
  while (start > 0 && messages[start].role !== 'user') start -= 1;
  return start;
}

async function compactFragments(fragments, model, response) {
  const chunks = packSummaryFragments(fragments);
  let summaries = [];
  for (const chunk of chunks) {
    summaries.push(await requestSummary(chunk, model, response));
  }

  while (summaries.length > 1) {
    const reduced = [];
    for (let index = 0; index < summaries.length; index += 2) {
      if (index + 1 === summaries.length) {
        reduced.push(summaries[index]);
      } else {
        reduced.push(await requestSummary(
          `Combine these chronological summaries into one concise summary. Preserve goals, facts, constraints, decisions, and unresolved questions.\n\nSummary part 1:\n${summaries[index]}\n\nSummary part 2:\n${summaries[index + 1]}`,
          model,
          response,
        ));
      }
    }
    summaries = reduced;
  }
  return summaries[0];
}

function packSummaryFragments(fragments) {
  const pieces = [];
  for (const fragment of fragments) {
    const content = fragment.content;
    for (let start = 0; start < content.length;) {
      let end = Math.min(start + SUMMARY_CHUNK_CHARS, content.length);
      if (end < content.length && isHighSurrogate(content.charCodeAt(end - 1))) end -= 1;
      pieces.push(`${fragment.role}:\n${content.slice(start, end)}`);
      start = end;
    }
  }

  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > SUMMARY_CHUNK_CHARS) {
      chunks.push(current);
      current = '';
    }
    current += `${current ? '\n\n' : ''}${piece}`;
  }
  if (current) chunks.push(current);
  return chunks;
}

function isHighSurrogate(code) {
  return code >= 0xD800 && code <= 0xDBFF;
}

async function requestSummary(source, model, response) {
  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
  const abortForTimeout = () => controller.abort(timeoutSignal.reason);
  timeoutSignal.addEventListener('abort', abortForTimeout, { once: true });
  const abortForDisconnect = () => {
    if (!response.writableEnded) controller.abort(new Error('Browser disconnected'));
  };
  response.on('close', abortForDisconnect);

  let upstreamResponse;
  let responseBody;
  try {
    upstreamResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, temperature,
        messages: [
          {
            role: 'system',
            content: 'Create a faithful, concise conversation summary for future turns. Preserve the user’s goal, important facts, constraints, decisions, and unresolved questions. Do not invent details. Return only the summary, in at most 500 words.',
          },
          { role: 'user', content: source },
        ],
      }),
      signal: controller.signal,
    });
    responseBody = await upstreamResponse.text();
  } catch (error) {
    if (response.destroyed || !response.writable) throw error;
    throw classifyNetworkError(error, endpoint, apiKey);
  } finally {
    response.off('close', abortForDisconnect);
    timeoutSignal.removeEventListener('abort', abortForTimeout);
  }

  let parsed;
  try { parsed = JSON.parse(responseBody); } catch { parsed = null; }
  if (!upstreamResponse.ok) {
    const error = classifyUpstreamError(upstreamResponse.status, responseBody, apiKey);
    if (error.kind === 'context') {
      throw httpError(422, 'context', 'The model rejected a compaction request as too large. No compaction was saved.', error.details);
    }
    throw error;
  }
  const summary = parsed?.choices?.[0]?.message?.content;
  if (typeof summary !== 'string' || !summary.trim()) {
    throw httpError(502, 'upstream', 'The model server returned no compaction summary.', {
      status: upstreamResponse.status,
      body: redact(responseBody || JSON.stringify(parsed), apiKey).slice(0, 2000),
    });
  }
  if (parsed?.choices?.[0]?.finish_reason === 'length' || summary.trim().length > MAX_SUMMARY_CHARS) {
    throw httpError(502, 'upstream', 'The compaction summary was too long or was cut off. Try compacting a smaller portion of the chat.', {
      status: upstreamResponse.status,
      body: redact(summary, apiKey).slice(0, 2000),
    });
  }
  return summary.trim();
}

function redact(value, secret) {
  return secret ? String(value).split(secret).join('[redacted]') : String(value);
}

function classifyNetworkError(error, target, secret) {
  let hostname = 'the configured model server';
  try { hostname = new URL(target).hostname || hostname; } catch { /* Keep the generic host label. */ }
  const message = `Could not reach the model server at ${hostname}. Check LLM_BASE_URL and that the server is running.`;
  return httpError(502, 'network', message, {
    status: null,
    body: redact(error?.cause?.code || error?.message || 'Network request failed.', secret).slice(0, 2000),
  });
}

function classifyUpstreamError(status, body, secret) {
  const safeBody = redact(body || '', secret).slice(0, 2000);
  if (status === 401 || status === 403) {
    return httpError(502, 'auth', 'The API rejected the key. Check LLM_API_KEY in .env.', { status, body: safeBody });
  }
  if ([400, 413, 422].includes(status) || /context|token|length|maximum|too long|exceed/i.test(safeBody)) {
    return httpError(422, 'context', 'This chat is too long for the selected model. Start a new chat.', { status, body: safeBody });
  }
  return httpError(502, 'upstream', `The model server returned HTTP ${status}.`, { status, body: safeBody });
}

const server = app.listen(port, host, () => {
  console.log(`Chat app running at http://${host}:${port}`);
  console.log(`Database: ${getDatabasePath()}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Change PORT in .env and try again.`);
  } else {
    console.error(`Could not start server: ${error.message}`);
  }
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    try { flushDatabaseSync(); } catch (error) { console.error(`Could not flush chat database: ${error.message}`); }
    server.close();
    process.exit(0);
  });
}