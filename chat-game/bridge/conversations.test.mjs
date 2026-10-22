import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createBridge, readConfig } from './server.mjs';

const TOKEN = 'v2-test-token-contains-at-least-thirty-two-characters';
const OWNER = { playerId: '123', universeId: '456' };
const HASH = createHash('sha256').update('456:123').digest('hex');
const IDS = { ...OWNER, conversationId: 'conv_saved' };
const CHAT = { ...IDS, model: 'gpt-6-luna', message: 'Hello', requestId: 'request-0001' };
const item = (id, role, text) => ({ id, type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });

function upstream({ items = [], ownerHash = HASH, blocked = [], delayed = false } = {}) {
  const state = { metadata: { ownerHash }, items: [...items], calls: [], generations: 0, deleted: false, responses: new Map(), delayed };
  async function fetchImpl(url, options) {
    const path = new URL(url).pathname.replace('/v1/', '');
    const query = new URL(url).searchParams;
    const body = options.body ? JSON.parse(options.body) : undefined;
    const method = options.method;
    state.calls.push({ path, query: Object.fromEntries(query), body, method });
    if (path === 'moderations') return Response.json({ results: (Array.isArray(body.input) ? body.input : [body.input]).map((text) => ({ flagged: blocked.includes(text) })) });
    if (path === 'conversations' && method === 'POST') {
      state.metadata = body.metadata;
      return Response.json({ id: 'conv_created', metadata: body.metadata });
    }
    if (path === 'conversations/conv_saved') {
      if (state.deleted) return Response.json({ error: {} }, { status: 404 });
      if (method === 'GET') return Response.json({ id: 'conv_saved', metadata: state.metadata });
      if (method === 'POST') { state.metadata = body.metadata; return Response.json({ id: 'conv_saved', metadata: state.metadata }); }
      if (method === 'DELETE') { state.deleted = true; return Response.json({ id: 'conv_saved', deleted: true }); }
    }
    if (path === 'conversations/conv_saved/items') {
      const start = query.get('after') ? state.items.findIndex((entry) => entry.id === query.get('after')) + 1 : 0;
      const data = state.items.slice(start, start + 20);
      return Response.json({ data, has_more: state.items.length > start + 20, first_id: data[0]?.id, last_id: data.at(-1)?.id });
    }
    if (path.startsWith('conversations/conv_saved/items/') && method === 'DELETE') {
      state.items = state.items.filter((entry) => entry.id !== path.split('/').at(-1));
      return Response.json({ id: 'conv_saved', metadata: state.metadata });
    }
    if (path === 'responses' && method === 'POST') {
      state.generations++;
      if (state.delayed) return new Promise(() => {});
      const generated = { id: `resp_${state.generations}`, status: 'completed', output: [item(`msg_reply${state.generations}`, 'assistant', 'Saved reply')] };
      state.responses.set(generated.id, generated);
      state.items.unshift(...generated.output, item(`msg_user${state.generations}`, 'user', body.input[0].content));
      return Response.json(generated);
    }
    if (path.startsWith('responses/') && method === 'GET') {
      return state.responses.has(path.split('/').at(-1)) ? Response.json(state.responses.get(path.split('/').at(-1))) : Response.json({}, { status: 404 });
    }
    throw Error(`Unexpected stub operation ${method} ${path}`);
  }
  return { state, fetchImpl };
}

