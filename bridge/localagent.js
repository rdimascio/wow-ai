'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { lineReader } = require('./liveproto');

const DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'Qwen3-4B-Instruct-2507-Q4_K_M',
  timeoutMs: 120000,
});
const MAX_TOOL_STEPS = 6;
const MAX_HISTORY_MESSAGES = 40;
const MAX_SESSION_FILES = 200;
const MAX_TOOL_TEXT = 12000;
const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;
const MCP_TIMEOUT_MS = 20000;
const MCP_PROTOCOL = '2025-06-18';
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const LOCAL_RULES = [
  'You run on a small local model on the player\'s own computer.',
  'Your only tools are the ones in your tool list. You cannot search the web, run commands, read files or use any tool the text above names that is not in that list.',
  'Name a game thing only from what a tool returned or what the game context says. When neither says it, say you do not know; never guess a name, a number or a place.',
].join(' ');

function parseArgs(argv) {
  const opts = { baseUrl: DEFAULTS.baseUrl, model: DEFAULTS.model, timeoutMs: DEFAULTS.timeoutMs, mcpConfig: '', resume: '', sessions: '' };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    const value = () => {
      const v = argv[++k];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return String(v);
    };
    if (a === '--base-url') opts.baseUrl = value() || DEFAULTS.baseUrl;
    else if (a === '--model') opts.model = value() || DEFAULTS.model;
    else if (a === '--timeout-ms') {
      const n = Number(value());
      if (!Number.isSafeInteger(n) || n < 1) throw new Error('--timeout-ms must be a positive whole number');
      opts.timeoutMs = n;
    } else if (a === '--mcp-config') opts.mcpConfig = value();
    else if (a === '--resume') opts.resume = value();
    else if (a === '--sessions') opts.sessions = value();
    else throw new Error(`unknown option ${JSON.stringify(a)}`);
  }
  return opts;
}

function completionsUrl(baseUrl) {
  const base = String(baseUrl || DEFAULTS.baseUrl);
  const url = new URL('chat/completions', base.endsWith('/') ? base : base + '/');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`baseUrl ${base} is not an http or https address`);
  return url;
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

function parseInput(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && typeof v.prompt === 'string') return { system: typeof v.system === 'string' ? v.system : '', prompt: v.prompt };
  } catch {}
  return { system: '', prompt: String(text || '') };
}

function clip(text, max = MAX_TOOL_TEXT) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max) + '\n[cut: the tool answer was longer]' : s;
}

function cleanText(content) {
  const raw = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(c => (c && typeof c.text === 'string' ? c.text : '')).join('') : '';
  return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function toolArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { value: raw };
  if (raw === undefined || raw === null || raw === '') return { value: {} };
  try {
    const v = JSON.parse(String(raw));
    if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v };
  } catch {}
  return { error: 'the tool arguments were not a JSON object' };
}

function usageOf(u) {
  if (!u || typeof u !== 'object') return null;
  const n = v => (Number.isFinite(v) && v > 0 ? v : 0);
  const input = n(u.prompt_tokens), output = n(u.completion_tokens);
  return input || output ? { input_tokens: input, output_tokens: output } : null;
}

async function chatCompletion({ url, model, messages, tools, timeoutMs, fetchImpl }) {
  const body = { model, messages, stream: false };
  if (tools && tools.length) body.tools = tools;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `no answer within ${timeoutMs} ms` : (e && e.cause && e.cause.code) || (e && e.message) || String(e);
    throw new Error(`The local model server at ${url.origin} did not answer (${why}). Start llama-server, or set agents.local.baseUrl in config.json.`);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new Error('The local model server sent an answer that is too large.');
  if (!res.ok) throw new Error(`The local model server answered HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('The local model server sent an answer that is not JSON.'); }
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice || !choice.message || typeof choice.message !== 'object') throw new Error('The local model server sent an answer with no message.');
  return { message: choice.message, usage: usageOf(json.usage), model: typeof json.model === 'string' && json.model ? json.model : model };
}

function mcpClient(name, server, { spawnImpl = spawn, timeoutMs = MCP_TIMEOUT_MS, env = process.env } = {}) {
  const child = spawnImpl(server.command, Array.isArray(server.args) ? server.args.map(String) : [], {
    env: { ...env, ...(server.env && typeof server.env === 'object' ? server.env : {}) },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  const failAll = (err) => {
    closed = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  };
  child.on('error', e => failAll(new Error(`${name} could not start: ${e.message}`)));
  child.on('exit', () => failAll(new Error(`${name} exited`)));
  child.stdin.on('error', () => {});
  child.stdout.on('data', lineReader((msg) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(String((msg.error && msg.error.message) || 'error')));
    else p.resolve(msg.result);
  }));
  const write = msg => { if (!closed) child.stdin.write(JSON.stringify(msg) + '\n'); };
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        if (closed) { reject(new Error(`${name} is not running`)); return; }
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name} did not answer ${method} within ${timeoutMs} ms`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) { write({ jsonrpc: '2.0', method, params }); },
    close() {
      failAll(new Error(`${name} closed`));
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    },
  };
}

