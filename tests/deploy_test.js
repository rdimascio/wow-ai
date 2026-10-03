'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const D = require('../bridge/deploy');
const REL = require('../bridge/releases');
const S = require('../bridge/service');
const UPD = require('../bridge/selfupdate');

const NO_SYMLINKS = process.platform === 'win32';
const UID = 501;
const KICKSTART = ['launchctl', 'kickstart', '-k', `gui/${UID}/${S.LABEL}`];

function scratch(name) {
  const dir = path.join(__dirname, 'tmp', 'deploy', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(root, version = '0.5.0') {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(repo, 'marker.txt'), 'one');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  return repo;
}

function commit(repo, marker) {
  fs.writeFileSync(path.join(repo, 'marker.txt'), marker);
  git(repo, 'commit', '-q', '-am', marker);
  return git(repo, 'rev-parse', 'HEAD');
}

function fakeService(platform, exec) {
  return Object.assign(Object.create(S.backend(platform === 'darwin' ? 'darwin' : 'linux')), { exec, uid: () => UID });
}

function harness(root, { runsCurrent = true, platform = 'darwin', probe, setupOut = 'addon    : 18 file(s)\nDone. Next:\n  1. Fully quit and relaunch World of Warcraft (it only discovers new addon folders at launch).\n  4. In game:  /claude', failRestart = false, loaded = true } = {}) {
  const base = path.join(root, 'home');
  fs.mkdirSync(base, { recursive: true });
  const l = REL.layout(base);
  const client = path.join(root, 'World of Warcraft', '_classic_era_');
  fs.writeFileSync(l.config, JSON.stringify({ addonDir: path.join(client, 'Interface', 'AddOns') }));
  const definitionFile = path.join(root, 'io.claudewow.bridge.plist');
  fs.writeFileSync(definitionFile, runsCurrent
    ? S.launchdPlist({ node: REL.currentBinary(l), script: '', cwd: base, logFile: '/l' })
    : S.launchdPlist({ node: '/Users/p/.nvm/versions/node/v24/bin/node', script: '/Users/p/wow-ai/bridge/supervisor.js', cwd: '/Users/p/wow-ai', logFile: '/l' }));
  const events = [];
  const builds = [];
  const out = [];
  const err = [];
  let clock = 0;
  const ctx = {
    base, platform, uid: UID, definitionFile, tmpRoot: root,
    signals: new EventEmitter(),
    exit: code => { throw new Error(`the test reached process.exit(${code})`); },
    now: () => clock, sleep: async ms => { clock += ms; }, pollMs: 1000, settleMs: 0,
    out: line => out.push(line), err: line => err.push(line),
    probe: probe ? () => { const s = probe(); events.push(['probe', s.idle, REL.currentName(l), (REL.readLock(l.lock) || {}).phase]); return s; } : () => ({ idle: true, reason: 'idle' }),
    run: (cmd, args, opts) => {
      if (cmd === 'git') return D.runCommand(cmd, args, opts);
      if (cmd === 'launchctl' || cmd === 'systemctl') throw new Error(`the test reached ${cmd} through ctx.run`);
      events.push([cmd, ...args]);
      if (cmd === REL.currentBinary(l)) return { ok: true, status: 0, out: setupOut };
      return { ok: true, status: 0, out: '' };
    },
    service: fakeService(platform, (cmd, args) => {
      assert.ok(cmd === 'launchctl' || cmd === 'systemctl', `the service backend ran ${cmd}`);
      if (cmd === 'launchctl' && args[0] === 'print') return { ok: loaded, status: loaded ? 0 : 113, out: '' };
      events.push([cmd, ...args]);
      if (failRestart) return { ok: false, status: 1, out: 'Could not find service' };
      return { ok: true, status: 0, out: '' };
    }),
    build: (src, outDir) => {
      builds.push(src);
      assert.ok(fs.existsSync(path.join(src, 'marker.txt')), 'the build sees the source tree');
      const file = path.join(outDir, 'claude-wow-darwin-arm64');
      fs.writeFileSync(file, `binary of ${fs.readFileSync(path.join(src, 'marker.txt'), 'utf8')}`);
      return file;
    },
  };
  return { ctx, l, client, events, builds, out, err };
}

function worktrees(repo) {
  return git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(x => x.startsWith('worktree ')).length;
}

test('argument parsing: deploy takes one target and its options, rollback and status take none, anything else is an error', () => {
  assert.equal(D.parseArgs([]).cmd, 'help');
  const d = D.parseArgs(['deploy', 'origin/main', '--repo', '/r', '--timeout', '90', '--keep', '3']);
  assert.deepEqual({ cmd: d.cmd, target: d.target, repo: d.repo, timeoutMs: d.timeoutMs, keep: d.keep }, { cmd: 'deploy', target: 'origin/main', repo: '/r', timeoutMs: 90000, keep: 3 });
  assert.equal(D.parseArgs(['deploy']).target, '');
  assert.match(D.parseArgs(['deploy', 'a', 'b']).error, /unexpected argument "b"/);
  assert.match(D.parseArgs(['deploy', '--repo']).error, /--repo needs a folder/);
  assert.match(D.parseArgs(['deploy', '--keep', '0']).error, /--keep needs a whole number/);
  assert.match(D.parseArgs(['rollback', 'x']).error, /unexpected argument/);
  assert.match(D.parseArgs(['frob']).error, /unknown dev command/);
  assert.match(D.parseArgs(['deploy', '--force']).error, /unknown option "--force"/);
});

test('deploy of a ref: built in a temporary worktree that is removed, installed as <version>-<sha>, current flipped, service kickstarted, setup run for the client, the game line printed', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('ref');
  const repo = makeRepo(root);
  const sha = git(repo, 'rev-parse', 'HEAD');
  const h = harness(root);
  const code = await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx);
  assert.equal(code, 0, h.err.join('\n'));
  const name = `0.5.0-${sha.slice(0, 12)}`;
  assert.equal(REL.currentName(h.l), name);
  assert.equal(fs.readFileSync(REL.currentBinary(h.l), 'utf8'), 'binary of one');
  assert.equal(REL.releaseInfo(h.l, name).source, REL.SOURCE_DEV_DEPLOY, 'release.json marks it a dev deploy');
  assert.equal(REL.isPublishedRelease(h.l, name), false, 'so self-update never treats it as a release');
  assert.equal(h.builds.length, 1);
  assert.ok(h.builds[0].startsWith(root) && !h.builds[0].startsWith(repo), 'built outside the checkout');
  assert.ok(!fs.existsSync(h.builds[0]), 'the temporary worktree is gone');
  assert.equal(worktrees(repo), 1, 'git no longer lists it');
  assert.deepEqual(h.events, [KICKSTART, [REL.currentBinary(h.l), 'setup', '--wow', h.client]]);
  assert.ok(h.out.includes('in game : 1. Fully quit and relaunch World of Warcraft (it only discovers new addon folders at launch).'), h.out.join('\n'));
  assert.ok(!fs.existsSync(h.l.lock), 'the lock is released');
  assert.deepEqual(fs.readdirSync(root).filter(f => f.startsWith('claude-wow-')), [], 'no temporary build or source folder is left');

  const again = harness(root, { probe: () => { throw new Error('the release is already current: no idle wait'); } });
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], again.ctx), 0, again.err.join('\n'));
  assert.equal(again.builds.length, 0, 'an already built release is not built again');
  assert.ok(again.out.includes(`current : ${name} is already current; nothing to switch, restart or set up`), again.out.join('\n'));
  assert.deepEqual(again.events, [], 'no idle wait, no restart, no setup');
});