async function fixture(t, { api = upstream(), env = {}, now } = {}) {
  const config = readConfig({ BRIDGE_TOKEN: TOKEN, OPENAI_API_KEY: 'test-key-not-real', ...env });
  const server = createBridge({ config, fetchImpl: api.fetchImpl, now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  async function request(path, body, token = TOKEN) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  return { request, api };
}

test('v2 creation stores only hashed experience/player ownership', async (t) => {
  const { request, api } = await fixture(t);
  const result = await request('/v2/conversations', OWNER);
  assert.deepEqual(result, { status: 200, body: { conversationId: 'conv_created' } });
  assert.deepEqual(api.state.calls[0].body, { metadata: { ownerHash: HASH } });
  assert.equal((await request('/v2/conversations', OWNER, 'wrong')).status, 401);
});

test('v2 strictly validates IDs, cursor, message, and prohibits client history/instructions', async (t) => {
  const { request, api } = await fixture(t);
  for (const body of [{ ...CHAT, universeId: '-1' }, { ...CHAT, playerId: 'player' }, { ...CHAT, conversationId: '../other' }, { ...CHAT, requestId: 'x' }, { ...CHAT, model: 'unknown' }, { ...CHAT, message: 'x'.repeat(801) }, { ...CHAT, message: 'a\u0000' }, { ...CHAT, instructions: 'x' }, { ...CHAT, messages: [] }]) {
    assert.equal((await request('/v2/chat', body)).status, 400);
  }
  assert.equal((await request('/v2/history', { ...IDS, after: '../../secrets' })).status, 400);
  assert.equal(api.state.calls.length, 0);
});

test('v2 verifies metadata ownership before history, chat, and delete', async (t) => {
  const { request, api } = await fixture(t, { api: upstream({ ownerHash: 'someone-else' }) });
  for (const [path, body] of [['/v2/history', IDS], ['/v2/chat', CHAT], ['/v2/delete', IDS]]) {
    const result = await request(path, body);
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'conversation_forbidden');
  }
  assert.ok(api.state.calls.every((call) => call.method === 'GET' && call.path === 'conversations/conv_saved'));
});

test('v2 paginates descending raw items, reverses visible messages, skips reasoning, and re-moderates history', async (t) => {
  const items = Array.from({ length: 25 }, (_, i) => item(`msg_${25 - i}`, i % 2 ? 'user' : 'assistant', `text${25 - i}`));
  items[1] = { id: 'rs_reason', type: 'reasoning', summary: [{ text: 'Never disclose internal reasoning' }] };
  const { request, api } = await fixture(t, { api: upstream({ items, blocked: ['text25'] }) });
  const first = await request('/v2/history', IDS);
  assert.equal(first.status, 200);
  assert.equal(first.body.messages.length, 19);
  assert.equal(first.body.messages[0].id, 'msg_6');
  assert.equal(first.body.messages.at(-1).content, '[This saved message is unavailable.]');
  assert.equal(first.body.hasMore, true);
  assert.equal(first.body.nextAfter, 'msg_6');
  assert.deepEqual(api.state.calls[1].query, { order: 'desc', limit: '20' });
  assert.equal(api.state.calls[2].body.input.length, 19);
  const second = await request('/v2/history', { ...IDS, after: first.body.nextAfter });
  assert.equal(second.body.messages[0].id, 'msg_1');
  assert.equal(second.body.hasMore, false);
  assert.equal(Object.hasOwn(second.body, 'nextAfter'), false);
});

test('v2 sends only the current user input with genuine conversation storage and no custom prompt', async (t) => {
  const { request, api } = await fixture(t);
  const result = await request('/v2/chat', CHAT);
  assert.deepEqual(result, { status: 200, body: { reply: 'Saved reply', model: 'gpt-6-luna', responseId: 'resp_1', requestId: CHAT.requestId } });
  const payload = api.state.calls.find((call) => call.path === 'responses').body;
  assert.equal(payload.conversation, IDS.conversationId);
  assert.equal(payload.store, true);
  assert.deepEqual(payload.input, [{ role: 'user', content: 'Hello' }]);
  assert.equal(Object.hasOwn(payload, 'instructions'), false);
  assert.equal(Object.hasOwn(payload, 'previous_response_id'), false);
  assert.equal(payload.safety_identifier, HASH);
  assert.deepEqual(payload.metadata, { requestId: CHAT.requestId });
  assert.equal(api.state.metadata.lastRequestState, 'complete');
  assert.equal(api.state.metadata.lastResponseId, 'resp_1');
});

test('v2 deduplicates completed requests, rejects changed payload, and rechecks ownership even for cached replies', async (t) => {
  const { request, api } = await fixture(t);
  const first = await request('/v2/chat', CHAT);
  const second = await request('/v2/chat', CHAT);
  assert.deepEqual(second, first);
  assert.equal(api.state.generations, 1);
  const conflict = await request('/v2/chat', { ...CHAT, message: 'different' });
  assert.equal(conflict.body.error.code, 'request_id_conflict');
  api.state.metadata.ownerHash = 'different-owner';
  assert.equal((await request('/v2/chat', CHAT)).status, 403);
  assert.equal(api.state.generations, 1);
});

test('v2 recovers the last completed response after process restart without generating again', async (t) => {
  const api = upstream();
  const first = await fixture(t, { api });
  const original = await first.request('/v2/chat', CHAT);
  const restarted = await fixture(t, { api });
  assert.deepEqual(await restarted.request('/v2/chat', CHAT), original);
  assert.equal(api.state.generations, 1);
  assert.ok(api.state.calls.some((call) => call.path === 'responses/resp_1' && call.method === 'GET'));
});

test('v2 marks uncertain generation and refuses replay in memory and after restart', async (t) => {
  const api = upstream({ delayed: true });
  const first = await fixture(t, { api, env: { OPENAI_TIMEOUT_MS: '100' } });
  const result = await first.request('/v2/chat', CHAT);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'request_uncertain');
  assert.equal(api.state.metadata.lastRequestState, 'pending');
  assert.equal((await first.request('/v2/chat', CHAT)).body.error.code, 'request_uncertain');
  const restarted = await fixture(t, { api });
  assert.equal((await restarted.request('/v2/chat', CHAT)).body.error.code, 'request_uncertain');
  assert.equal(api.state.generations, 1);
});