async function connectServers(configFile, deps = {}) {
  const out = { tools: [], route: new Map(), instructions: [], status: [], clients: [] };
  if (!configFile) return out;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
  catch (e) { out.status.push({ name: 'mcp-config', status: 'unreadable' }); return out; }
  const servers = cfg && cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  for (const [name, server] of Object.entries(servers)) {
    if (!SERVER_NAME_RE.test(name)) { out.status.push({ name, status: 'bad name' }); continue; }
    if (!server || typeof server !== 'object' || typeof server.command !== 'string' || (server.type && server.type !== 'stdio')) {
      out.status.push({ name, status: 'not stdio' });
      continue;
    }
    const client = mcpClient(name, server, deps);
    out.clients.push(client);
    try {
      const init = await client.request('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'claude-wow-local', version: '1' } });
      client.notify('notifications/initialized', {});
      const listed = await client.request('tools/list', {});
      if (init && typeof init.instructions === 'string' && init.instructions.trim()) out.instructions.push(init.instructions.trim());
      for (const t of (listed && Array.isArray(listed.tools) ? listed.tools : [])) {
        if (!t || typeof t.name !== 'string') continue;
        const fn = `mcp__${name}__${t.name}`;
        if (!TOOL_NAME_RE.test(fn) || out.route.has(fn)) continue;
        out.route.set(fn, { client, tool: t.name });
        const parameters = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} };
        out.tools.push({ type: 'function', function: { name: fn, description: String(t.description || ''), parameters } });
      }
      out.status.push({ name, status: 'connected' });
    } catch (e) {
      client.close();
      out.status.push({ name, status: 'failed' });
    }
  }
  return out;
}

async function callTool(route, name, input) {
  const target = route.get(name);
  if (!target) return { text: JSON.stringify({ error: `there is no tool called ${String(name).slice(0, 80)}` }), error: true };
  try {
    const r = await target.client.request('tools/call', { name: target.tool, arguments: input });
    const content = r && Array.isArray(r.content) ? r.content : [];
    const text = content.map(c => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
    return { text: clip(text || JSON.stringify(r && r.structuredContent ? r.structuredContent : {})), error: !!(r && r.isError) };
  } catch (e) {
    return { text: JSON.stringify({ error: e.message }), error: true };
  }
}

function sessionsDir(explicit, env = process.env) {
  if (explicit) return explicit;
  return path.join(require('./home').resolve(env).dir, 'local-sessions');
}

function sessionFile(dir, id) { return path.join(dir, `${id}.json`); }

function loadSession(dir, id) {
  if (!SESSION_ID_RE.test(String(id || ''))) return null;
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile(dir, id), 'utf8'));
    return s && Array.isArray(s.messages) ? s.messages : null;
  } catch { return null; }
}

function trimHistory(messages) {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  let start = messages.length - MAX_HISTORY_MESSAGES;
  while (start < messages.length && messages[start].role !== 'user') start++;
  return messages.slice(start);
}

function pruneSessions(dir, keep = MAX_SESSION_FILES) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => /\.json$/.test(f)); } catch { return; }
  if (files.length <= keep) return;
  const aged = files.map(f => {
    const file = path.join(dir, f);
    try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  for (const old of aged.slice(keep)) { try { fs.unlinkSync(old.file); } catch {} }
}

function saveSession(dir, id, messages) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = sessionFile(dir, id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id, messages: trimHistory(messages) }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  pruneSessions(dir);
}

