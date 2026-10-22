import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createConversations } from './conversations.mjs';

export const MODEL_CATALOG = Object.freeze([
  Object.freeze({ id: 'gpt-6-luna', label: 'GPT-6 Luna · Fast' }),
  Object.freeze({ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol · Balanced' }),
  Object.freeze({ id: 'gpt-6-astra', label: 'GPT-6 Astra · Advanced' }),
]);

export const LIMITS = Object.freeze({
  bodyBytes: 32768,
  upstreamBytes: 262144,
  messages: 15,
  userCharacters: 800,
  assistantCharacters: 4000,
  historyCharacters: 18000,
  replyCharacters: 4000,
  rememberedPlayers: 10000,
  bodyTimeoutMs: 5000,
  windowMs: 60000,
});

class HttpError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function integer(env, name, fallback, min, max) {
  if (env[name] === undefined || env[name] === '') return fallback;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name} configuration.`);
  return value;
}

export function readConfig(env = process.env) {
  const allowed = (env.OPENAI_MODELS || MODEL_CATALOG.map((m) => m.id).join(','))
    .split(',').map((m) => m.trim()).filter(Boolean);
  if (!allowed.length || new Set(allowed).size !== allowed.length || allowed.some((id) => !MODEL_CATALOG.some((m) => m.id === id))) {
    throw new Error('OPENAI_MODELS must be a comma-separated subset of the supported model catalog.');
  }
  const mock = env.ALLOW_MOCK === 'true';
  const models = mock ? [{ id: 'mock-demo', label: 'OFFLINE DEMO · No AI connection' }] : allowed.map((id) => MODEL_CATALOG.find((m) => m.id === id));
  const defaultModel = mock ? 'mock-demo' : (env.DEFAULT_MODEL || (allowed.includes('gpt-6-luna') ? 'gpt-6-luna' : allowed[0]));
  if (!models.some((m) => m.id === defaultModel)) throw new Error('DEFAULT_MODEL must be included in OPENAI_MODELS.');
  const bridgeToken = (env.BRIDGE_TOKEN || '').trim();
  const apiKey = (env.OPENAI_API_KEY || '').trim();
  return Object.freeze({
    bridgeToken,
    apiKey,
    ready: /^[\x21-\x7e]{32,512}$/.test(bridgeToken) && (mock || apiKey.length > 0),
    mock,
    models: Object.freeze(models),
    defaultModel,
    host: env.HOST === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
    port: integer(env, 'PORT', 10000, 0, 65535),
    playerRequestsPerMinute: integer(env, 'PLAYER_REQUESTS_PER_MINUTE', 6, 1, 60),
    globalRequestsPerMinute: integer(env, 'GLOBAL_REQUESTS_PER_MINUTE', 60, 1, 6000),
    metadataRequestsPerMinute: integer(env, 'METADATA_REQUESTS_PER_MINUTE', 30, 1, 300),
    globalMetadataRequestsPerMinute: integer(env, 'GLOBAL_METADATA_REQUESTS_PER_MINUTE', 300, 1, 6000),
    maxConcurrent: integer(env, 'MAX_CONCURRENT_REQUESTS', 8, 1, 100),
    timeoutMs: integer(env, 'OPENAI_TIMEOUT_MS', 25000, 100, 55000),
    maxOutputTokens: integer(env, 'MAX_OUTPUT_TOKENS', 700, 64, 2000),
  });
}

function replyJson(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function authenticated(header, token) {
  if (typeof header !== 'string' || header.length > 520) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req) {
  const contentType = req.headers['content-type'] || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new HttpError(415, 'unsupported_media_type', 'Use Content-Type: application/json.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'unsupported_encoding', 'Compressed request bodies are not supported.');
  const declaredSize = req.headers['content-length'];
  if (declaredSize && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > LIMITS.bodyBytes)) throw new HttpError(413, 'body_too_large', 'The chat request is too large.');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish(new HttpError(408, 'request_timeout', 'The request body took too long.')), LIMITS.bodyTimeoutMs);
    function finish(error, value) {
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      if (error) { req.resume(); reject(error); } else resolve(value);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > LIMITS.bodyBytes) return finish(new HttpError(413, 'body_too_large', 'The chat request is too large.'));
      chunks.push(chunk);
    }
    function onEnd() {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new HttpError(400, 'invalid_json', 'The request must contain valid JSON.')); }
    }
    function onError() { finish(new HttpError(400, 'invalid_request', 'The request could not be read.')); }
    function onAborted() { finish(new HttpError(400, 'request_aborted', 'The request was disconnected.')); }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function validateChat(body, config) {
  const invalid = (message) => { throw new HttpError(400, 'invalid_request', message); };
  if (!isObject(body)) invalid('Expected a JSON object.');
  if (Object.keys(body).some((key) => !['playerId', 'sessionId', 'model', 'messages'].includes(key))) invalid('The chat request contains an unsupported field.');
  if (typeof body.playerId !== 'string' || !/^-?\d{1,20}$/.test(body.playerId)) invalid('playerId must be a Roblox user ID string.');
  if (typeof body.sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(body.sessionId)) invalid('sessionId is invalid.');
  if (typeof body.model !== 'string' || !config.models.some((m) => m.id === body.model)) invalid('Select one of the enabled models.');
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > LIMITS.messages || body.messages.length % 2 !== 1) invalid('Send up to 15 alternating messages, beginning and ending with a user message.');
  let total = 0;
  const messages = body.messages.map((message, index) => {
    if (!isObject(message) || Object.keys(message).some((key) => !['role', 'content'].includes(key))) invalid('Each message must contain only role and content.');
    const role = index % 2 === 0 ? 'user' : 'assistant';
    if (message.role !== role) invalid('Messages must alternate between user and assistant.');
    const max = role === 'user' ? LIMITS.userCharacters : LIMITS.assistantCharacters;
    if (typeof message.content !== 'string' || !message.content.trim() || (role === 'user' ? Array.from(message.content).length : message.content.length) > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message.content)) invalid('A message is empty, too long, or contains unsupported control characters.');
    total += message.content.length;
    return { role, content: message.content.trim() };
  });
  if (total > LIMITS.historyCharacters) invalid('The conversation is too long. Start a new chat.');
  return { playerId: body.playerId, sessionId: body.sessionId, model: body.model, messages };
}

function createLimiter(config, now) {
  const players = new Map();
  let windowStart = now();
  let globalCount = 0;
  return (playerId) => {
    const time = now();
    if (time - windowStart >= LIMITS.windowMs || time < windowStart) {
      windowStart = time;
      globalCount = 0;
      players.clear();
    }
    const retryAfter = Math.max(1, Math.ceil((windowStart + LIMITS.windowMs - time) / 1000));
    const count = players.get(playerId) || 0;
    if (count >= config.playerRequestsPerMinute) throw new HttpError(429, 'player_rate_limit', 'Please wait a little before sending another message.', retryAfter);
    if (globalCount >= config.globalRequestsPerMinute || (!players.has(playerId) && players.size >= LIMITS.rememberedPlayers)) throw new HttpError(429, 'global_rate_limit', 'The AI lounge is busy. Please try again shortly.', retryAfter);
    globalCount += 1;
    players.set(playerId, count + 1);
  };
}

async function readUpstream(response, maxBytes = LIMITS.upstreamBytes) {
  if (!response.body) throw new HttpError(502, 'upstream_response', 'The AI service returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new HttpError(502, 'upstream_response', 'The AI service response was too large.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(502, 'upstream_response', 'The AI service returned an invalid response.'); }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

async function openAI(fetchImpl, config, path, body, signal, { method = 'POST', maxBytes } = {}) {
  signal.throwIfAborted();
  let response;
  try {
    response = await fetchImpl(`https://api.openai.com/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      redirect: 'error',
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new HttpError(502, 'upstream_unavailable', 'The AI service could not be reached. Please try again.');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if ([401, 403].includes(response.status)) throw new HttpError(503, 'upstream_credentials', 'The AI service key needs attention from the game owner.');
    if (response.status === 429) throw new HttpError(429, 'upstream_rate_limit', 'The AI service limit was reached. Try again later or ask the game owner to check API billing.', 30);
    if (response.status === 404 && path.startsWith('conversations/')) throw new HttpError(404, 'conversation_not_found', 'This saved chat is no longer available.');
    if (response.status === 404 && path.startsWith('responses/')) throw new HttpError(409, 'request_uncertain', 'The previous reply cannot be recovered. Reload chat history before continuing.');
    if (response.status === 404) throw new HttpError(503, 'model_unavailable', 'This model is unavailable to the game owner. Select another model.');
    throw new HttpError(502, 'upstream_error', 'The AI service could not finish this request.');
  }
  try {
    const data = await readUpstream(response, maxBytes);
    signal.throwIfAborted();
    return data;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'upstream_response', 'The AI service response could not be read.');
  }
}

