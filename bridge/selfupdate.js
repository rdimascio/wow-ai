'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const R = require('./runtime');
const H = require('./home');
const B = require('../build');
const REL = require('./releases');

const DEFAULT_API = 'https://api.github.com/repos/rdimascio/wow-ai';
const RECORD_FILE = 'update.json';
const SUMS_ASSET = 'SHA256SUMS';
const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const CHECK_TICK_MS = 10 * MINUTE_MS;
const FIRST_CHECK_DELAY_MS = 2 * MINUTE_MS;
const RESTART_TICK_MS = 5000;
const DEFAULT_IDLE_SECONDS = 600;
const MIN_QUIET_MS = 30000;
const UPDATE_EXIT_CODE = 75;
const MAX_REDIRECTS = 5;
const PROBE_TIMEOUT_MS = 30000;
const LIMITS = {
  json: { maxBytes: 1024 * 1024, timeoutMs: 30000, idleMs: 15000 },
  sums: { maxBytes: 64 * 1024, timeoutMs: 30000, idleMs: 15000 },
  asset: { maxBytes: 400 * 1024 * 1024, timeoutMs: 15 * MINUTE_MS, idleMs: 60000 },
};
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HOMEBREW_PATH = /\/Cellar\/|\/opt\/homebrew\/|\/\.linuxbrew\//;
const PROJECT_NAMES = ['claude-wow', 'wow-ai'];
const SKIP_FILE = 'update-skip.json';
const STALE_DOWNLOAD_MS = 6 * HOUR_MS;
const DOWNLOAD_NAME = /^\..+\.update-(\d+)-[0-9a-f]{8}(\.exe)?$/;
const SUM_LINE =/^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/;

function ownVersion() {
  try { return require('../package.json').version; } catch { return '0.0.0'; }
}

function apiBase(env = process.env) {
  return String(env.CLAUDE_WOW_UPDATE_API || DEFAULT_API).replace(/\/+$/, '');
}