test('v2 blocks flagged input; removes flagged saved output items before reporting blocked reply', async (t) => {
  const badInput = await fixture(t, { api: upstream({ blocked: ['Hello'] }) });
  assert.equal((await badInput.request('/v2/chat', CHAT)).body.error.code, 'message_blocked');
  assert.equal(badInput.api.state.generations, 0);
  const badOutput = await fixture(t, { api: upstream({ blocked: ['Saved reply'] }) });
  assert.equal((await badOutput.request('/v2/chat', CHAT)).body.error.code, 'reply_blocked');
  assert.equal(badOutput.api.state.items.some((entry) => entry.role === 'assistant'), false);
  const history = await badOutput.request('/v2/history', IDS);
  assert.equal(history.status, 200);
  assert.ok(history.body.messages.every((entry) => entry.content !== 'Saved reply'));
});

test('v2 history fails closed if moderation is malformed and caps unicode pages below100KB', async (t) => {
  const api = upstream({ items: [item('msg_one', 'assistant', 'safe')] });
  const fetchImpl = api.fetchImpl;
  api.fetchImpl = (url, options) => url.endsWith('/moderations') ? Promise.resolve(Response.json({ results: [] })) : fetchImpl(url, options);
  const failed = await fixture(t, { api });
  assert.equal((await failed.request('/v2/history', IDS)).body.error.code, 'moderation_unavailable');
  const huge = await fixture(t, { api: upstream({ items: Array.from({ length: 20 }, (_, i) => item(`msg_${i}`, 'assistant', '你好'.repeat(2000))) }) });
  const result = await huge.request('/v2/history', IDS);
  assert.equal(result.status, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(result.body)) <= 100000);
});

test('v2 delete removes all items before deleting the conversation and preserves partial progress', async (t) => {
  const complete = await fixture(t, { api: upstream({ items: Array.from({ length: 23 }, (_, i) => item(`msg_${i}`, 'user', 'test')) }) });
  const result = await complete.request('/v2/delete', IDS);
  assert.deepEqual(result, { status: 200, body: { deleted: true } });
  assert.equal(complete.api.state.items.length, 0);
  assert.equal(complete.api.state.calls.at(-1).path, 'conversations/conv_saved');
  assert.equal(complete.api.state.calls.at(-1).method, 'DELETE');
  const partial = await fixture(t, { api: upstream({ items: Array.from({ length: 125 }, (_, i) => item(`msg_${i}`, 'user', 'test')) }) });
  const first = await partial.request('/v2/delete', IDS);
  assert.equal(first.status, 409);
  assert.equal(first.body.error.code, 'delete_incomplete');
  assert.equal(partial.api.state.items.length, 25);
  assert.equal(partial.api.state.deleted, false);
  assert.deepEqual(await partial.request('/v2/delete', IDS), { status: 200, body: { deleted: true } });
});

test('v2 missing conversation remains404, metadata rate limit is separate, and mock cannot pretend persistence', async (t) => {
  const { request, api } = await fixture(t, { env: { PLAYER_REQUESTS_PER_MINUTE: '1', METADATA_REQUESTS_PER_MINUTE: '3' } });
  assert.equal((await request('/v2/chat', CHAT)).status, 200);
  assert.equal((await request('/v2/chat', { ...CHAT, requestId: 'request-0002' })).status, 429);
  assert.equal((await request('/v2/history', IDS)).status, 200);
  assert.equal((await request('/v2/history', IDS)).status, 200);
  api.state.deleted = true;
  assert.equal((await request('/v2/delete', IDS)).status, 404);
  assert.equal((await request('/v2/history', IDS)).status, 429);
  const mock = await fixture(t, { env: { ALLOW_MOCK: 'true' } });
  assert.equal((await mock.request('/v2/conversations', OWNER)).body.error.code, 'persistent_chat_unavailable');
});