async function run(opts, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const emit = ev => stdout.write(JSON.stringify(ev) + '\n');
  const input = parseInput(await readAll(deps.stdin || process.stdin));
  const dir = sessionsDir(opts.sessions, deps.env);
  const prior = opts.resume ? loadSession(dir, opts.resume) : null;
  const id = prior ? opts.resume : crypto.randomUUID();
  const fail = (message, servers) => {
    emit({ type: 'result', subtype: 'error', is_error: true, result: message, session_id: id });
    if (servers) for (const c of servers.clients) c.close();
    return 1;
  };
  let url;
  try { url = completionsUrl(opts.baseUrl); } catch (e) { return fail(e.message); }
  const mcp = await connectServers(opts.mcpConfig, { spawnImpl: deps.spawn, env: deps.env });
  emit({ type: 'system', subtype: 'init', session_id: id, model: opts.model, mcp_servers: mcp.status, tools: [...mcp.route.keys()] });
  const system = [input.system, ...mcp.instructions, LOCAL_RULES].filter(Boolean).join('\n\n');
  const history = [...(prior || []), { role: 'user', content: input.prompt }];
  let usage = null;
  let reply = '';
  try {
    for (let step = 0; ; step++) {
      const lastStep = step >= MAX_TOOL_STEPS;
      const r = await chatCompletion({ url, model: opts.model, messages: [{ role: 'system', content: system }, ...history], tools: lastStep ? [] : mcp.tools, timeoutMs: opts.timeoutMs, fetchImpl });
      if (r.usage) usage = r.usage;
      const content = cleanText(r.message.content);
      const calls = lastStep ? [] : (Array.isArray(r.message.tool_calls) ? r.message.tool_calls : [])
        .filter(c => c && c.function && typeof c.function.name === 'string')
        .map((c, i) => ({ id: typeof c.id === 'string' && c.id ? c.id : `call_${step}_${i}`, name: c.function.name, args: toolArguments(c.function.arguments), raw: c.function.arguments }));
      const blocks = [];
      if (content) blocks.push({ type: 'text', text: content });
      for (const c of calls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args.value || {} });
      emit({ type: 'assistant', session_id: id, message: { role: 'assistant', model: r.model, content: blocks, ...(r.usage ? { usage: r.usage } : {}) } });
      if (!calls.length) {
        reply = content;
        if (reply) history.push({ role: 'assistant', content: reply });
        break;
      }
      history.push({
        role: 'assistant',
        content: content || null,
        tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: typeof c.raw === 'string' ? c.raw : JSON.stringify(c.raw || {}) } })),
      });
      const results = [];
      for (const c of calls) {
        const res = c.args.error ? { text: JSON.stringify({ error: c.args.error }), error: true } : await callTool(mcp.route, c.name, c.args.value);
        history.push({ role: 'tool', tool_call_id: c.id, content: res.text });
        results.push({ type: 'tool_result', tool_use_id: c.id, content: res.text, is_error: res.error });
      }
      emit({ type: 'user', session_id: id, message: { role: 'user', content: results } });
    }
  } catch (e) {
    return fail(e.message, mcp);
  }
  for (const c of mcp.clients) c.close();
  if (!reply) return fail('The local model gave an empty answer.');
  try { saveSession(dir, id, history); }
  catch (e) {
    emit({ type: 'result', subtype: 'success', is_error: false, result: `${reply}\n\n(The local agent could not save this chat, so the next message starts fresh: ${e.message})`, ...(usage ? { usage } : {}) });
    return 0;
  }
  emit({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: id, ...(usage ? { usage } : {}) });
  return 0;
}

function main(argv, deps = {}) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) {
    (deps.stdout || process.stdout).write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: `local agent: ${e.message}` }) + '\n');
    process.exitCode = 2;
    return Promise.resolve(2);
  }
  return run(opts, deps).then((code) => { process.exitCode = code; return code; }, (e) => {
    (deps.stdout || process.stdout).write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: `local agent failed: ${e && e.message ? e.message : String(e)}` }) + '\n');
    process.exitCode = 1;
    return 1;
  });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  DEFAULTS, MAX_TOOL_STEPS, MAX_HISTORY_MESSAGES, LOCAL_RULES,
  parseArgs, completionsUrl, parseInput, toolArguments, trimHistory, loadSession, saveSession, pruneSessions,
  connectServers, callTool, chatCompletion, run, main,
};