async function moderate(fetchImpl, config, text, signal, output = false) {
  const data = await openAI(fetchImpl, config, 'moderations', { model: 'omni-moderation-latest', input: text }, signal);
  if (!Array.isArray(data?.results) || !data.results.length || data.results.some((result) => typeof result?.flagged !== 'boolean')) {
    throw new HttpError(502, 'moderation_unavailable', 'The safety check could not be completed. Please try again.');
  }
  if (data.results.some((result) => result.flagged)) {
    throw new HttpError(422, output ? 'reply_blocked' : 'message_blocked', output ? 'The AI reply could not be shown. Try a different question.' : 'Please keep your message appropriate for everyone and try another question.');
  }
}

function extractReply(data) {
  if (data?.status === 'failed' || data?.error || !Array.isArray(data?.output)) throw new HttpError(502, 'upstream_response', 'The AI service did not complete a reply.');
  const parts = [];
  for (const item of data.output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
      if (part?.type === 'refusal' && typeof part.refusal === 'string') parts.push(part.refusal);
    }
  }
  let reply = parts.join('\n').trim();
  if (!reply) throw new HttpError(502, 'empty_reply', 'The AI did not return a text reply. Try a shorter question.');
  if (reply.length > LIMITS.replyCharacters) reply = reply.slice(0, LIMITS.replyCharacters - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
  return reply;
}

