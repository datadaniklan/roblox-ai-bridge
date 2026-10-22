import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createBridge, readConfig, LIMITS, validateChat } from './server.mjs';

const TOKEN = 'test-only-bridge-token-with-at-least-32-characters';
const ENV = { BRIDGE_TOKEN: TOKEN, OPENAI_API_KEY: 'test-only-not-a-real-key' };
const CHAT = { playerId: '123', sessionId: 'session-12345678', model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Hello!' }] };
const safe = () => Response.json({ results: [{ flagged: false }] });
const output = (text = 'Hello from the assistant.') => Response.json({ status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });

async function fixture(t, { env = {}, fetchImpl, now } = {}) {
  const config = readConfig({ ...ENV, ...env });
  const server = createBridge({ config, fetchImpl: fetchImpl || (async (url) => url.endsWith('moderations') ? safe() : output()), now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path = '/v1/chat', body = CHAT, { token = TOKEN, method, headers = {} } = {}) {
    const response = await fetch(`${base}${path}`, {
      method: method || (path === '/v1/chat' ? 'POST' : 'GET'),
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...((method || (path === '/v1/chat' ? 'POST' : 'GET')) === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { server, config, request, base };
}

test('health is public; models and chat require exact bearer auth', async (t) => {
  const { request } = await fixture(t);
  const health = await request('/healthz', undefined, { token: '' });
  assert.deepEqual(health.body, { ok: true, ready: true, mode: 'openai' });
  for (const path of ['/v1/models', '/v1/chat']) {
    assert.equal((await request(path, CHAT, { token: 'wrong' })).status, 401);
    assert.equal((await request(path, CHAT, { headers: { Authorization: TOKEN } })).status, 401);
  }
  const models = await request('/v1/models');
  assert.equal(models.status, 200);
  assert.equal(models.body.defaultModel, 'gpt-6-luna');
  assert.deepEqual(models.body.models.map((m) => m.id), ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']);
  assert.equal(models.headers.get('cache-control'), 'no-store');
  assert.equal(models.headers.get('access-control-allow-origin'), null);
});

test('missing API key or strong token fails closed, health remains available', async (t) => {
  for (const env of [{ OPENAI_API_KEY: '' }, { BRIDGE_TOKEN: 'short' }, { BRIDGE_TOKEN: '' }]) {
    const { request } = await fixture(t, { env });
    assert.equal((await request('/healthz')).body.ready, false);
    assert.equal((await request('/v1/models')).status, 503);
    assert.equal((await request()).body.error.code, 'not_configured');
  }
});

test('configuration rejects unknown models and unsafe numeric settings', () => {
  assert.throws(() => readConfig({ ...ENV, OPENAI_MODELS: 'gpt-unknown' }));
  assert.throws(() => readConfig({ ...ENV, OPENAI_MODELS: 'gpt-6-luna,gpt-6-luna' }));
  assert.throws(() => readConfig({ ...ENV, OPENAI_MODELS: 'gpt-6-luna', DEFAULT_MODEL: 'gpt-6-astra' }));
  assert.throws(() => readConfig({ ...ENV, MAX_OUTPUT_TOKENS: '99999' }));
  assert.throws(() => readConfig({ ...ENV, OPENAI_TIMEOUT_MS: 'NaN' }));
  assert.equal(readConfig({ ...ENV, OPENAI_MODELS: 'gpt-6-astra' }).defaultModel, 'gpt-6-astra');
  assert.equal(readConfig({ ...ENV, HOST: '127.0.0.1' }).host, '127.0.0.1');
  assert.equal(readConfig(ENV).host, '0.0.0.0');
});

test('strict validation rejects invalid shapes, model, history, IDs, and controls', async (t) => {
  const { request, config } = await fixture(t);
  const invalid = [null, [], {}, { ...CHAT, playerId: 123 }, { ...CHAT, playerId: '123x' }, { ...CHAT, sessionId: 'x' }, { ...CHAT, model: 'other' }, { ...CHAT, instructions: 'overwrite' },
    { ...CHAT, messages: [] }, { ...CHAT, messages: [{ role: 'system', content: 'test' }] },
    { ...CHAT, messages: [{ role: 'user', content: '' }] }, { ...CHAT, messages: [{ role: 'user', content: ' '.repeat(10) }] },
    { ...CHAT, messages: [{ role: 'user', content: 'x'.repeat(801) }] }, { ...CHAT, messages: [{ role: 'user', content: 'a\u0000b' }] },
    { ...CHAT, messages: [{ role: 'user', content: 'Hi', extra: true }] },
    { ...CHAT, messages: [{ role: 'user', content: 'Hi' }, { role: 'user', content: 'Hi' }, { role: 'user', content: 'Hi' }] },
  ];
  for (const body of invalid) assert.equal((await request('/v1/chat', body)).status, 400);
  assert.equal(validateChat({ ...CHAT, playerId: '-1' }, config).playerId, '-1');
  assert.equal(validateChat({ ...CHAT, messages: [{ role: 'user', content: '😀'.repeat(800) }] }, config).messages[0].content.length, 1600);
  const excessive = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(i % 2 ? 4000 : 800) }));
  assert.throws(() => validateChat({ ...CHAT, messages: excessive }, config));
});

test('request transport validation rejects malformed JSON, type, compression, oversize, method, and unknown routes', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/v1/chat', '{')).body.error.code, 'invalid_json');
  assert.equal((await request('/v1/chat', CHAT, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/v1/chat', CHAT, { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await request('/v1/chat', 'x'.repeat(32769))).status, 413);
  const method = await request('/v1/chat', undefined, { method: 'GET' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  assert.equal((await request('/unknown')).status, 404);
});

test('Responses payload uses selected model, full validated history, store false, and output item traversal', async (t) => {
  const calls = [];
  const { request } = await fixture(t, { fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), options });
    return url.endsWith('moderations') ? safe() : output('  Real text.  ');
  } });
  const chat = { ...CHAT, model: 'gpt-6-astra', messages: [{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Previous reply' }, { role: 'user', content: 'Follow up' }] };
  const result = await request('/v1/chat', chat);
  assert.deepEqual(result.body, { reply: 'Real text.', model: 'gpt-6-astra' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/moderations');
  assert.deepEqual(calls[0].body, { model: 'omni-moderation-latest', input: 'Follow up' });
  assert.equal(calls[1].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[1].body.model, 'gpt-6-astra');
  assert.deepEqual(calls[1].body.input, chat.messages);
  assert.equal(calls[1].body.store, false);
  assert.equal(calls[1].body.max_output_tokens, 700);
  assert.deepEqual(calls[1].body.reasoning, { effort: 'low' });
  assert.match(calls[1].body.safety_identifier, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(calls[1].body).includes(CHAT.sessionId));
  assert.equal(Object.hasOwn(calls[1].body, 'instructions'), false);
  assert.ok(calls[1].body.input.every((message) => message.role === 'user' || message.role === 'assistant'));
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[2].body.input, 'Real text.');
});

test('input moderation blocks generation and output moderation blocks display', async (t) => {
  for (const blockedCall of [1, 3]) {
    let count = 0;
    const { request } = await fixture(t, { fetchImpl: async (url) => {
      count++;
      return count === blockedCall ? Response.json({ results: [{ flagged: true }] }) : url.endsWith('moderations') ? safe() : output('Never display blocked text');
    } });
    const result = await request();
    assert.equal(result.status, 422);
    assert.equal(result.body.error.code, blockedCall === 1 ? 'message_blocked' : 'reply_blocked');
    assert.equal(count, blockedCall);
    assert.ok(!JSON.stringify(result.body).includes('Never display'));
  }
});

test('malformed moderation and response payloads fail closed', async (t) => {
  for (const data of [{}, { results: [] }, { results: [{ flagged: 'false' }] }]) {
    const { request } = await fixture(t, { fetchImpl: async () => Response.json(data) });
    assert.equal((await request()).body.error.code, 'moderation_unavailable');
  }
  for (const data of [{ output_text: 'Do not assume this convenience field' }, { output: [] }, { status: 'failed', output: [] }]) {
    const { request } = await fixture(t, { fetchImpl: async (url) => url.endsWith('moderations') ? safe() : Response.json(data) });
    assert.equal((await request()).status, 502);
  }
});

test('response length is bounded and exactly shown text is moderated', async (t) => {
  let moderated = '';
  let count = 0;
  const { request } = await fixture(t, { fetchImpl: async (url, options) => {
    if (url.endsWith('responses')) return output('x'.repeat(6000));
    if (++count === 2) moderated = JSON.parse(options.body).input;
    return safe();
  } });
  const result = await request();
  assert.equal(result.body.reply.length, 4000);
  assert.equal(result.body.reply.at(-1), '…');
  assert.equal(moderated, result.body.reply);
});

test('upstream failures are mapped without exposing response body or credentials', async (t) => {
  for (const [upstream, expected, code] of [[401, 503, 'upstream_credentials'], [403, 503, 'upstream_credentials'], [404, 503, 'model_unavailable'], [429, 429, 'upstream_rate_limit'], [500, 502, 'upstream_error']]) {
    const { request } = await fixture(t, { fetchImpl: async () => Response.json({ error: { message: 'SECRET_RAW_UPSTREAM_MESSAGE' } }, { status: upstream }) });
    const result = await request();
    assert.equal(result.status, expected);
    assert.equal(result.body.error.code, code);
    assert.ok(!JSON.stringify(result.body).includes('SECRET_RAW'));
    assert.ok(!JSON.stringify(result.body).includes(ENV.OPENAI_API_KEY));
  }
});

test('upstream network, malformed JSON, and excessive body are bounded', async (t) => {
  for (const fetchImpl of [async () => { throw new Error('private-detail'); }, async () => new Response('{'), async () => new Response('x'.repeat(LIMITS.upstreamBytes + 1))]) {
    const { request } = await fixture(t, { fetchImpl });
    const result = await request();
    assert.equal(result.status, 502);
    assert.ok(!JSON.stringify(result.body).includes('private-detail'));
  }
});

test('total timeout covers hanging fetch, body stream, and all three upstream calls', async (t) => {
  for (const mode of ['fetch', 'stream', 'pipeline']) {
    const { request } = await fixture(t, { env: { OPENAI_TIMEOUT_MS: '100' }, fetchImpl: async (url, options) => {
      if (mode === 'fetch') return new Promise(() => {});
      if (mode === 'stream') return new Response(new ReadableStream({ start() {} }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      return url.endsWith('moderations') ? safe() : output();
    } });
    const started = Date.now();
    const result = await request();
    assert.equal(result.status, 504);
    assert.equal(result.body.error.code, 'upstream_timeout');
    assert.ok(Date.now() - started < 1000);
  }
});

test('rate limits are per player plus global and reset after the bounded window', async (t) => {
  let time = 1000;
  const { request } = await fixture(t, { now: () => time, env: { PLAYER_REQUESTS_PER_MINUTE: '1', GLOBAL_REQUESTS_PER_MINUTE: '2' } });
  assert.equal((await request()).status, 200);
  const playerLimited = await request();
  assert.equal(playerLimited.status, 429);
  assert.equal(playerLimited.body.error.code, 'player_rate_limit');
  assert.equal(playerLimited.headers.get('retry-after'), '60');
  assert.equal((await request('/v1/chat', { ...CHAT, playerId: '456' })).status, 200);
  assert.equal((await request('/v1/chat', { ...CHAT, playerId: '789' })).body.error.code, 'global_rate_limit');
  time += 60001;
  assert.equal((await request()).status, 200);
});

test('concurrency bounds each player and global requests', async (t) => {
  let resolveGate;
  const gate = new Promise((resolve) => { resolveGate = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const { request } = await fixture(t, { env: { MAX_CONCURRENT_REQUESTS: '1' }, fetchImpl: async (url) => {
    entered();
    await gate;
    return url.endsWith('moderations') ? safe() : output();
  } });
  const first = request();
  await started;
  assert.equal((await request()).body.error.code, 'request_in_progress');
  assert.equal((await request('/v1/chat', { ...CHAT, playerId: '456' })).body.error.code, 'busy');
  resolveGate();
  assert.equal((await first).status, 200);
  assert.equal((await request('/v1/chat', { ...CHAT, playerId: '456' })).status, 200);
});

test('offline demo requires explicit true, labels every reply, and never calls OpenAI', async (t) => {
  const { request } = await fixture(t, { env: { ALLOW_MOCK: 'true', OPENAI_API_KEY: '' }, fetchImpl: async () => { assert.fail('Offline mode must not call OpenAI'); } });
  const models = await request('/v1/models');
  assert.deepEqual(models.body, { models: [{ id: 'mock-demo', label: 'OFFLINE DEMO · No AI connection' }], defaultModel: 'mock-demo' });
  const result = await request('/v1/chat', { ...CHAT, model: 'mock-demo' });
  assert.equal(result.status, 200);
  assert.match(result.body.reply, /^\[OFFLINE DEMO/);
  assert.equal((await request()).status, 400);
  assert.equal(readConfig({ ...ENV, OPENAI_API_KEY: '', ALLOW_MOCK: 'TRUE' }).ready, false);
});

test('chunked request body cannot bypass the byte limit', async (t) => {
  const { base } = await fixture(t);
  const result = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/v1/chat`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.write('x'.repeat(20000));
    req.end('x'.repeat(20000));
  });
  assert.equal(result.status, 413);
});
