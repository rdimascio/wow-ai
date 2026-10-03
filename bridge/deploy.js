'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./home');
const R = require('./runtime');
const REL = require('./releases');
const I = require('./idle');
const SVC = require('./service');
const UPD = require('./selfupdate');

const DEFAULT_REF = 'origin/main';
const SUPPORTED_PLATFORMS = ['darwin', 'linux'];
const OUTPUT_TAIL_LINES = 30;
const GAME_LINE = /\/reload|relaunch|restart/i;
const LOCK_AGE_LEFT_FOR_BUILD_AND_SETUP_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = REL.LOCK_MAX_AGE_MS - LOCK_AGE_LEFT_FOR_BUILD_AND_SETUP_MS;
const PATH_FORM = /^\.\.?([\\/]|$)/;

const HELP = `claude-wow dev <command>

  deploy [ref|worktree]   Build this bridge with bun build.js --host and make it the running release.
                          ref: a git ref in the checkout (default ${DEFAULT_REF}; run git fetch first),
                          built in a temporary git worktree that is removed afterwards.
                          worktree: a folder that holds a checkout, written as a path (/abs, ./rel or
                          ../rel), built as it is (a dirty tree gets a -dirty-<time> release name).
    --repo <checkout>     the checkout a ref is read from (default: this checkout)
    --timeout <seconds>   how long to wait for the bridge to go idle (default ${I.DEFAULT_TIMEOUT_MS / 1000}, at most ${MAX_TIMEOUT_MS / 1000})
    --keep <n>            how many releases to keep (default ${REL.KEEP_RELEASES}; the current and the previous are always kept)
  rollback                Point current back at the previous release and restart the service.
    --timeout <seconds>
  status                  The current and previous release, the releases on disk, and what the service runs.

Releases live in <home>/releases/<version>-<sha>/claude-wow and <home>/current points at one
(<home> is ~/.claude-wow, or CLAUDE_WOW_HOME). One deploy or rollback at a time (<home>/deploy.lock,
for this machine only). The idle wait, the restart (claude-wow service restart) and setup for the
configured client run only when the service runs <home>/current/claude-wow and the release changes.
See docs/MIGRATE-PROD-INSTALL.md.`;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd: cmd || 'help', target: '', repo: '', timeoutMs: I.DEFAULT_TIMEOUT_MS, keep: REL.KEEP_RELEASES };
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return { ...opts, cmd: 'help' };
  if (!['deploy', 'rollback', 'status'].includes(cmd)) return { ...opts, cmd: 'help', error: `unknown dev command "${cmd}"` };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--repo') {
      const dir = rest[++i];
      if (!dir || dir.startsWith('-')) return { ...opts, error: '--repo needs a folder' };
      opts.repo = dir;
    } else if (a === '--timeout') {
      const s = Number(rest[++i]);
      if (!Number.isFinite(s) || s <= 0 || s * 1000 > MAX_TIMEOUT_MS) return { ...opts, error: `--timeout needs a number of seconds above 0 and at most ${MAX_TIMEOUT_MS / 1000}, not "${rest[i]}"` };
      opts.timeoutMs = s * 1000;
    } else if (a === '--keep') {
      const n = Number(rest[++i]);
      if (!Number.isInteger(n) || n < 1) return { ...opts, error: `--keep needs a whole number of at least 1, not "${rest[i]}"` };
      opts.keep = n;
    } else if (a.startsWith('-')) return { ...opts, error: `unknown option "${a}"` };
    else if (cmd === 'deploy' && !opts.target) opts.target = a;
    else return { ...opts, error: `unexpected argument "${a}"` };
  }
  return opts;
}

function runCommand(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: !r.error && r.status === 0, status: r.status, out: (r.stdout || '') + (r.stderr || ''), error: r.error };
}