function parseSemver(v) {
  const m = SEMVER.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

function normalizeVersion(v) {
  const parsed = parseSemver(v);
  if (!parsed) return '';
  return `${parsed.core.join('.')}${parsed.pre.length ? '-' + parsed.pre.join('.') : ''}`;
}

function compareIdentifiers(a, b) {
  const numA = /^\d+$/.test(a), numB = /^\d+$/.test(b);
  if (numA && numB) return Math.sign(Number(a) - Number(b));
  if (numA) return -1;
  if (numB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSemver(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const c = compareIdentifiers(x.pre[i], y.pre[i]);
    if (c) return c;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

function assetName(platform = process.platform, arch = process.arch) {
  const osName = platform === 'win32' ? 'windows' : platform;
  const target = `bun-${osName}-${arch}`;
  return B.TARGETS.includes(target) ? B.outName(target) : '';
}

function realpathOf(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function isThisProject(dir) {
  if (fs.existsSync(path.join(dir, 'bridge', 'supervisor.js'))) return true;
  try { return PROJECT_NAMES.includes(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name); } catch { return false; }
}

function gitCheckoutAbove(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return isThisProject(dir) ? dir : '';
    const up = path.dirname(dir);
    if (up === dir) return '';
    dir = up;
  }
}

function releasesLayout(real) {
  const releasesDir = path.dirname(path.dirname(real));
  if (path.basename(releasesDir) !== REL.RELEASES_DIR) return null;
  const layout = REL.layout(path.dirname(releasesDir));
  if (!REL.isInsideReleases(layout, real)) return null;
  try { if (!fs.lstatSync(layout.current).isSymbolicLink()) return null; } catch { return null; }
  return { layout, release: path.basename(path.dirname(real)), currentRelease: REL.currentName(layout) };
}

function unpublishedRelease(found) {
  return [found.release, found.currentRelease].find(name => name && !REL.isPublishedRelease(found.layout, name)) || '';
}

function installKind({ compiled = R.compiled, execPath = process.execPath } = {}) {
  if (!compiled) return { kind: 'dev', why: 'running from source (node or bun and a checkout); update it with git pull or the installer' };
  const real = realpathOf(execPath);
  if (HOMEBREW_PATH.test(real.split(path.sep).join('/'))) return { kind: 'homebrew', binary: real, why: 'Homebrew installed this binary; update it with: brew upgrade claude-wow' };
  const repo = gitCheckoutAbove(real);
  if (repo) return { kind: 'dev', binary: real, why: `the binary is inside the git checkout ${repo}; rebuild it there` };
  const found = releasesLayout(real);
  if (!found) return { kind: 'binary', binary: real };
  const devName = unpublishedRelease(found);
  if (devName) return { kind: 'dev', binary: real, why: `releases/${devName} is not a published release (its ${REL.RELEASE_INFO} has no source "${REL.SOURCE_RELEASE}" or "${REL.SOURCE_SELF_UPDATE}"); claude-wow dev deploy updates it` };
  return { kind: 'releases', binary: real, ...found };
}

function launchPath({ compiled = R.compiled, execPath = process.execPath } = {}) {
  if (!compiled) return execPath;
  const found = releasesLayout(realpathOf(execPath));
  return found ? REL.currentBinary(found.layout) : execPath;
}

function httpError(status, url) {
  const where = `${url.host}${url.pathname}`;
  if (status === 404) return new Error(`not found (404): ${where}`);
  if (status === 403 || status === 429) return new Error(`refused (${status}, probably the GitHub rate limit): ${where}`);
  return new Error(`HTTP ${status} from ${where}`);
}

function get(url, opts = {}) {
  const { maxBytes, idleMs, headers = {}, onData, redirects = MAX_REDIRECTS, userAgent = `claude-wow/${ownVersion()}` } = opts;
  const until = opts.until || Date.now() + opts.timeoutMs;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error(`bad URL: ${url}`)); return; }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) { reject(new Error(`unsupported URL: ${url}`)); return; }
    let settled = false;
    let req = null;
    const deadline = setTimeout(() => done(new Error(`timed out: ${u.host}`)), Math.max(0, until - Date.now()));
    function done(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) { if (req) req.destroy(); reject(err); } else resolve(value);
    }
    req = mod.get(u, { headers: { 'User-Agent': userAgent, ...headers } }, res => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) { done(new Error(`too many redirects from ${u.host}`)); return; }
        let next;
        try { next = new URL(res.headers.location, u); } catch { done(new Error(`bad redirect from ${u.host}`)); return; }
        if (u.protocol === 'https:' && next.protocol !== 'https:') { done(new Error(`refused a redirect from https to ${next.protocol} (${next.host})`)); return; }
        settled = true;
        clearTimeout(deadline);
        req.destroy();
        get(next.href, { ...opts, until, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) { res.resume(); done(httpError(status, u)); return; }
      const length = Number(res.headers['content-length']);
      if (Number.isFinite(length) && length > maxBytes) { res.resume(); done(new Error(`${u.pathname} is ${length} bytes, more than the ${maxBytes} allowed`)); return; }
      let got = 0;
      const chunks = [];
      res.on('data', chunk => {
        if (settled) return;
        got += chunk.length;
        if (got > maxBytes) { done(new Error(`${u.pathname} passed the ${maxBytes} bytes allowed`)); return; }
        try { if (onData) onData(chunk); else chunks.push(chunk); } catch (e) { done(e); }
      });
      res.on('end', () => {
        if (!res.complete) { done(new Error(`the connection to ${u.host} closed early`)); return; }
        done(null, onData ? { bytes: got } : Buffer.concat(chunks));
      });
      res.on('error', e => done(e));
      res.on('close', () => { if (!res.complete) done(new Error(`the connection to ${u.host} closed early`)); });
    });
    req.setTimeout(idleMs, () => done(new Error(`no data for ${Math.round(idleMs / 1000)} s from ${u.host}`)));
    req.on('error', e => done(e));
  });
}