test('rollback goes back to the release before the last deploy and kickstarts; a second deploy records the first as previous', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('rollback');
  const repo = makeRepo(root);
  const first = `0.5.0-${git(repo, 'rev-parse', 'HEAD').slice(0, 12)}`;
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], harness(root).ctx), 0);
  const second = `0.5.0-${commit(repo, 'two').slice(0, 12)}`;
  const h = harness(root);
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 0);
  assert.equal(REL.currentName(h.l), second);
  assert.equal(REL.previousName(h.l), first);
  assert.ok(h.out.some(l => l.includes(`previous ${first}`)));

  const r = harness(root);
  assert.equal(await D.main(['rollback'], r.ctx), 0, r.err.join('\n'));
  assert.equal(REL.currentName(r.l), first);
  assert.equal(fs.readFileSync(REL.currentBinary(r.l), 'utf8'), 'binary of one');
  assert.equal(REL.previousName(r.l), second);
  assert.deepEqual(r.events[0], KICKSTART);
  assert.ok(!fs.existsSync(r.l.lock));
  assert.equal(UPD.readSkip(r.l.base), null, 'rolling away from a dev deploy skips no release version');

  const s = harness(root, { probe: () => ({ idle: false, reason: '1 agent run(s) in flight (#2)' }) });
  assert.equal(await D.main(['status'], s.ctx), 0);
  const text = s.out.join('\n');
  assert.match(text, new RegExp(`current  : ${first}\\n`));
  assert.match(text, new RegExp(`previous : ${second}\\n`));
  assert.match(text, new RegExp(`release  : ${first}  \\(current\\)`));
  assert.match(text, /service  : runs .*current.claude-wow/);
  assert.match(text, /bridge   : busy \(1 agent run\(s\) in flight \(#2\)\)/);
});

test('rollback away from a published release writes the self-update skip for its version, so the daily check does not reinstall it', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('rollskip');
  const h = harness(root);
  const add = (name, version) => {
    const file = path.join(root, `bin-${name}`);
    fs.writeFileSync(file, `binary ${name}`);
    REL.installRelease(h.l, { name, binaryFile: file, meta: { source: REL.SOURCE_SELF_UPDATE, version } });
  };
  add('1.0.0', '1.0.0');
  add('2.0.0', '2.0.0');
  REL.activate(h.l, '1.0.0');
  REL.activate(h.l, '2.0.0');
  assert.equal(UPD.readSkip(h.l.base), null);
  UPD.writeRecord(h.l.base, { pendingRestart: true, version: '2.0.0', from: '1.0.0', attemptAt: 1, ok: true });
  assert.equal(await D.main(['rollback'], h.ctx), 0, h.err.join('\n'));
  assert.equal(UPD.readRecord(h.l.base).pendingRestart, false, 'the update restart that was waiting for 2.0.0 is called off');
  assert.match(UPD.readRecord(h.l.base).message, /dev rollback/);
  assert.equal(REL.currentName(h.l), '1.0.0');
  const skip = UPD.readSkip(h.l.base);
  assert.equal(skip && skip.version, '2.0.0');
  assert.match(skip.reason, /dev rollback from releases\/2\.0\.0/);
  assert.deepEqual(h.events[0], KICKSTART, 'the restart went through the fake service');
});

