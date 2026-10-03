'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const SB = require('../../dev/sandbox');
const { encodePng, luaQuote } = require('../../dev/wow/client');
const { makeRoot, gameRunner } = require('./helpers');
const UPD = require('../../bridge/selfupdate');
const REL = require('../../bridge/releases');
const IDLE = require('../../bridge/idle');
const VERSION = require('../../package.json').version;

const ROOT = makeRoot('selfupdate');
const withGame = gameRunner(ROOT);

function count(text, re) {
  return (text.match(new RegExp(re.source, 'g')) || []).length;
}

const CELL = 4;
const CELLS = 200;
const WIDTH = 1920;
const HEIGHT = 1080;
const CHARACTER = 'Testchar-TestRealm';

function gsRecord(session, seq) {
  return [session, '', String(seq), '', 'kind=gs', CHARACTER, `gs1\nmoney:${String(seq).padStart(8, '0')}:${1000 + seq}`].join('\x1F');
}

function writeGsShot(h, payload, n) {
  const cells = h.client.luaValue(`(function() local c = ClaudeWoW_Codec.Encode(0, ${luaQuote(payload)}, 1); local t = {}; for i = 1, #c do t[i] = c[i] end; return table.concat(t, ",") end)()`).split(',').map(Number);
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  cells.forEach((v, i) => {
    const r = Math.floor(i / CELLS), c = i % CELLS;
    const lv = [(v >> 2) & 1, (v >> 1) & 1, v & 1].map(b => (b ? 255 : 0));
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const o = ((r * CELL + y) * WIDTH + c * CELL + x) * 3;
      rgb[o] = lv[0]; rgb[o + 1] = lv[1]; rgb[o + 2] = lv[2];
    }
  });
  fs.writeFileSync(SB.assertSafe(path.join(h.sb.screenshots, `WoWScrnShot_020299_${String(n).padStart(6, '0')}.png`)), encodePng(WIDTH, HEIGHT, rgb));
}

