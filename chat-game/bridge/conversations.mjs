import { createHash } from 'node:crypto';

const routes = ['/v2/conversations', '/v2/history', '/v2/chat', '/v2/delete'];
const CONVERSATION_ID = /^conv_[A-Za-z0-9]{1,123}$/;
const ITEM_ID = /^[A-Za-z0-9_-]{1,160}$/;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 1000;
const MAX_HISTORY_BYTES = 100000;
const MAX_DELETE_ITEMS = 100;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clip = (text, max = 4000) => text.length <= max ? text : text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
const historyContent = (text) => {
  let content = clip(text);
  while (Buffer.byteLength(JSON.stringify(content)) > 4400) content = clip(content, Math.max(1, Math.floor(content.length * 0.8)));
  return content;
};

export function createConversations({ request, config, HttpError, extractReply, now = Date.now }) {
  const cache = new Map();
  const error = (status, code, message) => new HttpError(status, code, message);
  const uncertain = () => error(409, 'request_uncertain', 'The previous request may already be saved. Reload chat history before continuing; do not resend it.');

  function validate(route, body) {
    const invalid = (message) => { throw error(400, 'invalid_request', message); };
    if (!object(body)) invalid('Expected a JSON object.');
    const fields = ['playerId', 'universeId'];
    if (route !== '/v2/conversations') fields.push('conversationId');
    if (route === '/v2/history') fields.push('after');
    if (route === '/v2/chat') fields.push('model', 'message', 'requestId');
    if (Object.keys(body).some((key) => !fields.includes(key))) invalid('The request contains an unsupported field.');
    if (typeof body.playerId !== 'string' || !/^-?\d{1,20}$/.test(body.playerId)) invalid('playerId must be a Roblox user ID string.');
    if (typeof body.universeId !== 'string' || !/^\d{1,20}$/.test(body.universeId)) invalid('universeId must be a Roblox experience ID string.');
    if (route !== '/v2/conversations' && (typeof body.conversationId !== 'string' || !CONVERSATION_ID.test(body.conversationId))) invalid('conversationId is invalid.');
    if (body.after !== undefined && (typeof body.after !== 'string' || !ITEM_ID.test(body.after))) invalid('The history cursor is invalid.');
    if (route === '/v2/chat') {
      if (!config.models.some((m) => m.id === body.model)) invalid('Select one of the enabled models.');
      if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId)) invalid('requestId is invalid.');
      if (typeof body.message !== 'string' || !body.message.trim() || Array.from(body.message).length > 800 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.message)) invalid('The message is empty, too long, or contains unsupported control characters.');
    }
    return { ...body, ...(route === '/v2/chat' ? { message: body.message.trim() } : {}), ownerHash: hash(`${body.universeId}:${body.playerId}`) };
  }

  async function deadline(operation, state) {
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const failure = state.deleting ? error(409, 'delete_incomplete', 'Some saved items may have been deleted. Keep this chat and use Delete again to finish.')
          : state.mutating ? uncertain() : error(504, 'upstream_timeout', 'The AI service took too long. Please try loading again.');
        controller.abort(failure);
        reject(failure);
      }, config.timeoutMs);
    });
    try { return await Promise.race([operation(controller.signal), timedOut]); }
    finally { clearTimeout(timer); }
  }

  async function owned(chat, signal) {
    const conversation = await request(`conversations/${chat.conversationId}`, undefined, signal, { method: 'GET' });
    if (conversation?.id !== chat.conversationId || !object(conversation.metadata)) throw error(502, 'upstream_response', 'The saved chat could not be read.');
    if (conversation.metadata.ownerHash !== chat.ownerHash) throw error(403, 'conversation_forbidden', 'This saved chat does not belong to this player and experience.');
    return conversation;
  }

  async function checkTexts(texts, signal) {
    if (!texts.length) return [];
    const result = await request('moderations', { model: 'omni-moderation-latest', input: texts }, signal);
    if (!Array.isArray(result?.results) || result.results.length !== texts.length || result.results.some((entry) => typeof entry?.flagged !== 'boolean')) {
      throw error(502, 'moderation_unavailable', 'The safety check could not be completed. Please try loading again.');
    }
    return result.results.map((entry) => entry.flagged);
  }

  async function listItems(chat, signal, after) {
    const query = new URLSearchParams({ order: 'desc', limit: '20' });
    if (after) query.set('after', after);
    const page = await request(`conversations/${chat.conversationId}/items?${query}`, undefined, signal, { method: 'GET' });
    if (!Array.isArray(page?.data) || page.data.length > 20 || typeof page.has_more !== 'boolean' || page.data.some((item) => !ITEM_ID.test(item?.id || ''))) {
      throw error(502, 'upstream_response', 'The saved chat history is invalid.');
    }
    if (page.has_more && (!page.data.length || !ITEM_ID.test(page.last_id || '') || page.last_id !== page.data.at(-1).id)) {
      throw error(502, 'upstream_response', 'The saved chat cursor is invalid.');
    }
    return page;
  }

  async function history(chat, signal) {
    const page = await listItems(chat, signal, chat.after);
    const messages = [];
    for (const item of [...page.data].reverse()) {
      if (item.type !== 'message' || !['user', 'assistant'].includes(item.role) || !Array.isArray(item.content)) continue;
      const text = item.content.map((part) => {
        if (['input_text', 'output_text', 'text'].includes(part?.type) && typeof part.text === 'string') return part.text;
        if (part?.type === 'refusal' && typeof part.refusal === 'string') return part.refusal;
        return '';
      }).filter(Boolean).join('\n').trim();
      if (text) messages.push({ id: item.id, role: item.role, content: historyContent(text) });
    }
    // Stored responses can outlive the original output safety check, so check again before display.
    const flags = await checkTexts(messages.map((message) => message.content), signal);
    for (let index = 0; index < messages.length; index++) {
      if (flags[index]) messages[index].content = '[This saved message is unavailable.]';
    }
    const result = { messages, hasMore: page.has_more, ...(page.has_more ? { nextAfter: page.last_id } : {}) };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_HISTORY_BYTES) throw error(502, 'history_page_too_large', 'This saved history page is too large to display.');
    return result;
  }

  async function deleteItems(chat, signal, state) {
    state.deleting = true;
    let removed = 0;
    for (;;) {
      const page = await listItems(chat, signal);
      if (!page.data.length) {
        const result = await request(`conversations/${chat.conversationId}`, undefined, signal, { method: 'DELETE' });
        if (result?.deleted !== true || result.id !== chat.conversationId) throw error(502, 'upstream_response', 'Chat deletion could not be confirmed.');
        return { deleted: true };
      }
      if (removed + page.data.length > MAX_DELETE_ITEMS) throw error(409, 'delete_incomplete', 'Some saved items have been deleted. Keep this chat and use Delete again to finish.');
      for (let start = 0; start < page.data.length; start += 4) {
        const outcomes = await Promise.allSettled(page.data.slice(start, start + 4).map((item) => request(`conversations/${chat.conversationId}/items/${item.id}`, undefined, signal, { method: 'DELETE' })));
        if (outcomes.some((outcome) => outcome.status === 'rejected' || outcome.value?.id !== chat.conversationId)) {
          throw error(409, 'delete_incomplete', 'Some saved items may have been deleted. Keep this chat and use Delete again to finish.');
        }
      }
      removed += page.data.length;
      // Re-read the first remaining page: a deleted item cannot be used as an after cursor.
    }
  }

  function pruneCache() {
    for (const [key, entry] of cache) if (now() - entry.created >= CACHE_MS) cache.delete(key);
    if (cache.size >= CACHE_MAX) throw error(503, 'dedupe_capacity', 'The chat service is busy. Please try later.');
  }

  async function chatReply(chat, conversation, signal, state) {
    const key = `${chat.ownerHash}:${chat.conversationId}:${chat.requestId}`;
    const fingerprint = hash(`${chat.model}\n${chat.message}`);
    const cached = cache.get(key);
    if (cached) {
      if (cached.fingerprint !== fingerprint) throw error(409, 'request_id_conflict', 'This request ID was already used for a different message.');
      if (cached.result) return cached.result;
      if (cached.failure) throw cached.failure;
      throw uncertain();
    }
    pruneCache();
    const entry = { created: now(), fingerprint };
    cache.set(key, entry);
    try {
      if (conversation.metadata.lastRequestId === chat.requestId) {
        if (conversation.metadata.lastRequestHash !== fingerprint) throw error(409, 'request_id_conflict', 'This request ID was already used for a different message.');
        if (conversation.metadata.lastRequestState !== 'complete' || !/^resp_[A-Za-z0-9]+$/.test(conversation.metadata.lastResponseId || '')) throw uncertain();
        const previous = await request(`responses/${conversation.metadata.lastResponseId}`, undefined, signal, { method: 'GET' });
        const reply = extractReply(previous);
        if ((await checkTexts([reply], signal))[0]) throw error(422, 'reply_blocked', 'The saved reply cannot be shown.');
        entry.result = { reply, model: chat.model, responseId: previous.id, requestId: chat.requestId };
        return entry.result;
      }
      if ((await checkTexts([chat.message], signal))[0]) throw error(422, 'message_blocked', 'Please keep your message appropriate for everyone and try another question.');
      const metadata = { ...conversation.metadata, ownerHash: chat.ownerHash, lastRequestId: chat.requestId, lastRequestHash: fingerprint, lastRequestState: 'pending', lastResponseId: '' };
      // Persist the latest request marker before generation, so a process restart cannot replay an uncertain latest turn.
      state.mutating = true;
      await request(`conversations/${chat.conversationId}`, { metadata }, signal);
      const generated = await request('responses', {
        model: chat.model,
        conversation: chat.conversationId,
        input: [{ role: 'user', content: chat.message }],
        store: true,
        max_output_tokens: config.maxOutputTokens,
        safety_identifier: chat.ownerHash,
        reasoning: { effort: 'low' },
        metadata: { requestId: chat.requestId },
      }, signal);
      const reply = extractReply(generated);
      if ((await checkTexts([reply], signal))[0]) {
        // Best-effort removal from conversation history. History is independently re-moderated on every read.
        for (const item of generated.output.filter((item) => item?.type === 'message' && ITEM_ID.test(item?.id || '')).slice(0, 8)) {
          try { await request(`conversations/${chat.conversationId}/items/${item.id}`, undefined, signal, { method: 'DELETE' }); } catch { break; }
        }
        throw error(422, 'reply_blocked', 'The AI reply could not be shown. Reload the saved chat before continuing.');
      }
      if (typeof generated.id !== 'string' || !/^resp_[A-Za-z0-9]+$/.test(generated.id)) throw error(502, 'upstream_response', 'The AI response ID is invalid.');
      await request(`conversations/${chat.conversationId}`, { metadata: { ...metadata, lastRequestState: 'complete', lastResponseId: generated.id } }, signal);
      entry.result = { reply, model: chat.model, responseId: generated.id, requestId: chat.requestId };
      return entry.result;
    } catch (failure) {
      entry.failure = state.mutating && ['upstream_timeout', 'upstream_unavailable', 'upstream_response'].includes(failure.code) ? uncertain() : failure;
      throw entry.failure;
    }
  }

  async function execute(route, chat) {
    if (config.mock) throw error(503, 'persistent_chat_unavailable', 'Saved chats require a real OpenAI connection.');
    const state = { mutating: false, deleting: false };
    return deadline(async (signal) => {
      if (route === '/v2/conversations') {
        state.mutating = true;
        const created = await request('conversations', { metadata: { ownerHash: chat.ownerHash } }, signal);
        if (typeof created?.id !== 'string' || !CONVERSATION_ID.test(created.id) || created.metadata?.ownerHash !== chat.ownerHash) throw error(502, 'upstream_response', 'The saved chat could not be created.');
        return { conversationId: created.id };
      }
      const conversation = await owned(chat, signal);
      if (route === '/v2/history') return history(chat, signal);
      if (route === '/v2/delete') return deleteItems(chat, signal, state);
      return chatReply(chat, conversation, signal, state);
    }, state);
  }

  return { routes, validate, execute };
}