test('before the migration the service does not run current: the release is staged and current flipped, but nothing restarts and setup does not run', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('premigration');
  const repo = makeRepo(root);
  const h = harness(root, { runsCurrent: false, probe: () => ({ idle: false, reason: '1 agent run(s) in flight (#5)' }) });
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo, '--timeout', '5'], h.ctx), 0, h.err.join('\n'));
  assert.ok(REL.currentName(h.l));
  assert.deepEqual(h.events, [], 'no idle wait for a bridge that does not run current, no launchctl, no setup');
  assert.ok(h.out.some(l => /does not run .*current.*nothing was restarted and setup was not run/.test(l)), h.out.join('\n'));
  assert.ok(h.out.some(l => l.includes('MIGRATE-PROD-INSTALL.md')));
});

test('the idle wait: the flip waits while a run is in flight, proceeds once idle, and a timeout switches nothing', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('idle');
  const repo = makeRepo(root);
  let busy = 3;
  const h = harness(root, { probe: () => (busy-- > 0 ? { idle: false, reason: '1 agent run(s) in flight (#4)' } : { idle: true, reason: 'idle' }) });
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 0);
  const probes = h.events.filter(e => e[0] === 'probe');
  assert.deepEqual(probes.map(p => p[1]), [false, false, false, true, true]);
  assert.ok(probes.every(p => p[2] === ''), 'current did not move while waiting');
  assert.deepEqual(probes.map(p => p[3]), [REL.PREPARING, REL.PREPARING, REL.PREPARING, REL.PREPARING, REL.SWITCHING], 'probed again after the lock says switching');
  assert.deepEqual(h.events[probes.length], KICKSTART, 'the restart comes after the wait');
  assert.ok(h.out.includes('hold    : the bridge holds new messages until this deploy ends'));
  assert.ok(h.out.includes('waiting : 1 agent run(s) in flight (#4)'));

  const before = REL.currentName(h.l);
  commit(repo, 'three');
  const stuck = harness(root, { probe: () => ({ idle: false, reason: '1 message(s) waiting in the queue (#9)' }) });
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo, '--timeout', '5'], stuck.ctx), 1);
  assert.match(stuck.err.join('\n'), /did not go idle within 5 s \(1 message\(s\) waiting in the queue \(#9\)\)\. Nothing was switched/);
  assert.equal(REL.currentName(stuck.l), before, 'current is unchanged');
  assert.deepEqual(stuck.events.filter(e => e[0] !== 'probe'), [], 'no restart, no setup');
  assert.ok(!fs.existsSync(stuck.l.lock), 'the lock is released on failure');
  assert.equal(worktrees(repo), 1, 'the temporary worktree is removed on failure');
});

test('lock contention: a deploy while another holds the lock builds nothing and says who holds it; a dead holder\'s lock is taken over', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('contention');
  const repo = makeRepo(root);
  const h = harness(root);
  const other = REL.acquireLock(h.l.lock, { pid: process.pid, command: 'dev deploy' });
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 1);
  assert.match(h.err.join('\n'), new RegExp(`another deploy holds .*pid ${process.pid} \\(dev deploy\\)`));
  assert.equal(h.builds.length, 0);
  assert.equal(REL.currentName(h.l), '');
  assert.equal(worktrees(repo), 1);
  assert.equal(await D.main(['rollback'], h.ctx), 1, 'rollback takes the same lock');
  assert.ok(fs.existsSync(h.l.lock), 'the holder keeps its lock');
  other.release();

  fs.writeFileSync(h.l.lock, JSON.stringify({ pid: 2147483000, host: require('os').hostname(), started: 0 }));
  const after = harness(root);
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], after.ctx), 0, after.err.join('\n'));
  assert.ok(!fs.existsSync(after.l.lock));
});

