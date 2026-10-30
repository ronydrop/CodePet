const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { CodexChatRuntime } = require('../chat/codex-chat-runtime');
const { CodexLiveRpc, resolveCodexCommand } = require('./codex-live-rpc');
const { redactSensitiveText } = require('../chat/chat-run-diagnostics');
const { LiveHistory, validId } = require('./live-history');

const selectionId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value);
const sessionKey = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);
const MODES = { ask: ['workspace-write', 'untrusted'], auto: ['workspace-write', 'on-request'], full: ['danger-full-access', 'never'] };
function publicError(error) { return redactSensitiveText(String(error?.message || error || 'A conexão de voz falhou.')).slice(0, 1200); }
function approvalDetail(params) {
  // This local approval preview must show the exact command and access scope.
  // Error/log redaction would hide home paths; truncation could hide the action being approved.
  const fields = [
    ['Comando', params.command], ['Pasta de trabalho', params.cwd], ['Caminhos permitidos', params.grantRoot],
    ['Permissão pedida', params.permissions], ['Pedido de rede', params.networkApprovalContext], ['Motivo', params.reason],
  ];
  return fields.filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `${label}:\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)
    .join('\n\n') || 'Pediu permissão para executar a tarefa.';
}
function catalogFrom(models, voices, config = {}) {
  const modelOptions = models.filter(item => !item.hidden && selectionId(item.model)).map(item => ({
    id: item.model, label: item.displayName || item.model, isDefault: !!item.isDefault,
  }));
  const list = voices?.voices || {};
  const version = list.v3?.length ? 'v3' : list.v1?.length ? 'v1' : '';
  const voiceOptions = [...new Set((list[version] || []).filter(selectionId))].map(id => ({ id, label: id }));
  if (!modelOptions.length || !voiceOptions.length) throw new Error('O Codex não enviou a lista de modelos ou de vozes disponíveis.');
  return {
    models: modelOptions, voices: voiceOptions, version,
    defaultModel: modelOptions.some(m => m.id === config.model) ? config.model : (modelOptions.find(m => m.isDefault) || modelOptions[0]).id,
    defaultVoice: voiceOptions.some(v => v.id === list.defaultV1) ? list.defaultV1 : voiceOptions[0].id,
    // The installed protocol exposes no language catalog or language start parameter.
    language: { selectable: false, source: 'conversation' },
    // WebSocket overrides do not identify the model of a WebRTC call.
    realtimeModel: null,
  };
}

class LiveService extends EventEmitter {
  constructor({ root, getAccount, runtime, resolveCommand = resolveCodexCommand, makeRpc = args => new CodexLiveRpc(args) }) {
    super();
    this.root = root;
    this.getAccount = getAccount;
    this.runtime = runtime || new CodexChatRuntime({ root: path.join(root, 'runtime') });
    this.resolveCommand = resolveCommand;
    this.makeRpc = makeRpc;
    this.rpc = null;
    this.call = null;
    this.thread = null;
    this.catalog = null;
    this.epoch = 0;
    this.preparing = null;
    this.pendingStart = null;
    this.stopping = null;
    this.approvals = new Map();
  }
  async prepare(force = false) {
    const account = this.getAccount();
    if (!account?.hasAuth) throw new Error('Entre no Codex e abra de novo.');
    const identity = account.accountId || account.key || account.email || 'current';
    if (force && (this.call || this.pendingStart)) throw new Error('Encerre a conversa de voz antes de atualizar a lista.');
    if (!force && this.rpc && this.identity === identity && !this.rpc.closed && this.catalog) return this.catalog;
    if (this.preparing && this.preparingIdentity === identity) return this.preparing;
    this.resetConnection();
    const epoch = this.epoch;
    this.preparingIdentity = identity;
    const pending = this.connect(account, identity, epoch);
    this.preparing = pending;
    try { return await pending; } finally { if (this.preparing === pending) this.preparing = null; }
  }
  async connect(account, identity, epoch) {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.OPENAI_BASE_URL;
    const prepared = this.runtime.prepare({ sourceHome: account.homePath, identity, env });
    let command, rpc;
    try {
      command = await this.resolveCommand();
      if (epoch !== this.epoch) throw new Error('A conexão foi cancelada.');
      rpc = this.makeRpc({ ...command, env: prepared.env, argv: prepared.argv, cwd: prepared.home });
    } catch (error) { prepared.finish(); throw error; }
    this.rpc = rpc; this.prepared = prepared; this.identity = identity;
    this.history = new LiveHistory(prepared.home);
    rpc.on('notification', message => this.notification(message));
    rpc.on('request', message => {
      const params = message.params || {};
      if (this.call && params.threadId === this.call.threadId && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(message.method)) {
        const id = String(message.id);
        this.approvals.set(id, { rpc, message });
        this.emit('event', { key: this.call.key, type: 'approval', id,
          canApprove: !Array.isArray(params.availableDecisions) || params.availableDecisions.includes('accept'),
          detail: approvalDetail(params) });
        return;
      }
      let result;
      if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') result = { decision: 'decline' };
      else if (message.method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
      else if (message.method === 'item/tool/requestUserInput') result = { answers: {} };
      if (result) rpc.send({ id: message.id, result });
      else rpc.send({ id: message.id, error: { code: -32601, message: 'This Live client does not support this request.' } });
    });
    rpc.on('closed', error => {
      if (this.rpc !== rpc) return;
      const call = this.call;
      this.resetConnection();
      if (call) this.emit('event', { key: call.key, type: 'error', message: publicError(error) });
    });
    try {
      await rpc.initialize();
      const auth = await rpc.request('account/read', { refreshToken: false });
      if (auth.account?.type !== 'chatgpt') throw new Error('O Live precisa de uma conta Codex conectada com ChatGPT.');
      const [voiceResult, configResult] = await Promise.all([
        rpc.request('thread/realtime/listVoices'), rpc.request('config/read', { includeLayers: false }),
      ]);
      const models = []; let cursor = null; const seen = new Set();
      do {
        const page = await rpc.request('model/list', { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) });
        models.push(...(page.data || [])); cursor = page.nextCursor || null;
        if (cursor && seen.has(cursor)) throw new Error('A página da lista de modelos do Codex se repetiu.');
        seen.add(cursor);
      } while (cursor);
      if (epoch !== this.epoch || this.rpc !== rpc) throw new Error('A conexão foi cancelada.');
      this.catalog = { ...catalogFrom(models, voiceResult, configResult.config), accountLabel: account.label || account.email || 'Codex' };
      return this.catalog;
    } catch (error) { if (this.rpc === rpc) this.resetConnection(); throw error; }
  }
  async start(input) {
    if (!sessionKey(input?.key) || typeof input.sdp !== 'string' || !input.sdp.startsWith('v=0') || input.sdp.length > 100000) throw new Error('O pedido de conexão de voz é inválido.');
    if (this.call || this.pendingStart) throw new Error('Já existe uma conversa de voz em andamento.');
    const pending = { key: input.key, cancelled: false };
    this.pendingStart = pending;
    pending.promise = this.startCall(input, pending);
    try { return await pending.promise; }
    finally { if (this.pendingStart === pending) this.pendingStart = null; }
  }
  async startCall(input, pending) {
    await this.stopping;
    if (pending.cancelled) throw new Error('A conexão foi cancelada.');
    const catalog = await this.prepare();
    if (pending.cancelled) throw new Error('A conexão foi cancelada.');
    if (!catalog.models.some(m => m.id === input.model) || !catalog.voices.some(v => v.id === input.voice)) throw new Error('Selecione o modelo ou a voz de novo.');
    if (input.permission !== undefined && !Object.hasOwn(MODES, input.permission)) throw new Error('Selecione o nível de permissão de novo.');
    const cwd = input.workspace || path.join(this.root, 'conversation');
    if (input.workspace && (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory())) throw new Error('Não foi possível confirmar a pasta de trabalho.');
    if (!input.workspace) fs.mkdirSync(cwd, { recursive: true });
    if (this.threadWorkspace !== cwd) this.thread = null;
    const call = { key: input.key, threadId: null };
    this.call = call;
    const rpc = this.rpc;
    try {
      const [sandbox, approvalPolicy] = MODES[input.permission || 'ask'];
      const params = { model: input.model, cwd, sandbox, approvalPolicy,
        developerInstructions: 'This is a voice conversation. Respect the configured permissions and user approval decisions.' };
      const response = await rpc.request(this.thread ? 'thread/resume' : 'thread/start', {
        ...params, ...(this.thread ? { threadId: this.thread, excludeTurns: true } : {}),
      });
      this.thread = response.thread.id;
      this.threadWorkspace = cwd;
      call.threadId = this.thread;
      let record = this.history.read(this.thread);
      if (!record) { record = { id: this.thread, cwd, createdAt: Date.now(), updatedAt: Date.now(), messages: [] }; this.history.write(record); }
      call.record = record;
      if (this.call !== call || pending.cancelled) throw new Error('A conexão foi cancelada.');
      await rpc.request('thread/realtime/start', {
        threadId: call.threadId, realtimeSessionId: call.key, voiceSessionId: call.key,
        version: catalog.version, outputModality: 'audio', voice: input.voice,
        transport: { type: 'webrtc', sdp: input.sdp }, includeStartupContext: true,
        prompt: 'You are the voice interface for this conversation. Respond in the language the user is speaking unless they ask for another language. Keep responses natural and conversational.' +
          (record.messages.length ? '\nEarlier conversation, for context:\n' + record.messages.map(m => `${m.role}: ${m.text}`).join('\n').slice(-16000) : ''),
      });
      if (this.call !== call || pending.cancelled) throw new Error('A conexão foi cancelada.');
      return { key: call.key, model: response.model || input.model, threadId: this.thread };
    } catch (error) {
      if (this.call === call) { this.clearApprovals(); this.call = null; }
      if (call.threadId) await rpc.request('thread/realtime/stop', { threadId: call.threadId }, 5000).catch(() => {});
      throw error;
    }
  }
  notification({ method, params = {} }) {
    const call = this.call;
    if (!call || params.threadId !== call.threadId) return;
    const emit = data => this.emit('event', { key: call.key, ...data });
    if (method === 'thread/realtime/sdp') emit({ type: 'sdp', sdp: params.sdp });
    else if (method === 'thread/realtime/error') { emit({ type: 'error', message: publicError(params.message) }); void this.stop(call.key); }
    else if (method === 'thread/realtime/closed') { if (this.pendingStart) this.pendingStart.cancelled = true; this.clearApprovals(); this.call = null; emit({ type: 'closed' }); }
    else if (method === 'thread/realtime/transcript/delta' || method === 'thread/realtime/transcript/done') {
      if (params.role === 'user' || params.role === 'assistant') {
        if (method.endsWith('/done') && typeof params.text === 'string' && params.text.trim()) this.saveMessage(call, params.role, params.text);
        emit({ type: 'transcript', role: params.role, done: method.endsWith('/done'), text: String(params.text ?? params.delta ?? '').slice(-12000) });
      }
    }
  }
  saveMessage(call, role, text) {
    if (!call.record) return;
    const messages = call.record.messages;
    if (messages.at(-1)?.role === role && messages.at(-1)?.text === text) return;
    messages.push({ role, text, at: Date.now() });
    call.record.updatedAt = Date.now();
    try { this.history.write(call.record); } catch (error) { this.emit('event', { key: call.key, type: 'notice', message: 'Não foi possível salvar o histórico: ' + publicError(error) }); }
  }
  async listHistory() {
    await this.prepare();
    const records = this.history.list();
    let cursor = null; const seen = new Set();
    do {
      const native = await this.rpc.request('thread/list', { limit: 100, archived: false, sortKey: 'updated_at', ...(cursor ? { cursor } : {}) });
      for (const thread of native.data || []) {
        if (validId(thread.id) && !records.some(record => record.id === thread.id)) {
          records.push({ id: thread.id, cwd: thread.cwd, createdAt: thread.createdAt * 1000, updatedAt: thread.updatedAt * 1000, messages: [] });
        }
      }
      cursor = native.nextCursor || null;
      if (cursor && seen.has(cursor)) throw new Error('Não foi possível carregar a lista de conversas.');
      seen.add(cursor);
    } while (cursor);
    return records.filter(record => !record.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt).map(record => ({ id: record.id, cwd: record.cwd, updatedAt: record.updatedAt,
      title: record.messages.find(m => m.role === 'user')?.text.slice(0, 80) || 'Nova conversa' }));
  }
  async selectHistory(id) {
    if (this.call || this.pendingStart) throw new Error('Encerre a conversa de voz antes de escolher.');
    await this.prepare();
    if (id === null) { this.thread = null; this.threadWorkspace = null; return { messages: [] }; }
    if (!validId(id)) throw new Error('O ID da conversa é inválido.');
    let record = this.history.read(id);
    if (record?.deletedAt) throw new Error('Esta conversa foi excluída.');
    if (!record) {
      const result = await this.rpc.request('thread/read', { threadId: id, includeTurns: true });
      const thread = result.thread;
      if (!thread || thread.id !== id) throw new Error('O histórico da conversa não foi encontrado.');
      const messages = [];
      for (const turn of thread.turns || []) for (const item of turn.items || []) {
        const text = item.type === 'userMessage' ? (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n') : item.type === 'agentMessage' ? item.text : '';
        if (text) messages.push({ role: item.type === 'userMessage' ? 'user' : 'assistant', text });
      }
      record = { id, cwd: thread.cwd, createdAt: thread.createdAt * 1000, updatedAt: thread.updatedAt * 1000, messages };
      this.history.write(record);
    }
    if (!record) throw new Error('O histórico da conversa não foi encontrado.');
    if (!path.isAbsolute(record.cwd) || !fs.statSync(record.cwd).isDirectory()) throw new Error('A pasta de trabalho desta conversa não foi encontrada.');
    this.thread = id; this.threadWorkspace = record.cwd;
    return { id, cwd: record.cwd, messages: record.messages };
  }
  async setWorkspace(cwd) {
    await this.prepare();
    if (this.pendingStart) throw new Error('Espere a conexão terminar para mudar a pasta de trabalho.');
    if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('Não foi possível confirmar a pasta de trabalho.');
    if (this.thread) {
      const record = this.history.read(this.thread);
      if (!record) throw new Error('O histórico da conversa não foi encontrado.');
      record.cwd = cwd;
      this.history.write(record);
      if (this.call?.record?.id === record.id) this.call.record.cwd = cwd;
      this.threadWorkspace = cwd;
    }
  }
  async deleteHistory(id) {
    await this.prepare();
    if (!validId(id)) throw new Error('O ID da conversa é inválido.');
    if (this.pendingStart) throw new Error('Espere a conexão terminar para excluir a conversa.');
    const record = this.history.read(id);
    if (record?.deletedAt) throw new Error('Esta conversa foi excluída.');
    const call = this.call;
    if (call?.threadId === id) {
      await this.stop(call.key);
      // Stop renderer media even if the native deletion below fails.
      this.emit('event', { key: call.key, type: 'closed' });
    }
    await this.rpc.request('thread/delete', { threadId: id });
    this.history.write({ id, deletedAt: Date.now(), messages: [] });
    const active = this.thread === id;
    if (active) { this.thread = null; this.threadWorkspace = null; }
    return { id, active };
  }
  async text({ key, text }) {
    const call = this.call;
    if (!call || call.key !== key || !call.threadId) throw new Error('A conexão de voz foi encerrada.');
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('A mensagem precisa ter de 1 a 8.000 caracteres.');
    await this.rpc.request('thread/realtime/appendText', { threadId: call.threadId, text: text.trim() });
    if (this.call === call) this.saveMessage(call, 'user', text.trim());
  }
  respondApproval({ key, id, approve }) {
    const pending = this.approvals.get(String(id));
    if (!this.call || this.call.key !== key || !pending || typeof approve !== 'boolean') throw new Error('Este pedido de permissão expirou.');
    if (approve && Array.isArray(pending.message.params?.availableDecisions) && !pending.message.params.availableDecisions.includes('accept')) throw new Error('Este pedido não pode ser aprovado aqui.');
    this.approvals.delete(String(id));
    const { rpc, message } = pending;
    const result = message.method === 'item/permissions/requestApproval'
      ? { permissions: approve ? message.params.permissions : {}, scope: 'turn' }
      : { decision: approve ? 'accept' : 'decline' };
    rpc.send({ id: message.id, result });
  }
  clearApprovals() {
    for (const { rpc, message } of this.approvals.values()) {
      const result = message.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' };
      try { if (!rpc.closed) rpc.send({ id: message.id, result }); } catch {}
    }
    this.approvals.clear();
  }
  async stop(key) {
    const pending = this.pendingStart;
    if (pending?.key === key) {
      pending.cancelled = true;
      await pending.promise.catch(() => {});
    }
    const call = this.call;
    if (!call || call.key !== key) return;
    this.clearApprovals();
    this.call = null;
    if (call.threadId && this.rpc && !this.rpc.closed) {
      const stopping = this.rpc.request('thread/realtime/stop', { threadId: call.threadId }, 5000).catch(() => {});
      this.stopping = stopping;
      try { await stopping; } finally { if (this.stopping === stopping) this.stopping = null; }
    }
  }
  resetConnection() {
    this.epoch++;
    this.clearApprovals();
    this.preparing = null;
    const rpc = this.rpc; this.rpc = null; this.call = null; this.catalog = null; this.thread = null;
    rpc?.close();
    try { this.prepared?.finish(); } catch {}
    this.prepared = null;
  }
  dispose() {
    if (this.pendingStart) this.pendingStart.cancelled = true;
    this.resetConnection();
  }
}
module.exports = { LiveService, catalogFrom, publicError };