async function latestRelease(api, limits = LIMITS) {
  let body;
  try {
    body = await get(`${api}/releases/latest`, { ...limits.json, headers: { Accept: 'application/vnd.github+json' } });
  } catch (e) {
    if (/\(404\)/.test(e.message)) throw new Error(`no release is published yet (${e.message})`);
    throw e;
  }
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch { throw new Error('the release answer is not JSON'); }
  const version = normalizeVersion(data && data.tag_name);
  if (!version) throw new Error(`the latest release tag "${String(data && data.tag_name).slice(0, 40)}" is not a version`);
  const assets = (Array.isArray(data.assets) ? data.assets : [])
    .filter(a => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
    .map(a => ({ name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 }));
  return { tag: String(data.tag_name), version, assets };
}

function parseSums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = SUM_LINE.exec(line);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

function rmQuiet(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

async function downloadTo(url, file, limits) {
  const fd = fs.openSync(file, 'w', 0o600);
  const hash = crypto.createHash('sha256');
  let ok = false;
  try {
    await get(url, { ...limits, headers: { Accept: 'application/octet-stream' }, onData: chunk => { hash.update(chunk); fs.writeSync(fd, chunk); } });
    fs.fsyncSync(fd);
    ok = true;
  } finally {
    fs.closeSync(fd);
    if (!ok) rmQuiet(file);
  }
  return hash.digest('hex');
}

function probeBinary(file) {
  return new Promise(resolve => {
    execFile(file, ['--version'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) { resolve({ ok: false, why: err.message.split('\n')[0] }); return; }
      const m = /claude-wow (\S+)/.exec(String(stdout || ''));
      resolve(m ? { ok: true, version: m[1] } : { ok: false, why: 'it printed no version' });
    });
  });
}

function tempPath(dir, name, platform) {
  return path.join(dir, `.${name}.update-${process.pid}-${crypto.randomBytes(4).toString('hex')}${platform === 'win32' ? '.exe' : ''}`);
}

function replaceFile(tmp, target, platform = process.platform) {
  if (platform !== 'win32') { fs.renameSync(tmp, target); return; }
  let aside = `${target}.old`;
  try { fs.rmSync(aside, { force: true }); } catch { aside = `${target}.old-${Date.now()}`; }
  fs.renameSync(target, aside);
  try { fs.renameSync(tmp, target); } catch (e) {
    try { fs.renameSync(aside, target); } catch {}
    throw e;
  }
}

function releaseVersion(l, name) {
  const info = REL.releaseInfo(l, name);
  return normalizeVersion(info && info.version) || normalizeVersion(name);
}

function supersededBy(l, version) {
  const now = REL.currentName(l);
  if (!now) return `current no longer points at a release in ${l.releases}`;
  if (!REL.isPublishedRelease(l, now)) return `releases/${now} became current meanwhile and is not a published release (a dev deploy)`;
  const nowVersion = releaseVersion(l, now);
  const order = compareSemver(nowVersion, version);
  if (order === null) return `releases/${now} became current meanwhile and its version cannot be compared with ${version}`;
  if (order >= 0) return `releases/${now} (${nowVersion}) became current meanwhile, as new as ${version} or newer`;
  return '';
}

function skippedNow(home, version, explicit) {
  if (explicit || !home) return '';
  const skip = readSkip(home);
  if (!skip || compareSemver(version, skip.version) > 0) return '';
  return `${skip.version} is skipped${skip.reason ? ` (${skip.reason})` : ''}; a newer release or claude-wow update installs again`;
}

function binaryLockFile(binary) {
  return path.join(path.dirname(binary), `.${path.basename(binary)}.update.lock`);
}

async function installedSupersedes(binary, version, probe) {
  let ran;
  try { ran = await probe(binary); } catch { return ''; }
  if (!ran || !ran.ok) return '';
  const order = compareSemver(ran.version, version);
  return order !== null && order >= 0 ? `${binary} is already ${ran.version}, as new as ${version} or newer` : '';
}

async function swapIn(install, tmp, version, sum, ctx = {}) {
  const { platform = process.platform, activate = REL.installAndActivate, home = '', explicit = false, probe = probeBinary } = ctx;
  const command = `claude-wow update to ${version}`;
  if (install.kind === 'releases') {
    const l = install.layout;
    const lock = REL.acquireLock(l.lock, { command });
    let result;
    try {
      const superseded = skippedNow(home, version, explicit) || supersededBy(l, version);
      if (superseded) return { binary: '', superseded };
      lock.assertHeld();
      result = await activate(l, { name: version, binaryFile: tmp, meta: { source: REL.SOURCE_SELF_UPDATE, version, sha256: sum } });
    } finally {
      lock.release();
    }
    return { binary: REL.currentBinary(l), pruneError: (result && result.pruneError) || '' };
  }
  const lock = REL.acquireLock(binaryLockFile(install.binary), { command });
  try {
    const superseded = skippedNow(home, version, explicit) || await installedSupersedes(install.binary, version, probe);
    if (superseded) return { binary: '', superseded };
    lock.assertHeld();
    replaceFile(tmp, install.binary, platform);
  } finally {
    lock.release();
  }
  return { binary: install.binary, pruneError: '' };
}

function clearPendingRestart(home, reason) {
  const rec = readRecord(home);
  if (!rec.pendingRestart) return false;
  writeRecord(home, { pendingRestart: false, message: `the restart onto ${rec.version || 'the update'} was called off: ${reason}` });
  return true;
}

function pruneStaleDownloads(dir, { alive = REL.pidAlive, now = Date.now, maxAgeMs = STALE_DOWNLOAD_MS } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const n of names) {
    const m = DOWNLOAD_NAME.exec(n);
    if (!m) continue;
    const file = path.join(dir, n);
    let age = 0;
    try { age = now() - fs.statSync(file).mtimeMs; } catch { continue; }
    if (alive(Number(m[1])) && age < maxAgeMs) continue;
    try { fs.rmSync(file, { force: true }); removed.push(n); } catch {}
  }
  return removed;
}