test('deploy of a worktree folder builds it in place under a -dirty-<time> name when it has changes; linux restarts the systemd unit', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('worktree');
  const repo = makeRepo(root);
  const sha = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'marker.txt'), 'edited');
  const h = harness(root, { platform: 'linux' });
  fs.writeFileSync(h.ctx.definitionFile, S.systemdUnit({ node: REL.currentBinary(h.l), script: '', cwd: h.l.base }));
  assert.equal(await D.main(['deploy', repo], h.ctx), 0, h.err.join('\n'));
  assert.deepEqual(h.builds, [repo]);
  assert.match(REL.currentName(h.l), new RegExp(`^0\\.5\\.0-${sha.slice(0, 12)}-dirty-\\d{8}-\\d{6}Z$`));
  assert.equal(fs.readFileSync(REL.currentBinary(h.l), 'utf8'), 'binary of edited');
  assert.deepEqual(h.events[0], ['systemctl', '--user', 'restart', S.UNIT]);
  assert.ok(fs.existsSync(path.join(repo, 'marker.txt')), 'the worktree is left alone');
  assert.equal(worktrees(repo), 1);
});

test('a failed restart is an error that names how to restart, and setup is not run against a bridge that did not restart', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('restart-fails');
  const repo = makeRepo(root);
  const h = harness(root, { failRestart: true, loaded: false });
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 1);
  assert.match(h.err.join('\n'), /did not restart: launchctl could not start the service: Could not find service/);
  assert.deepEqual(h.events.map(e => e.slice(0, 2)), [['launchctl', 'bootstrap'], ['launchctl', 'load']], 'an agent that is not loaded is bootstrapped, never kickstarted');
});

test('a loaded agent whose kickstart -k fails: the deploy fails with the launchctl output and setup is not run', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('kickstart-fails');
  const repo = makeRepo(root);
  const h = harness(root, { failRestart: true, loaded: true });
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 1);
  assert.match(h.err.join('\n'), /did not restart: launchctl could not restart the service: Could not find service/);
  assert.match(h.err.join('\n'), /current points at 0\.5\.0-[0-9a-f]{12}; restart it with: claude-wow service restart/);
  assert.deepEqual(h.events, [KICKSTART], 'kickstart -k was tried once, no bootstrap, no setup');
  assert.ok(!fs.existsSync(h.l.lock));
});

