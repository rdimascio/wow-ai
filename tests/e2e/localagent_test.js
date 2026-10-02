'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { makeRoot, gameRunner } = require('./helpers');
const D = require('../../bridge/datasync');

const ROOT = makeRoot('localagent');
const withGame = gameRunner(ROOT);
const REPO = path.join(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'wago');
const BUILD = '1.60.1.200';

function fixtureFetch(url) {
  const u = new URL(url);
  const table = /^\/db2\/(\w+)\/csv$/.exec(u.pathname)[1];
  const headers = { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${table}.${u.searchParams.get('build')}.csv"` };
  return Promise.resolve(new Response(fs.readFileSync(path.join(FIXTURES, `${table}.csv`), 'utf8'), { status: 200, headers }));
}

async function fakeModel(answer) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer(body, bodies.length)));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, bodies, close: () => new Promise(resolve => server.close(resolve)) };
}

const message = m => ({ model: 'qwen-test', choices: [{ message: { role: 'assistant', ...m } }], usage: { prompt_tokens: 50, completion_tokens: 5 } });

test('an ask chat on the local agent gets the wowdata tools, calls one through the real data server, and answers in game', async () => {
  const model = await fakeModel((body, n) => {
    if (n === 1) return message({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mcp__wowdata__wow_item', arguments: JSON.stringify({ id: 501 }) } }] });
    const tool = body.messages.find(m => m.role === 'tool');
    const found = JSON.parse(tool.content).results[0].name;
    return message({ content: `That is ${found}, {item:501}.` });
  });
  const config = {
    agent: 'local',
    agents: { claude: { path: path.join(REPO, 'dev', 'fake-claude.js') }, local: { baseUrl: model.baseUrl, model: 'qwen-test', timeoutMs: 20000 } },
  };
  const beforeLaunch = async sb => { await D.sync({ dataDir: path.join(sb.home, 'data'), build: BUILD, fetch: fixtureFetch }); };
  try {
    await withGame({ plugin: 'ask', config, beforeLaunch }, async h => {
      const r = await h.client.say('what is item 501?');
      assert.equal(r.text, 'That is Fixture Blade, {item:501}.');
      assert.equal(model.bodies.length, 2);
      assert.ok(model.bodies[0].tools.some(t => t.function.name === 'mcp__wowdata__wow_item'));
      assert.match(model.bodies[0].messages[0].content, /You run on a small local model/);
      assert.match(model.bodies[0].messages.at(-1).content, /what is item 501\?/);
      await h.bridge.waitForLine(/Local starting in .*wowdata 1\.60\.1\.200/);
      assert.deepEqual(h.agentCalls(), [], 'the fake Claude was never started');

      const again = await h.client.say('and again?');
      assert.equal(again.text, 'That is Fixture Blade, {item:501}.');
      const resumed = model.bodies[2].messages.map(m => m.role);
      assert.deepEqual(resumed.slice(0, 5), ['system', 'user', 'assistant', 'tool', 'assistant']);
    });
  } finally {
    await model.close();
  }
});