function skipFile(home) {
  return path.join(home, SKIP_FILE);
}

function readSkip(home) {
  try {
    const s = JSON.parse(fs.readFileSync(skipFile(home), 'utf8'));
    return s && typeof s === 'object' && normalizeVersion(s.version) ? { ...s, version: normalizeVersion(s.version) } : null;
  } catch { return null; }
}

function skipVersion(home, version, reason = '', now = Date.now) {
  const v = normalizeVersion(version);
  if (!v) throw new Error(`"${version}" is not a version to skip`);
  const record = { version: v, reason: String(reason || ''), at: now() };
  const file = skipFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return record;
}

function clearSkip(home) {
  try { fs.rmSync(skipFile(home), { force: true }); } catch {}
}

function skipRelease(l, name, reason = '') {
  if (!REL.isPublishedRelease(l, name)) return null;
  const version = releaseVersion(l, name);
  return version ? skipVersion(l.base, version, reason) : null;
}

function cleanupAside(install, platform = process.platform) {
  if (platform !== 'win32' || !install || install.kind !== 'binary') return 0;
  const dir = path.dirname(install.binary);
  const base = path.basename(install.binary);
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const n of names) {
    if (n !== `${base}.old` && !n.startsWith(`${base}.old-`)) continue;
    try { fs.rmSync(path.join(dir, n), { force: true }); removed++; } catch {}
  }
  return removed;
}

function recordFile(home) {
  return path.join(home, RECORD_FILE);
}

function readRecord(home) {
  try {
    const r = JSON.parse(fs.readFileSync(recordFile(home), 'utf8'));
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  } catch { return {}; }
}

function writeRecord(home, patch) {
  const next = { ...readRecord(home), ...patch };
  const file = recordFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return next;
}

function effectiveVersion(version, record) {
  if (record && record.pendingRestart && compareSemver(record.version, version) > 0) return normalizeVersion(record.version);
  return version;
}

