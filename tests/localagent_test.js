'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const L = require('../bridge/localagent');
const A = require('../bridge/agents');

const FAKE_MCP = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'wowdata' }, instructions: 'FAKE DATA RULES' } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'wow_item', description: 'look up an item', inputSchema: { type: 'object', properties: { id: { type: 'integer' } } } }] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ called: m.params.name, args: m.params.arguments, name: 'Fake Item' }) }] } });
});
`;

function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `localagent-${name}-`));
}

async function fakeModel(replies) {
  const bodies = [];
  const queue = [...replies];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      bodies.push({ url: req.url, body: JSON.parse(raw) });
      const next = typeof queue[0] === 'function' ? queue[0] : queue.shift();
      const r = typeof next === 'function' ? next(bodies.length) : next;
      res.writeHead(r.status || 200, { 'content-type': 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies, close: () => new Promise(resolve => server.close(resolve)) };
}

const say = (content, usage = { prompt_tokens: 120, completion_tokens: 8 }) => ({ body: { model: 'qwen-test', choices: [{ message: { role: 'assistant', content } }], usage } });
const callTools = (...calls) => ({ body: { model: 'qwen-test', choices: [{ message: { role: 'assistant', content: '', tool_calls: calls.map((c, i) => ({ id: `c${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] } });

async function runOnce(opts, input) {
  const lines = [];
  const stdout = { write: s => { lines.push(...String(s).split('\n').filter(Boolean)); return true; } };
  const code = await L.run({ ...L.DEFAULTS, ...opts }, { stdin: Readable.from([JSON.stringify(input)]), stdout, env: {} });
  return { code, events: lines.map(l => JSON.parse(l)) };
}

function mcpConfigFile(dir, server) {
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { wowdata: server } }));
  return file;
}

function feedAll(events) {
  const parser = A.AGENTS.local.parser({});
  const out = { progress: [], notes: [], mcpDown: [] };
  for (const ev of events) {
    const r = parser.feed(ev);
    out.progress.push(...r.progress);
    out.notes.push(...r.notes);
    if (r.session) out.session = r.session;
    if (r.usage) out.usage = r.usage;
    if (r.mcpDown) out.mcpDown.push(...r.mcpDown);
    if (r.done) out.done = r.done;
  }
  return out;
}

test('the local agent entry: its own script, the config block as flags, the prompt and system prompt as JSON on stdin', () => {
  assert.ok(A.agentIds().includes('local'));
  assert.equal(A.normalizeAgent('Local'), 'local');
  const cmd = A.resolveCommand('local', {});
  assert.equal(cmd.found, true);
  assert.equal(path.basename(cmd.args[0]), 'localagent.js');
  assert.deepEqual(A.AGENTS.local.args({ cfg: {} }), ['--base-url', 'http://127.0.0.1:8080/v1', '--model', 'Qwen3-4B-Instruct-2507-Q4_K_M', '--timeout-ms', '120000']);
  assert.deepEqual(A.AGENTS.local.args({ cfg: { baseUrl: 'http://127.0.0.1:9000/v1', model: 'm', timeoutMs: 5000 }, resume: 'r', mcpConfig: '/x/mcp.json' }),
    ['--base-url', 'http://127.0.0.1:9000/v1', '--model', 'm', '--timeout-ms', '5000', '--mcp-config', '/x/mcp.json', '--resume', 'r']);
  assert.deepEqual(A.AGENTS.local.input({ prompt: '-p hi', system: 'SYS' }), { stdin: JSON.stringify({ system: 'SYS', prompt: '-p hi' }), note: '' });
  assert.match(A.AGENTS.local.input({ prompt: 'hi', system: 'S', images: [{ file: '/t/v.png' }] }).note, /cannot see images/);
  assert.deepEqual(A.unsupportedSettings('local', { model: 'm', effort: 'high' }), ['--effort high']);
});