test('a deploy or rollback whose lock was taken over while it waited switches nothing', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('lock-lost');
  const repo = makeRepo(root);
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], harness(root).ctx), 0);
  const first = REL.currentName(REL.layout(path.join(root, 'home')));
  commit(repo, 'two');
  let l;
  const stealUnderSwitching = () => {
    const lock = REL.readLock(l.lock);
    if (lock && lock.phase === REL.SWITCHING && lock.token !== 'thief') fs.writeFileSync(l.lock, JSON.stringify({ ...lock, pid: process.pid, token: 'thief' }));
    return { idle: true, reason: 'idle' };
  };
  const h = harness(root, { probe: stealUnderSwitching });
  l = h.l;
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 1);
  assert.match(h.err.join('\n'), /no longer held by this process .*nothing was switched/);
  assert.equal(REL.currentName(l), first, 'current did not move');
  assert.deepEqual(h.events.filter(e => e[0] !== 'probe'), [], 'no restart, no setup');
  assert.equal(REL.readLock(l.lock).token, 'thief', 'the other holder keeps its lock');
  fs.unlinkSync(l.lock);

  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], harness(root).ctx), 0);
  const second = REL.currentName(l);
  assert.notEqual(second, first);
  const r = harness(root, { probe: stealUnderSwitching });
  assert.equal(await D.main(['rollback'], r.ctx), 1);
  assert.match(r.err.join('\n'), /no longer held by this process/);
  assert.equal(REL.currentName(l), second, 'the rollback did not move current');
  assert.deepEqual(r.events.filter(e => e[0] !== 'probe'), []);
  fs.unlinkSync(l.lock);

  const quiet = harness(root, { runsCurrent: false });
  quiet.ctx.build = (src, outDir) => {
    fs.writeFileSync(l.lock, JSON.stringify({ ...REL.readLock(l.lock), token: 'thief' }));
    const file = path.join(outDir, 'claude-wow-darwin-arm64');
    fs.writeFileSync(file, 'three');
    return file;
  };
  commit(repo, 'three');
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], quiet.ctx), 1, 'no idle wait before the migration, and still no switch without the lock');
  assert.equal(REL.currentName(l), second);
  fs.unlinkSync(l.lock);
});

test('Ctrl+C or SIGTERM during a deploy removes the temporary worktree and build folder and releases the lock; during a rollback it releases the lock', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('signal');
  const repo = makeRepo(root);
  const h = harness(root);
  const exits = [];
  h.ctx.exit = code => {
    exits.push({ code, lock: fs.existsSync(h.l.lock), worktrees: worktrees(repo), temp: fs.readdirSync(root).filter(f => f.startsWith('claude-wow-')).length });
    throw new Error('exited');
  };
  h.ctx.build = (src) => {
    assert.ok(fs.existsSync(src), 'the temporary worktree is there during the build');
    assert.equal(worktrees(repo), 2);
    assert.ok(fs.existsSync(h.l.lock));
    h.ctx.signals.emit('SIGINT');
    throw new Error('the build was interrupted');
  };
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 1);
  assert.deepEqual(exits, [{ code: 130, lock: false, worktrees: 1, temp: 0 }], 'everything is cleaned up before the process exits');
  assert.match(h.err.join('\n'), /stopped by SIGINT; removed the temporary build folders and released the deploy lock/);
  assert.ok(!fs.existsSync(h.l.lock), 'the lock is released');
  assert.equal(worktrees(repo), 1, 'the temporary worktree is removed');
  assert.deepEqual(fs.readdirSync(root).filter(f => f.startsWith('claude-wow-')), [], 'no temporary build or source folder is left');
  assert.equal(h.ctx.signals.listenerCount('SIGINT') + h.ctx.signals.listenerCount('SIGTERM'), 0, 'the handlers go with the deploy');

  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], harness(root).ctx), 0);
  commit(repo, 'two');
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], harness(root).ctx), 0);
  const r = harness(root, { probe: () => { r.ctx.signals.emit('SIGTERM'); return { idle: true, reason: 'idle' }; } });
  const rollbackExits = [];
  r.ctx.exit = code => { rollbackExits.push({ code, lock: fs.existsSync(r.l.lock) }); throw new Error('exited'); };
  const before = REL.currentName(r.l);
  assert.equal(await D.main(['rollback'], r.ctx), 1);
  assert.deepEqual(rollbackExits, [{ code: 143, lock: false }]);
  assert.match(r.err.join('\n'), /stopped by SIGTERM; released the deploy lock; nothing was switched/);
  assert.doesNotMatch(r.err.join('\n'), /build folder/, 'a rollback builds nothing, so its message does not claim to remove build folders');
  assert.ok(!fs.existsSync(r.l.lock), 'the rollback lock is released');
  assert.equal(REL.currentName(r.l), before);
  assert.deepEqual(r.events.filter(e => e[0] !== 'probe'), [], 'no restart');
});