async function runUpdate(opts = {}) {
  const { home, version = ownVersion(), api = apiBase(), install = installKind(), platform = process.platform, arch = process.arch, probe = probeBinary, checkOnly = false, explicit = false, limits = LIMITS, activate, alive } = opts;
  const current = effectiveVersion(version, readRecord(home));
  if (install.kind === 'dev') return { status: 'refused', current, message: `self-update is off: ${install.why}` };
  const asset = assetName(platform, arch);
  if (!asset && install.kind !== 'homebrew') return { status: 'failed', current, message: `no release binary is built for ${platform} ${arch}` };
  const dir = install.kind === 'releases' ? install.layout.releases : install.kind === 'binary' ? path.dirname(install.binary) : '';
  if (dir) pruneStaleDownloads(dir, alive ? { alive } : {});
  const release = await latestRelease(api, limits);
  const latest = release.version;
  const failed = message => ({ status: 'failed', current, latest, message });
  const order = compareSemver(latest, current);
  if (order === null) return failed(`cannot compare ${latest} with this version ${current}`);
  if (order <= 0) return { status: 'current', current, latest, message: `claude-wow ${current} is up to date (latest release ${latest})` };
  const skip = explicit ? null : readSkip(home);
  if (skip && compareSemver(latest, skip.version) <= 0) return { status: 'skipped', current, latest, message: `claude-wow ${latest} is out, but ${skip.version} is skipped${skip.reason ? ` (${skip.reason})` : ''}; a newer release or claude-wow update installs again` };
  if (install.kind === 'homebrew') return { status: 'homebrew', current, latest, message: `claude-wow ${latest} is out (this is ${current}). Homebrew installed this one, so run: brew upgrade claude-wow` };
  if (checkOnly) return { status: 'available', current, latest, message: `claude-wow ${latest} is out (this is ${current}); run claude-wow update to install it` };
  const file = release.assets.find(a => a.name === asset);
  if (!file) return failed(`release ${release.tag} has no ${asset}; nothing was replaced`);
  const sumsFile = release.assets.find(a => a.name === SUMS_ASSET);
  if (!sumsFile) return failed(`release ${release.tag} has no ${SUMS_ASSET}, so ${asset} cannot be verified; nothing was replaced`);
  const want = parseSums((await get(sumsFile.url, limits.sums)).toString('utf8')).get(asset);
  if (!want) return failed(`${SUMS_ASSET} of ${release.tag} has no line for ${asset}; nothing was replaced`);
  const tmp = tempPath(dir, asset, platform);
  try {
    const have = await downloadTo(file.url, tmp, limits.asset);
    if (have !== want) return failed(`the downloaded ${asset} does not match ${SUMS_ASSET} of ${release.tag}; nothing was replaced`);
    if (platform !== 'win32') fs.chmodSync(tmp, 0o755);
    const ran = await probe(tmp);
    if (!ran.ok) return failed(`the downloaded ${asset} does not run (${ran.why}); nothing was replaced`);
    if (compareSemver(ran.version, latest) !== 0) return failed(`the downloaded ${asset} says it is ${ran.version}, not ${latest}; nothing was replaced`);
    const swapped = await swapIn(install, tmp, latest, want, { platform, activate, home, explicit, probe });
    if (swapped.superseded) return { status: 'skipped', current, latest, message: `not installing ${latest}: ${swapped.superseded}` };
    if (explicit) clearSkip(home);
    const pruneNote = swapped.pruneError ? `; old releases were not pruned (${swapped.pruneError})` : '';
    return { status: 'updated', current, latest, binary: swapped.binary, message: `updated claude-wow ${current} to ${latest} (${swapped.binary})${pruneNote}` };
  } finally {
    rmQuiet(tmp);
  }
}

async function checkAndRecord(opts = {}) {
  const now = opts.now || Date.now;
  const at = now();
  let outcome;
  try { outcome = await runUpdate(opts); } catch (e) {
    outcome = { status: 'failed', message: `update check failed: ${e && e.message ? e.message : e}` };
  }
  if (outcome.status === 'refused' || !opts.home) return outcome;
  const patch = { attemptAt: at, ok: outcome.status !== 'failed', status: outcome.status, message: outcome.message };
  if (outcome.latest) patch.latest = outcome.latest;
  if (outcome.status === 'updated') {
    Object.assign(patch, { pendingRestart: true, version: outcome.latest, from: outcome.current, binary: outcome.binary, updatedAt: at, restartFrom: null, restartRequestedAt: null });
  }
  try { writeRecord(opts.home, patch); } catch (e) { outcome.message += ` (could not write ${RECORD_FILE}: ${e.message})`; }
  return outcome;
}

function checkDue(record, now, { dayMs = DAY_MS, retryMs = HOUR_MS } = {}) {
  const at = Number(record && record.attemptAt) || 0;
  if (!at || at > now) return true;
  return now - at >= (record.ok === false ? retryMs : dayMs);
}

function idleMsFrom(cfg = {}) {
  const s = Number(cfg.autoUpdateIdleSeconds);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : DEFAULT_IDLE_SECONDS * 1000;
}

function seconds(ms) {
  return `${Math.round(ms / 1000)} s`;
}