function tail(text, n = OUTPUT_TAIL_LINES) {
  return String(text || '').trim().split(/\r?\n/).slice(-n).join('\n');
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function bunPath(env = process.env, home = os.homedir()) {
  if (env.BUN) return env.BUN;
  const local = path.join(home, '.bun', 'bin', 'bun');
  try { if (fs.statSync(local).isFile()) return local; } catch {}
  return 'bun';
}

function bunBuild(srcDir, outDir, run) {
  const bun = bunPath();
  const r = run(bun, [path.join(srcDir, 'build.js'), '--host', '--out', outDir], { cwd: srcDir, env: { ...process.env, BUN: bun } });
  if (!r.ok) throw new Error(`bun build.js --host failed in ${srcDir}${r.error ? ` (${r.error.message})` : ''}:\n${tail(r.out)}`);
  const built = fs.readdirSync(outDir).filter(f => f.startsWith('claude-wow-'));
  if (built.length !== 1) throw new Error(`bun build.js --host left ${built.length} binaries in ${outDir}, expected 1`);
  return path.join(outDir, built[0]);
}

function git(run, dir, args) {
  const r = run('git', ['-C', dir, ...args]);
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${tail(r.out, 5) || (r.error && r.error.message) || 'status ' + r.status}`);
  return r.out.trim();
}

function packageVersion(dir) {
  try { return String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '0.0.0'); } catch { return '0.0.0'; }
}

function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
}

function releaseNameFor(version, sha, dirty, nowMs) {
  return `${version}-${sha.slice(0, 12)}${dirty ? `-dirty-${stamp(nowMs)}` : ''}`;
}

function isPathForm(target) {
  return path.isAbsolute(target) || PATH_FORM.test(target);
}

function resolveSource(target, ctx) {
  const run = ctx.run;
  if (target && isPathForm(target)) {
    if (!isDir(target)) throw new Error(`${target} is not a folder`);
    const dir = path.resolve(target);
    const sha = git(run, dir, ['rev-parse', 'HEAD']);
    const dirty = git(run, dir, ['status', '--porcelain']) !== '';
    const version = packageVersion(dir);
    return { dir, sha, dirty, version, from: `worktree ${dir}`, name: releaseNameFor(version, sha, dirty, ctx.now()), cleanup: () => {} };
  }
  const ref = target || DEFAULT_REF;
  if (ref.startsWith('-')) throw new Error(`"${ref}" is not a ref`);
  const repo = ctx.repo || (R.compiled ? '' : R.ROOT);
  if (!repo) throw new Error('the binary has no checkout of its own: pass --repo <checkout>, or a worktree folder');
  const found = run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!found.ok) throw new Error(`"${ref}" is not a commit in ${repo}${ref === DEFAULT_REF ? ' (run git fetch origin first)' : ''}${isDir(ref) ? ` (to build the folder, write it as ./${ref})` : ''}`);
  const sha = found.out.trim();
  const tmp = fs.mkdtempSync(path.join(ctx.tmpRoot || os.tmpdir(), 'claude-wow-deploy-'));
  const dir = path.join(tmp, 'src');
  const cleanup = () => {
    run('git', ['-C', repo, 'worktree', 'remove', '--force', dir]);
    fs.rmSync(tmp, { recursive: true, force: true });
    run('git', ['-C', repo, 'worktree', 'prune']);
  };
  try {
    git(run, repo, ['worktree', 'add', '--detach', dir, sha]);
  } catch (e) {
    cleanup();
    throw e;
  }
  const version = packageVersion(dir);
  return { dir, sha, dirty: false, version, from: `${ref} in ${repo}`, name: releaseNameFor(version, sha, false, ctx.now()), cleanup };
}

function serviceDefinition(ctx) {
  return ctx.definitionFile || SVC.dirs(ctx.platform).definition;
}

function serviceRunsCurrent(l, ctx) {
  let text;
  try { text = fs.readFileSync(serviceDefinition(ctx), 'utf8'); } catch { return false; }
  const bin = REL.currentBinary(l);
  return text.includes(SVC.xmlEscape(bin)) || text.includes(`"${bin}"`);
}

function restartService(ctx) {
  const service = ctx.service || SVC.backend(ctx.platform);
  const dirs = { ...SVC.dirs(ctx.platform), definition: serviceDefinition(ctx) };
  try {
    service.restart(dirs);
    return { ok: true, status: 0, out: '' };
  } catch (e) {
    return { ok: false, status: 1, out: e && e.message ? e.message : String(e) };
  }
}

function configuredClients(configFile) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return []; }
  const addonDir = typeof cfg.addonDir === 'string' ? cfg.addonDir : '';
  if (!addonDir) return [];
  const interfaceDir = path.dirname(addonDir);
  if (path.basename(addonDir).toLowerCase() !== 'addons' || path.basename(interfaceDir).toLowerCase() !== 'interface') return [];
  return [path.dirname(interfaceDir)];
}

function gameLines(output) {
  const seen = new Set();
  const lines = [];
  for (const raw of String(output || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !GAME_LINE.test(line) || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

function runSetup(l, ctx) {
  const clients = configuredClients(l.config);
  if (!clients.length) {
    ctx.out(`setup   : no client in ${l.config} (addonDir); run: ${REL.currentBinary(l)} setup --wow "<client folder>"`);
    return true;
  }
  let ok = true;
  const game = [];
  for (const client of clients) {
    ctx.out(`setup   : ${client}`);
    const r = ctx.run(REL.currentBinary(l), ['setup', '--wow', client]);
    if (r.out.trim()) ctx.out(r.out.replace(/\s+$/, ''));
    if (!r.ok) { ok = false; ctx.err(`claude-wow dev: setup failed for ${client}; the release is switched, fix what setup said and run: ${REL.currentBinary(l)} setup --wow "${client}"`); }
    game.push(...gameLines(r.out));
  }
  for (const line of game) ctx.out(`in game : ${line}`);
  return ok;
}

function afterSwitch(l, ctx, flip) {
  if (!flip.changed) ctx.out(`current : ${flip.name} was already current`);
  else ctx.out(`current : ${flip.name}${flip.previous ? ` (previous ${flip.previous}; claude-wow dev rollback goes back)` : ''}`);
  if (!serviceRunsCurrent(l, ctx)) {
    ctx.out(`service : ${serviceDefinition(ctx)} does not run ${REL.currentBinary(l)}, so nothing was restarted and setup was not run.`);
    ctx.out('          To run the service from this release, follow docs/MIGRATE-PROD-INSTALL.md.');
    return 0;
  }
  const r = restartService(ctx);
  if (!r.ok) {
    ctx.err(`claude-wow dev: the service did not restart: ${tail(r.out, 5) || (r.error && r.error.message) || 'status ' + r.status}`);
    ctx.err(`claude-wow dev: current points at ${flip.name}; restart it with: claude-wow service restart`);
    return 1;
  }
  ctx.out(`service : restarted on ${flip.name}`);
  return runSetup(l, ctx) ? 0 : 1;
}

function idleProbe(l, ctx) {
  return ctx.probe || I.probeFor({ stateFile: l.state, bridgeLockFile: l.bridgeLock, readPid: () => SVC.readPid(SVC.dirs(ctx.platform)), alive: REL.pidAlive });
}

function waitIdle(l, ctx, timeoutMs) {
  return I.waitForIdle({
    probe: idleProbe(l, ctx), timeoutMs, now: ctx.now, sleep: ctx.sleep, pollMs: ctx.pollMs, settleMs: ctx.settleMs,
    onWait: s => ctx.out(`waiting : ${s.reason}`),
  });
}

function switchWaiter(l, ctx, lock, timeoutMs) {
  return async () => {
    const first = await waitIdle(l, ctx, timeoutMs);
    lock.setPhase(REL.SWITCHING);
    ctx.out('hold    : the bridge holds new messages until this deploy ends');
    const settleMs = ctx.settleMs === undefined ? I.DEFAULT_SETTLE_MS : ctx.settleMs;
    const pollMs = ctx.pollMs === undefined ? I.DEFAULT_POLL_MS : ctx.pollMs;
    await waitIdle(l, ctx, Math.max(timeoutMs - first.waitedMs, settleMs + pollMs));
  };
}

function lockFor(l, ctx, command) {
  return REL.acquireLock(l.lock, { command, alive: ctx.alive || REL.pidAlive, now: ctx.now, pid: ctx.pid || process.pid });
}

function reportPrune(ctx, result) {
  if (result.pruned.length) ctx.out(`pruned  : ${result.pruned.join(', ')}`);
  if (result.prunedStaging.length) ctx.out(`pruned  : unfinished ${result.prunedStaging.join(', ')}`);
  if (result.pruneError) ctx.err(`claude-wow dev: old releases were not pruned (${result.pruneError}); the deploy itself is done`);
}

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

function cleanupOnce(steps) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const step of steps) {
      try { step(); } catch {}
    }
  };
}

function cleanupOnSignal(ctx, cleanup, whatCleanupDid) {
  const signals = ctx.signals || process;
  const exit = ctx.exit || (code => process.exit(code));
  const handlers = Object.keys(SIGNAL_EXIT_CODES).map(sig => [sig, () => {
    cleanup();
    ctx.err(`claude-wow dev: stopped by ${sig}; ${whatCleanupDid}`);
    exit(SIGNAL_EXIT_CODES[sig]);
  }]);
  for (const [sig, handler] of handlers) signals.on(sig, handler);
  return () => { for (const [sig, handler] of handlers) signals.removeListener(sig, handler); };
}

async function deploy(opts, ctx) {
  const l = REL.layout(ctx.base);
  let lock = null;
  let source = null;
  let outDir = '';
  const cleanup = cleanupOnce([
    () => { if (outDir) fs.rmSync(outDir, { recursive: true, force: true }); },
    () => { if (source) source.cleanup(); },
    () => { if (lock) lock.release(); },
  ]);
  const stopListening = cleanupOnSignal(ctx, cleanup, 'removed the temporary build folders and released the deploy lock');
  try {
    lock = lockFor(l, ctx, 'dev deploy');
    source = resolveSource(opts.target, { ...ctx, repo: opts.repo });
    ctx.out(`source  : ${source.from} at ${source.sha.slice(0, 12)}${source.dirty ? ' (uncommitted changes)' : ''}`);
    if (REL.currentName(l) === source.name && REL.hasRelease(l, source.name)) {
      ctx.out(`current : ${source.name} is already current; nothing to switch, restart or set up`);
      return 0;
    }
    let binaryFile = '';
    if (REL.hasRelease(l, source.name)) {
      ctx.out(`release : ${source.name} is already built`);
    } else {
      outDir = fs.mkdtempSync(path.join(ctx.tmpRoot || os.tmpdir(), 'claude-wow-build-'));
      ctx.out(`build   : bun build.js --host in ${source.dir}`);
      binaryFile = ctx.build(source.dir, outDir);
    }
    const meta = { source: REL.SOURCE_DEV_DEPLOY, sha: source.sha, version: source.version, from: source.from, dirty: source.dirty };
    const waiter = serviceRunsCurrent(l, ctx) ? switchWaiter(l, ctx, lock, opts.timeoutMs) : null;
    const result = await REL.installAndActivate(l, { name: source.name, binaryFile, meta, keep: opts.keep, now: ctx.now, alive: ctx.alive }, {
      waitIdle: async () => {
        if (waiter) await waiter();
        lock.assertHeld();
      },
      afterFlip: flip => {
        ctx.out(`release : ${REL.releaseDir(l, flip.name)}${binaryFile ? ' (new)' : ''}`);
        return afterSwitch(l, ctx, flip);
      },
    });
    reportPrune(ctx, result);
    return result.outcome;
  } finally {
    stopListening();
    cleanup();
  }
}

async function rollback(opts, ctx) {
  const l = REL.layout(ctx.base);
  let lock = null;
  const cleanup = cleanupOnce([() => { if (lock) lock.release(); }]);
  const stopListening = cleanupOnSignal(ctx, cleanup, 'released the deploy lock; nothing was switched');
  try {
    lock = lockFor(l, ctx, 'dev rollback');
    const prev = REL.previousName(l);
    if (!prev) throw new Error(`no previous release is recorded in ${l.previous}`);
    if (!REL.hasRelease(l, prev)) throw new Error(`the previous release ${prev} is gone from ${l.releases}`);
    if (REL.currentName(l) === prev) throw new Error(REL.previousIsCurrentMessage(l, prev));
    if (serviceRunsCurrent(l, ctx)) await switchWaiter(l, ctx, lock, opts.timeoutMs)();
    lock.assertHeld();
    const flip = REL.rollback(l);
    if (flip.previous) UPD.skipRelease(l, flip.previous, `dev rollback from releases/${flip.previous}`);
    UPD.clearPendingRestart(l.base, `dev rollback to releases/${flip.name}`);
    return afterSwitch(l, ctx, flip);
  } finally {
    stopListening();
    cleanup();
  }
}

function status(ctx) {
  const l = REL.layout(ctx.base);
  const current = REL.currentName(l);
  ctx.out(`home     : ${l.base}`);
  ctx.out(`current  : ${current || 'none'}`);
  const previous = REL.previousName(l);
  ctx.out(`previous : ${previous || 'none'}`);
  if (previous && previous === current) ctx.out(`warning  : ${REL.previousIsCurrentMessage(l, previous)}`);
  for (const r of REL.listReleases(l)) ctx.out(`release  : ${r.name}${r.name === current ? '  (current)' : ''}`);
  ctx.out(`service  : ${serviceRunsCurrent(l, ctx) ? 'runs ' + REL.currentBinary(l) : `${serviceDefinition(ctx)} does not run ${REL.currentBinary(l)}`}`);
  const s = idleProbe(l, ctx)();
  ctx.out(`bridge   : ${s.idle ? 'idle' : 'busy'} (${s.reason})`);
  return 0;
}

function defaultContext(overrides = {}) {
  const run = overrides.run || runCommand;
  return {
    base: H.resolve().dir,
    platform: process.platform,
    run,
    build: (src, out) => bunBuild(src, out, run),
    now: Date.now,
    out: line => console.log(line),
    err: line => console.error(line),
    ...overrides,
  };
}

async function main(argv, overrides = {}) {
  const ctx = defaultContext(overrides);
  const opts = parseArgs(argv);
  if (opts.error) { ctx.err(`claude-wow dev: ${opts.error}\n`); ctx.out(HELP); return 2; }
  if (opts.cmd === 'help') { ctx.out(HELP); return 0; }
  if (!SUPPORTED_PLATFORMS.includes(ctx.platform)) { ctx.err(`claude-wow dev: ${opts.cmd} runs on macOS and Linux only`); return 2; }
  try {
    if (opts.cmd === 'status') return status(ctx);
    if (opts.cmd === 'rollback') return await rollback(opts, ctx);
    return await deploy(opts, ctx);
  } catch (e) {
    ctx.err(`claude-wow dev ${opts.cmd}: ${e.message}`);
    return 1;
  }
}

module.exports = {
  DEFAULT_REF, HELP, parseArgs, runCommand, bunPath, bunBuild, releaseNameFor, resolveSource,
  serviceRunsCurrent, restartService, configuredClients, gameLines, deploy, rollback, status, main,
};