async function generateReply(fetchImpl, config, chat) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new HttpError(504, 'upstream_timeout', 'The AI took too long to respond. Please try again.');
      controller.abort(error);
      reject(error);
    }, config.timeoutMs);
  });
  const operation = (async () => {
    await moderate(fetchImpl, config, chat.messages.at(-1).content, controller.signal);
    const payload = {
      model: chat.model,
      input: chat.messages,
      max_output_tokens: config.maxOutputTokens,
      store: false,
      safety_identifier: createHash('sha256').update(chat.playerId).digest('hex'),
      reasoning: { effort: 'low' },
    };
    const data = await openAI(fetchImpl, config, 'responses', payload, controller.signal);
    const reply = extractReply(data);
    await moderate(fetchImpl, config, reply, controller.signal, true);
    return { reply, model: chat.model };
  })();
  try { return await Promise.race([operation, timeout]); }
  finally { clearTimeout(timer); }
}

export function createBridge({ config = readConfig(), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const takeRequest = createLimiter(config, now);
  const takeMetadataRequest = createLimiter({ ...config, playerRequestsPerMinute: config.metadataRequestsPerMinute, globalRequestsPerMinute: config.globalMetadataRequestsPerMinute }, now);
  const conversations = createConversations({ config, now, HttpError, extractReply,
    request: (path, body, signal, options) => openAI(fetchImpl, config, path, body, signal, options),
  });
  const activePlayers = new Set();
  let concurrent = 0;
  let shuttingDown = false;
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    try {
      if (req.url === '/healthz' && req.method === 'GET') {
        replyJson(res, shuttingDown ? 503 : 200, { ok: !shuttingDown, ready: config.ready, mode: config.mock ? 'offline-demo' : 'openai' });
        return;
      }
      if (req.url !== '/v1/models' && req.url !== '/v1/chat' && !conversations.routes.includes(req.url)) throw new HttpError(404, 'not_found', 'Endpoint not found.');
      if (shuttingDown || !config.ready) throw new HttpError(503, 'not_configured', 'The game owner must finish configuring the AI bridge.');
      if (!authenticated(req.headers.authorization, config.bridgeToken)) throw new HttpError(401, 'unauthorized', 'Invalid bridge credentials.');
      const method = req.url === '/v1/models' ? 'GET' : 'POST';
      if (req.method !== method) {
        res.setHeader('Allow', method);
        throw new HttpError(405, 'method_not_allowed', 'This HTTP method is not supported.');
      }
      if (req.url === '/v1/models') {
        replyJson(res, 200, { models: config.models, defaultModel: config.defaultModel });
        return;
      }
      const isV2 = req.url.startsWith('/v2/');
      const chat = isV2 ? conversations.validate(req.url, await readBody(req)) : validateChat(await readBody(req), config);
      if (activePlayers.has(chat.playerId)) throw new HttpError(409, 'request_in_progress', 'Wait for your current reply before sending another message.');
      if (concurrent >= config.maxConcurrent) throw new HttpError(429, 'busy', 'The AI lounge is busy. Please try again shortly.', 5);
      (isV2 && req.url !== '/v2/chat' ? takeMetadataRequest : takeRequest)(chat.playerId);
      concurrent += 1;
      activePlayers.add(chat.playerId);
      try {
        const result = isV2 ? await conversations.execute(req.url, chat) : config.mock
          ? { reply: '[OFFLINE DEMO — no OpenAI call] The game and bridge connection work. The game owner must configure a valid OpenAI API key and turn off ALLOW_MOCK for AI replies.', model: 'mock-demo' }
          : await generateReply(fetchImpl, config, chat);
        replyJson(res, 200, result);
      } finally {
        concurrent -= 1;
        activePlayers.delete(chat.playerId);
      }
    } catch (error) {
      const known = error instanceof HttpError;
      replyJson(res, known ? error.status : 500, { error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'The bridge could not finish the request.' } }, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 35000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 200;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.shutdown = () => {
    shuttingDown = true;
    return new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
      const timer = setTimeout(() => server.closeAllConnections(), config.timeoutMs + 1000);
      timer.unref();
    });
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readConfig();
    const server = createBridge({ config });
    server.listen(config.port, config.host, () => {
      console.log(`Roblox GPT bridge listening on port ${config.port}; mode=${config.mock ? 'offline-demo' : 'openai'}; configured=${config.ready}.`);
    });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void server.shutdown(); });
  } catch {
    console.error('Bridge startup failed. Check the documented environment variable names and limits.');
    process.exitCode = 1;
  }
}