function restartVerdict({ record, version, idle = { idle: true, reason: '' }, lastActivityAt = 0, now = Date.now(), idleMs = DEFAULT_IDLE_SECONDS * 1000, supervised = false, gameRunning = null }) {
  if (!record || !record.pendingRestart || !record.version) return { restart: false, pending: false, code: 'none', why: 'no update waits' };
  const order = compareSemver(record.version, version);
  if (order === null || order <= 0) return { restart: false, pending: false, code: 'running', why: `already running ${version}` };
  if (record.restartFrom === version) return { restart: false, pending: false, code: 'tried', why: `a restart for ${record.version} already happened and this is still ${version}` };
  if (!supervised) return { restart: false, pending: true, code: 'manual', why: 'this bridge runs without the supervisor; restart it by hand' };
  if (!idle || !idle.idle) return { restart: false, pending: true, code: 'busy', why: (idle && idle.reason) || 'the bridge is busy' };
  const quietMs = Math.max(0, now - (Number(lastActivityAt) || 0));
  if (quietMs < Math.min(MIN_QUIET_MS, idleMs)) return { restart: false, pending: true, code: 'recent', why: `the last message or reply was ${seconds(quietMs)} ago` };
  const game = typeof gameRunning === 'function' ? gameRunning() : gameRunning;
  if (game === false) return { restart: true, pending: true, code: 'closed', why: 'nothing is running and the game is closed' };
  if (quietMs >= idleMs) return { restart: true, pending: true, code: 'idle', why: `nothing is running and no message or reply for ${seconds(quietMs)}` };
  return { restart: false, pending: true, code: 'active', why: `${game ? 'the game is running and ' : ''}the last message or reply was ${seconds(quietMs)} ago; it restarts after ${seconds(idleMs)} of quiet or when the game closes` };
}

function createUpdater(deps) {
  const {
    home, cfg = {}, log = () => {}, version = ownVersion(), idle = () => ({ idle: true, reason: '' }), lastActivityAt = () => 0,
    gameRunning = () => null, restart, supervised = false, install = installKind(), api,
    now = Date.now, check = checkAndRecord, timers = { setTimeout, setInterval },
  } = deps;
  const idleMs = idleMsFrom(cfg);
  const autoCheck = cfg.autoUpdate !== false && install.kind !== 'dev';
  let checking = false;
  let lastCode = '';

  function settleRecord() {
    const rec = readRecord(home);
    if (!rec.pendingRestart || !rec.version) return '';
    const order = compareSemver(rec.version, version);
    if (order !== null && order <= 0) {
      writeRecord(home, { pendingRestart: false, restartedAt: now() });
      log(`self-update: now running ${version}${rec.from ? ` (updated from ${rec.from})` : ''}`);
      return 'running';
    }
    if (rec.restartFrom === version) {
      writeRecord(home, { pendingRestart: false, message: `restarted for ${rec.version}, but ${rec.binary || 'the binary'} still runs ${version}` });
      log(`self-update: restarted for ${rec.version}, but this is still ${version}; it waits for the next update check`);
      return 'tried';
    }
    return 'pending';
  }

  async function checkTick() {
    if (!autoCheck || checking) return null;
    if (!checkDue(readRecord(home), now())) return null;
    checking = true;
    try {
      const outcome = await check({ home, version, install, api, now });
      log(`self-update: ${outcome.message}`);
      return outcome;
    } catch (e) {
      log(`self-update: check failed (${e && e.message ? e.message : e})`);
      return null;
    } finally {
      checking = false;
    }
  }

  function restartTick() {
    let rec, v;
    try {
      rec = readRecord(home);
      v = restartVerdict({ record: rec, version, idle: idle(), lastActivityAt: lastActivityAt(), now: now(), idleMs, supervised, gameRunning });
    } catch (e) {
      log(`self-update: restart check failed (${e && e.message ? e.message : e})`);
      return null;
    }
    if (v.restart) {
      try { writeRecord(home, { restartFrom: version, restartRequestedAt: now() }); } catch (e) {
        log(`self-update: cannot write ${RECORD_FILE} (${e.message}); not restarting, so a failed restart cannot loop`);
        return v;
      }
      log(`self-update: restarting on ${rec.version} now: ${v.why}`);
      restart();
      return v;
    }
    if (v.pending && v.code !== lastCode) log(`self-update: ${rec.version} is installed; the restart waits: ${v.why}`);
    lastCode = v.code;
    return v;
  }

  function start() {
    try { settleRecord(); } catch (e) { log(`self-update: cannot read ${recordFile(home)} (${e.message})`); }
    const removed = cleanupAside(install);
    if (removed) log(`self-update: removed ${removed} old binary copy(ies) left by the last update`);
    if (install.kind === 'dev') log(`self-update: off (${install.why})`);
    else if (cfg.autoUpdate === false) log('self-update: the daily check is off (autoUpdate false in config.json); claude-wow update still works');
    if (autoCheck) {
      const first = timers.setTimeout(checkTick, FIRST_CHECK_DELAY_MS);
      const every = timers.setInterval(checkTick, CHECK_TICK_MS);
      if (first && first.unref) first.unref();
      if (every && every.unref) every.unref();
    }
    const gate = timers.setInterval(restartTick, RESTART_TICK_MS);
    if (gate && gate.unref) gate.unref();
  }

  return { start, checkTick, restartTick, settleRecord, idleMs, autoCheck };
}