test('the signal handlers are in place before the lock is taken, so a Ctrl+C right after the lock is taken still releases it', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('signal-before-lock');
  const repo = makeRepo(root);
  for (const command of [['deploy', 'HEAD', '--repo', repo], ['rollback']]) {
    const h = harness(root);
    const listening = [];
    const now = h.ctx.now;
    h.ctx.now = () => {
      if (!listening.length && !fs.existsSync(h.l.lock)) listening.push(h.ctx.signals.listenerCount('SIGINT') + h.ctx.signals.listenerCount('SIGTERM'));
      return now();
    };
    await D.main(command, h.ctx);
    assert.equal(listening[0], 2, `${command[0]}: SIGINT and SIGTERM handlers exist while the lock is being taken`);
    assert.ok(!fs.existsSync(h.l.lock), `${command[0]}: the lock is released`);
  }
});

test('previous names the current release after a deploy died between its two writes: rollback refuses with the way out, status warns', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('previous-is-current');
  const repo = makeRepo(root);
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], harness(root).ctx), 0);
  commit(repo, 'two');
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], harness(root).ctx), 0);
  const h = harness(root);
  const current = REL.currentName(h.l);
  fs.writeFileSync(h.l.previous, `${current}\n`);
  assert.equal(await D.main(['rollback'], h.ctx), 1);
  assert.match(h.err.join('\n'), new RegExp(`names ${current.replace(/\./g, '\\.')}, the current release, so there is nothing to roll back to.*To finish that deploy, run it again`));
  assert.deepEqual(h.events, [], 'no idle wait, no restart');
  assert.ok(!fs.existsSync(h.l.lock));
  const s = harness(root);
  assert.equal(await D.main(['status'], s.ctx), 0);
  assert.ok(s.out.some(line => /^warning  : .*nothing to roll back to/.test(line)), s.out.join('\n'));
  assert.equal(REL.currentName(h.l), current);
});

test('the restart goes through the service backend: a loaded agent is kickstarted, an unloaded one (after service stop) is bootstrapped', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('restart-backend');
  const repo = makeRepo(root);
  const h = harness(root, { loaded: false });
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 0, h.err.join('\n'));
  assert.deepEqual(h.events[0], ['launchctl', 'bootstrap', `gui/${UID}`, h.ctx.definitionFile]);
  assert.ok(!h.events.some(e => e[1] === 'kickstart'), 'kickstart of an unloaded agent fails, so it is not tried');
  assert.equal(h.events[1][1], 'setup');
});

test('a message that slipped in before the switching mark is waited for: the flip comes only after a second idle read under the mark', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('slipped');
  const repo = makeRepo(root);
  let slipped = 2;
  let l;
  const h = harness(root, { probe: () => ((REL.readLock(l.lock) || {}).phase === REL.SWITCHING && slipped-- > 0 ? { idle: false, reason: '1 agent run(s) in flight (#8)' } : { idle: true, reason: 'idle' }) });
  l = h.l;
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 0, h.err.join('\n'));
  const probes = h.events.filter(e => e[0] === 'probe');
  assert.deepEqual(probes.map(p => [p[1], p[3]]), [[true, REL.PREPARING], [false, REL.SWITCHING], [false, REL.SWITCHING], [true, REL.SWITCHING]]);
  assert.ok(probes.every(p => p[2] === ''), 'current did not move until the second idle read');
  assert.deepEqual(h.events[probes.length], KICKSTART);
});

test('--timeout must be above 0 and below the lock\'s maximum age', () => {
  assert.match(D.parseArgs(['deploy', '--timeout', '0']).error, /above 0/);
  assert.match(D.parseArgs(['deploy', '--timeout', '-3']).error, /above 0/);
  assert.match(D.parseArgs(['rollback', '--timeout', String(REL.LOCK_MAX_AGE_MS / 1000)]).error, /at most/);
  assert.equal(D.parseArgs(['rollback', '--timeout', '7200']).timeoutMs, 7200 * 1000);
});