test('an installed update waits for the run in flight, then the supervisor restarts the bridge once', async () => {
  await withGame({ supervised: true, config: { autoUpdateIdleSeconds: 6 } }, async h => {
    await h.bridge.waitForLine(/self-update: off \(running from source/, { from: 0 });
    await h.client.connect();
    const reply = h.client.say('slow job [[sleep 12]]', { timeoutMs: 60000 });
    await h.client.waitFor(() => h.agentCalls().length === 1, { label: 'the agent to start' });
    UPD.writeRecord(h.sb.home, { pendingRestart: true, version: '99.0.0', from: VERSION, attemptAt: Date.now(), ok: true, status: 'updated', message: 'test' });
    await h.bridge.waitForLine(/self-update: 99\.0\.0 is installed; the restart waits: 1 agent run\(s\) in flight \(#\d+\)/, { timeoutMs: 15000 });
    assert.equal(count(h.bridge.output, /self-update: restarting on/), 0, 'no restart while the run is in flight');
    const r = await reply;
    assert.equal(r.role, 'assistant');
    const restarting = await h.bridge.waitForLine(/self-update: restarting on 99\.0\.0 now: nothing is running/, { timeoutMs: 30000, from: 0 });
    const doneAt = h.bridge.output.search(new RegExp(`#${r.id}@\\S+ done \\(`));
    assert.ok(doneAt >= 0 && doneAt < restarting.index, 'the run finished before the restart');
    const stampOf = re => Date.parse((new RegExp(`\\[(\\S+)\\] ${re.source}`).exec(h.bridge.output) || [])[1]);
    const gap = stampOf(/self-update: restarting on 99\.0\.0/) - stampOf(new RegExp(`#${r.id}@\\S+ done \\(`));
    assert.ok(gap >= 5900, `the restart waits the quiet time after the reply too, so the game can read it (it came ${gap} ms after)`);
    await h.bridge.waitForLine(/bridge stopped for an update; starting /, { from: 0 });
    await h.bridge.waitForLine(/self-update: restarted for 99\.0\.0, but this is still/, { timeoutMs: 30000, from: 0 });
    await h.bridge.waitForLine(/screenshot transport: watching[\s\S]*screenshot transport: watching/, { timeoutMs: 30000, from: 0 });
    assert.match(h.bridge.output.slice(restarting.index), /republishing \d+ finished repl(y|ies) from before the restart/, 'the restarted bridge publishes the last reply again, in case the game had not read it');
    assert.ok(Object.values(h.state().replies || {}).some(e => e.record && e.record.id === r.id), 'the reply is kept in state.json across the update restart');
    await new Promise(res => setTimeout(res, UPD.RESTART_TICK_MS + 2000));
    assert.equal(count(h.bridge.output, /self-update: restarting on/), 1, 'exactly one restart');
    assert.equal(count(h.bridge.output, /bridge exited \(/), 0, 'the supervisor did not treat it as a crash');
    assert.equal(UPD.readRecord(h.sb.home).pendingRestart, false);
    const again = await h.client.say('after the restart');
    assert.equal(again.role, 'assistant');
  });
});

test('an installed update does not restart the bridge while a deploy is switching releases', async () => {
  await withGame({ supervised: true, config: { autoUpdateIdleSeconds: 6 } }, async h => {
    await h.client.connect();
    await h.bridge.waitForLine(/hello from session/, { from: 0 });
    await new Promise(res => setTimeout(res, 3000));
    assert.ok(IDLE.idleStatus(h.state()).idle, 'nothing is running, queued or handled before the deploy starts');
    const lock = REL.acquireLock(REL.layout(h.sb.home).lock, { command: 'e2e deploy' });
    try {
      lock.setPhase(REL.SWITCHING);
      UPD.writeRecord(h.sb.home, { pendingRestart: true, version: '99.0.0', from: VERSION, attemptAt: Date.now(), ok: true, status: 'updated', message: 'test' });
      await h.bridge.waitForLine(new RegExp(`self-update: 99\\.0\\.0 is installed; the restart waits: a deploy \\(pid ${process.pid}\\) is switching releases`), { timeoutMs: 20000 });
      await new Promise(res => setTimeout(res, UPD.RESTART_TICK_MS + 1000));
      assert.equal(count(h.bridge.output, /self-update: restarting on/), 0, 'no restart under the switching mark');
    } finally {
      lock.release();
    }
    await h.bridge.waitForLine(/self-update: restarting on 99\.0\.0 now/, { timeoutMs: 30000, from: 0 });
    await h.bridge.waitForLine(/self-update: restarted for 99\.0\.0, but this is still/, { timeoutMs: 30000, from: 0 });
  });
});

test('game-state telemetry that keeps coming does not hold the restart back: only chat messages and replies count as activity', async () => {
  await withGame({ supervised: true, config: { autoUpdateIdleSeconds: 6 } }, async h => {
    await h.client.connect();
    await h.bridge.waitForLine(/hello from session/, { from: 0 });
    const session = h.client.db().session;
    const from = h.bridge.output.length;
    UPD.writeRecord(h.sb.home, { pendingRestart: true, version: '99.0.0', from: VERSION, attemptAt: Date.now(), ok: true, status: 'updated', message: 'test' });
    const until = Date.now() + 40000;
    let n = 0;
    while (Date.now() < until && !/self-update: restarting on 99\.0\.0/.test(h.bridge.output.slice(from))) {
      writeGsShot(h, gsRecord(session, 5000 + n), n);
      n++;
      await new Promise(res => setTimeout(res, 1500));
    }
    const restartAt = h.bridge.output.slice(from).search(/self-update: restarting on 99\.0\.0/);
    assert.ok(restartAt >= 0, `the bridge restarted while gs records kept coming (${n} sent)`);
    const before = h.bridge.output.slice(from, from + restartAt);
    const gsStamps = [...before.matchAll(/\[(\S+)\] strip #0 \(screenshot WoWScrnShot_020299_\d+\.png, .*?\): 1 message/g)].map(m => Date.parse(m[1]));
    const restartStamp = Date.parse(/\[(\S+)\] self-update: restarting on 99\.0\.0/.exec(h.bridge.output.slice(from))[1]);
    assert.ok(gsStamps.length >= 1, 'the gs frames reached the bridge');
    assert.ok(restartStamp - gsStamps[gsStamps.length - 1] < 6000, `a gs record came in less than the 6 s quiet time before the restart (${restartStamp - gsStamps[gsStamps.length - 1]} ms), so it did not count as activity`);
  });
});

function fakeLiveSession(sb, name) {
  const script = path.join(sb.dir, 'fake-session.js');
  fs.writeFileSync(SB.assertSafe(script), [
    "'use strict';",
    "const { spawn } = require('child_process');",
    `const child = spawn(process.execPath, [${JSON.stringify(path.join(__dirname, '..', '..', 'bridge', 'channel.js'))}], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });`,
    'process.stdin.pipe(child.stdin);',
    'child.stdout.pipe(process.stdout);',
    "child.on('exit', code => process.exit(code || 0));",
  ].join('\n'));
  const proc = spawn(process.execPath, [script, '--dangerously-load-development-channels', 'server:claude-wow'], {
    env: { ...sb.env, CLAUDE_WOW_LIVE_NAME: name },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = [];
  let buf = '';
  proc.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try { lines.push(JSON.parse(line)); } catch {}
    }
  });
  const send = msg => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  return { proc, lines, send };
}

test('a late reply from a live session counts as activity: the update restart waits the quiet time after it', { skip: process.platform === 'win32' }, async () => {
  const beforeLaunch = sb => {
    const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
    cfg.autoUpdateIdleSeconds = 6;
    cfg.plugins = { ...cfg.plugins, live: { ...(cfg.plugins && cfg.plugins.live), pickupMs: 1000, pickupPollMs: 500 } };
    fs.writeFileSync(SB.assertSafe(sb.config), JSON.stringify(cfg, null, 2) + '\n');
  };
  await withGame({ supervised: true, beforeLaunch }, async h => {
    await h.client.connect();
    await h.bridge.waitForLine(/hello from session/, { from: 0 });
    const session = fakeLiveSession(h.sb, 'late-e2e');
    try {
      session.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } });
      session.send({ method: 'notifications/initialized' });
      session.send({ id: 2, method: 'tools/list' });
      await h.bridge.waitForLine(/session "late-e2e" connected.*, listening/, { timeoutMs: 30000 });
      h.client.slash('/claude config plugin live');
      h.client.send('are you there');
      const note = await h.client.waitFor(() => session.lines.find(m => m.method === 'notifications/claude/channel'), { timeoutMs: 30000, label: 'the channel notification' });
      const chatId = /chat_id "([^"]+)"/.exec(note.params.content)[1];
      await h.bridge.waitForLine(/"late-e2e" showed no sign of it within 1000 ms/, { timeoutMs: 30000 });
      const lastFinish = () => Math.max(0, ...[...h.bridge.output.matchAll(/\[(\S+)\] #\d+@\S+ (?:done|error) \(/g)].map(m => Date.parse(m[1])));
      await h.client.waitFor(() => Date.now() - lastFinish() >= 7500, { timeoutMs: 40000, everyMs: 250, label: 'the bridge to be quiet for longer than the idle time' });
      session.send({ id: 3, method: 'tools/call', params: { name: 'wow_reply', arguments: { chat_id: chatId, text: 'Sorry, I was busy.' } } });
      await h.bridge.waitForLine(/late reply delivered/, { timeoutMs: 15000 });
      UPD.writeRecord(h.sb.home, { pendingRestart: true, version: '99.0.0', from: VERSION, attemptAt: Date.now(), ok: true, status: 'updated', message: 'test' });
      await h.bridge.waitForLine(/self-update: restarting on 99\.0\.0/, { timeoutMs: 40000 });
      const stamp = re => Date.parse((new RegExp(`\\[(\\S+)\\] ${re.source}`).exec(h.bridge.output) || [])[1]);
      const gap = stamp(/self-update: restarting on 99\.0\.0/) - stamp(/\S+ late reply delivered/);
      assert.ok(gap >= 5900, `the restart waited the quiet time after the late reply (it came ${gap} ms after)`);
    } finally {
      session.proc.kill();
    }
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