function formatAt(ms) {
  return Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : '?';
}

function statusLine(rec) {
  if (!rec || !rec.attemptAt) return 'no update check yet';
  const pending = rec.pendingRestart && rec.version ? `${rec.version} installed, the bridge restarts on it when idle; ` : '';
  return `${pending}last check ${formatAt(rec.attemptAt)}: ${rec.message || rec.status || '?'}`;
}

const HELP = `claude-wow update [--check]

Checks the latest GitHub release of claude-wow and, when it is newer, downloads
the binary for this machine and SHA256SUMS, verifies the checksum, runs it once
(--version), and puts it in place of this one. A running bridge started by the
supervisor (claude-wow, or the service) restarts on it once nothing is running
and the game is closed or quiet (autoUpdateIdleSeconds, default ${DEFAULT_IDLE_SECONDS}).

  --check   only say whether a newer release is out

Never downgrades. A Homebrew install is not touched: run brew upgrade claude-wow.
A checkout (node or bun running the source) is never updated: use git pull.
autoUpdate: false in config.json turns off the daily check, not this command.
A version in update-skip.json (after dev rollback) is skipped by the daily
check; this command installs it anyway and lifts the skip.
Exit codes: 0 up to date, updated or newer found, 1 failed, 2 usage, 3 refused.`;

async function main(argv = [], deps = {}) {
  const out = deps.out || console.log;
  const err = deps.err || console.error;
  let checkOnly = false;
  for (const a of argv) {
    if (a === '--check') checkOnly = true;
    else if (a === '-h' || a === '--help' || a === 'help') { out(HELP); return 0; }
    else { err(`claude-wow update: unknown option "${a}"`); out(HELP); return 2; }
  }
  const home = deps.home || H.resolve().dir;
  const outcome = await checkAndRecord({ ...deps, home, checkOnly, explicit: !checkOnly });
  if (outcome.status === 'failed') { err(`claude-wow update: ${outcome.message}`); return 1; }
  out(outcome.message);
  if (outcome.status === 'refused') return 3;
  if (outcome.status === 'updated') out('A bridge running under the supervisor or the service restarts on it by itself once nothing is running and the game is closed or quiet. A bridge started with "claude-wow bridge": restart it by hand.');
  return 0;
}

module.exports = {
  DEFAULT_API, RECORD_FILE, SUMS_ASSET, LIMITS, UPDATE_EXIT_CODE, RESTART_TICK_MS, CHECK_TICK_MS, FIRST_CHECK_DELAY_MS,
  DEFAULT_IDLE_SECONDS, MIN_QUIET_MS, DAY_MS, HOUR_MS, HELP, SKIP_FILE, STALE_DOWNLOAD_MS,
  readSkip, skipVersion, clearSkip, skipRelease, clearPendingRestart, binaryLockFile, pruneStaleDownloads, supersededBy, releaseVersion,
  apiBase, parseSemver, normalizeVersion, compareSemver, assetName, installKind, launchPath, releasesLayout,
  get, latestRelease, parseSums, downloadTo, probeBinary, swapIn, replaceFile, cleanupAside, unpublishedRelease,
  recordFile, readRecord, writeRecord, effectiveVersion, runUpdate, checkAndRecord, checkDue, idleMsFrom,
  restartVerdict, createUpdater, statusLine, main,
};