test('a text answer: one request with the system prompt first, the reply as the result, the chat saved for resume, cost 0', async () => {
  const dir = scratch('text');
  const model = await fakeModel([say('Hello from the local model.')]);
  try {
    const { code, events } = await runOnce({ baseUrl: model.baseUrl, model: 'qwen-test', sessions: dir }, { system: 'GAME SYSTEM', prompt: 'hi there' });
    assert.equal(code, 0);
    assert.equal(model.bodies.length, 1);
    assert.equal(model.bodies[0].url, '/v1/chat/completions');
    const sent = model.bodies[0].body;
    assert.equal(sent.model, 'qwen-test');
    assert.equal(sent.stream, false);
    assert.equal(sent.tools, undefined);
    assert.equal(sent.messages[0].role, 'system');
    assert.match(sent.messages[0].content, /^GAME SYSTEM/);
    assert.ok(sent.messages[0].content.includes(L.LOCAL_RULES));
    assert.deepEqual(sent.messages.slice(1), [{ role: 'user', content: 'hi there' }]);
    const parsed = feedAll(events);
    assert.deepEqual(parsed.done, { text: 'Hello from the local model.', error: false });
    assert.equal(parsed.usage.cost, 0);
    assert.equal(parsed.usage.costUnknown, undefined);
    assert.equal(parsed.usage.context, 120);
    assert.ok(fs.existsSync(path.join(dir, `${parsed.session}.json`)));
  } finally {
    await model.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resume: the next message carries the saved chat and keeps the session id; an id that is not one of ours starts fresh', async () => {
  const dir = scratch('resume');
  const model = await fakeModel([say('first answer'), say('second answer'), say('fresh answer')]);
  try {
    const first = feedAll((await runOnce({ baseUrl: model.baseUrl, sessions: dir }, { system: 'S', prompt: 'one' })).events);
    const second = feedAll((await runOnce({ baseUrl: model.baseUrl, sessions: dir, resume: first.session }, { system: 'S2', prompt: 'two' })).events);
    assert.equal(second.session, first.session);
    assert.deepEqual(model.bodies[1].body.messages.slice(1), [
      { role: 'user', content: 'one' }, { role: 'assistant', content: 'first answer' }, { role: 'user', content: 'two' },
    ]);
    assert.match(model.bodies[1].body.messages[0].content, /^S2/);
    const outside = path.join(path.dirname(dir), 'escape.json');
    fs.writeFileSync(outside, JSON.stringify({ messages: [{ role: 'user', content: 'LEAKED' }] }));
    try {
      const third = feedAll((await runOnce({ baseUrl: model.baseUrl, sessions: dir, resume: '../escape' }, { system: 'S', prompt: 'three' })).events);
      assert.notEqual(third.session, '../escape');
      assert.deepEqual(model.bodies[2].body.messages.slice(1), [{ role: 'user', content: 'three' }]);
    } finally { fs.rmSync(outside, { force: true }); }
  } finally {
    await model.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tools: the wowdata MCP server from --mcp-config is offered to the model, its calls run over stdio, and the answer comes back', async () => {
  const dir = scratch('tools');
  const model = await fakeModel([callTools({ name: 'mcp__wowdata__wow_item', args: { id: 6948 } }), say('It is {item:6948}.')]);
  try {
    const mcpConfig = mcpConfigFile(dir, { type: 'stdio', command: process.execPath, args: ['-e', FAKE_MCP] });
    const { code, events } = await runOnce({ baseUrl: model.baseUrl, sessions: dir, mcpConfig }, { system: 'S', prompt: 'what is item 6948?' });
    assert.equal(code, 0);
    assert.equal(model.bodies.length, 2);
    const first = model.bodies[0].body;
    assert.deepEqual(first.tools.map(t => t.function.name), ['mcp__wowdata__wow_item']);
    assert.match(first.messages[0].content, /FAKE DATA RULES/);
    const second = model.bodies[1].body.messages;
    assert.equal(second[2].tool_calls[0].function.name, 'mcp__wowdata__wow_item');
    assert.equal(second[3].role, 'tool');
    assert.deepEqual(JSON.parse(second[3].content), { called: 'wow_item', args: { id: 6948 }, name: 'Fake Item' });
    const init = events.find(e => e.type === 'system');
    assert.deepEqual(init.mcp_servers, [{ name: 'wowdata', status: 'connected' }]);
    const parsed = feedAll(events);
    assert.ok(parsed.progress.includes('mcp__wowdata__wow_item'));
    assert.deepEqual(parsed.mcpDown, []);
    assert.equal(parsed.done.text, 'It is {item:6948}.');
  } finally {
    await model.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tools: a model that keeps calling tools is made to answer without them after the step limit', async () => {
  const dir = scratch('steps');
  const loop = callTools({ name: 'mcp__wowdata__wow_item', args: { id: 1 } });
  const model = await fakeModel([n => (n > L.MAX_TOOL_STEPS ? say('done looking') : loop)]);
  try {
    const mcpConfig = mcpConfigFile(dir, { type: 'stdio', command: process.execPath, args: ['-e', FAKE_MCP] });
    const { events } = await runOnce({ baseUrl: model.baseUrl, sessions: dir, mcpConfig }, { system: 'S', prompt: 'loop' });
    assert.equal(model.bodies.length, L.MAX_TOOL_STEPS + 1);
    assert.ok(model.bodies.slice(0, -1).every(b => Array.isArray(b.body.tools)));
    assert.equal(model.bodies[model.bodies.length - 1].body.tools, undefined);
    assert.equal(feedAll(events).done.text, 'done looking');
  } finally {
    await model.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a game data server that does not start is reported, and the chat still gets an answer', async () => {
  const dir = scratch('mcpdown');
  const model = await fakeModel([say('no data, sorry')]);
  try {
    const mcpConfig = mcpConfigFile(dir, { type: 'stdio', command: process.execPath, args: ['-e', 'process.exit(3)'] });
    const { events } = await runOnce({ baseUrl: model.baseUrl, sessions: dir, mcpConfig }, { system: 'S', prompt: 'hi' });
    const parsed = feedAll(events);
    assert.deepEqual(parsed.mcpDown, [{ name: 'wowdata', status: 'failed' }]);
    assert.equal(model.bodies[0].body.tools, undefined);
    assert.equal(parsed.done.text, 'no data, sorry');
  } finally {
    await model.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('errors: no server, an HTTP error and an empty answer end the run with an error result and save nothing', async () => {
  const dir = scratch('errors');
  const closed = await fakeModel([]);
  const deadUrl = closed.baseUrl;
  await closed.close();
  const model = await fakeModel([{ status: 500, body: 'model not loaded' }, say('')]);
  try {
    const down = await runOnce({ baseUrl: deadUrl, sessions: dir }, { system: 'S', prompt: 'hi' });
    assert.equal(down.code, 1);
    assert.match(feedAll(down.events).done.text, /did not answer.*llama-server/s);
    assert.equal(feedAll(down.events).done.error, true);
    const bad = feedAll((await runOnce({ baseUrl: model.baseUrl, sessions: dir }, { system: 'S', prompt: 'hi' })).events);
    assert.match(bad.done.text, /HTTP 500: model not loaded/);
    const empty = feedAll((await runOnce({ baseUrl: model.baseUrl, sessions: dir }, { system: 'S', prompt: 'hi' })).events);
    assert.deepEqual(empty.done, { text: 'The local model gave an empty answer.', error: true });
    assert.deepEqual(fs.readdirSync(dir), []);
    const notHttp = feedAll((await runOnce({ baseUrl: 'file:///etc', sessions: dir }, { system: 'S', prompt: 'hi' })).events);
    assert.match(notHttp.done.text, /not an http or https address/);
  } finally {
    await model.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('history is trimmed to start at a user message, and old session files are pruned', () => {
  const many = [];
  for (let i = 0; i < L.MAX_HISTORY_MESSAGES; i++) many.push({ role: i % 2 ? 'assistant' : 'user', content: String(i) });
  many.push({ role: 'tool', content: 'x' }, { role: 'user', content: 'last' });
  const kept = L.trimHistory(many);
  assert.ok(kept.length <= L.MAX_HISTORY_MESSAGES);
  assert.equal(kept[0].role, 'user');
  assert.deepEqual(kept[kept.length - 1], { role: 'user', content: 'last' });
  const dir = scratch('prune');
  try {
    for (let i = 0; i < 5; i++) {
      const f = path.join(dir, `s${i}.json`);
      fs.writeFileSync(f, '{}');
      fs.utimesSync(f, new Date(1000 * (i + 1)), new Date(1000 * (i + 1)));
    }
    L.pruneSessions(dir, 3);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['s2.json', 's3.json', 's4.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the script runs as a process: flags from the agent entry, input on stdin, stream-json out', async () => {
  const dir = scratch('process');
  const model = await fakeModel([say('from the process')]);
  try {
    const cmd = A.resolveCommand('local', {});
    const args = [...cmd.args, ...A.AGENTS.local.args({ cfg: { baseUrl: model.baseUrl } }), '--sessions', dir];
    const child = spawn(cmd.file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.stdin.end(A.AGENTS.local.input({ prompt: 'hello', system: 'S' }).stdin);
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(code, 0);
    const parsed = feedAll(out.trim().split('\n').map(l => JSON.parse(l)));
    assert.equal(parsed.done.text, 'from the process');
    const bad = spawn(cmd.file, [...cmd.args, '--nope'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let badOut = '';
    bad.stdout.on('data', c => { badOut += c; });
    assert.equal(await new Promise(resolve => bad.on('close', resolve)), 2);
    assert.match(JSON.parse(badOut.trim()).result, /unknown option/);
  } finally {
    await model.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