test('a folder is built only when it is written as a path; a bare name is a ref even when a folder of that name exists', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('pathform');
  const repo = makeRepo(root);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const h = harness(root);
    assert.equal(await D.main(['deploy', 'repo', '--repo', repo], h.ctx), 1);
    assert.match(h.err.join('\n'), /"repo" is not a commit .*\(to build the folder, write it as \.\/repo\)/);
    assert.equal(h.builds.length, 0);
    const p = harness(root);
    assert.equal(await D.main(['deploy', './repo'], p.ctx), 0, p.err.join('\n'));
    assert.deepEqual(p.builds, [path.resolve(repo)]);
    const missing = harness(root);
    assert.equal(await D.main(['deploy', './no-such-folder'], missing.ctx), 1);
    assert.match(missing.err.join('\n'), /no-such-folder is not a folder/);
  } finally {
    process.chdir(cwd);
  }
});

test('a prune failure after the switch is reported, never thrown: the deploy still succeeds', { skip: NO_SYMLINKS || process.getuid() === 0 }, async () => {
  const root = scratch('prune-fails');
  const repo = makeRepo(root);
  const at = ms => { const x = harness(root); x.ctx.now = () => ms; return x.ctx; };
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], at(1000)), 0);
  commit(repo, 'two');
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], at(2000)), 0);
  commit(repo, 'three');
  const h = harness(root);
  h.ctx.now = () => 3000;
  const realRun = h.ctx.run;
  h.ctx.run = (cmd, args, opts) => {
    const r = realRun(cmd, args, opts);
    if (cmd === REL.currentBinary(h.l)) fs.chmodSync(h.l.releases, 0o555);
    return r;
  };
  try {
    assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo, '--keep', '1'], h.ctx), 0, h.err.join('\n'));
  } finally {
    fs.chmodSync(h.l.releases, 0o755);
  }
  assert.match(h.err.join('\n'), /old releases were not pruned \(.*\); the deploy itself is done/);
  assert.deepEqual(h.events.map(e => e[1]), ['kickstart', 'setup'], 'the restart and setup ran before the prune');
});

test('helpers: the configured client from addonDir, the game lines from setup output, the release name, bad refs and Windows', async () => {
  const dir = scratch('helpers');
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ addonDir: path.join('/W', '_classic_era_', 'Interface', 'AddOns') }));
  assert.deepEqual(D.configuredClients(cfg), [path.join('/W', '_classic_era_')]);
  fs.writeFileSync(cfg, JSON.stringify({ addonDir: '/somewhere/else' }));
  assert.deepEqual(D.configuredClients(cfg), []);
  assert.deepEqual(D.configuredClients(path.join(dir, 'missing.json')), []);
  assert.deepEqual(D.gameLines('a\nwarning  : the signal files moved: fully quit and relaunch WoW once\nx\n  1. /reload is enough\n  1. /reload is enough'), [
    'warning  : the signal files moved: fully quit and relaunch WoW once', '1. /reload is enough',
  ]);
  assert.equal(D.releaseNameFor('0.5.0-beta.1', 'abcdef0123456789', false, 0), '0.5.0-beta.1-abcdef012345');
  assert.ok(REL.validName(D.releaseNameFor('0.5.0', 'abcdef0123456789', true, Date.UTC(2026, 9, 2, 13, 4, 5))));
  assert.equal(D.releaseNameFor('0.5.0', 'abcdef0123456789', true, Date.UTC(2026, 9, 2, 13, 4, 5)), '0.5.0-abcdef012345-dirty-20261002-130405Z');
  const repo = makeRepo(dir);
  const h = harness(dir);
  assert.equal(await D.main(['deploy', 'no-such-ref', '--repo', repo], h.ctx), 1);
  assert.match(h.err.join('\n'), /"no-such-ref" is not a commit/);
  const w = harness(dir, { platform: 'win32' });
  assert.equal(await D.main(['deploy'], w.ctx), 2);
  assert.match(w.err.join('\n'), /macOS and Linux only/);
});
