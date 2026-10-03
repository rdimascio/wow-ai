'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const H = require('./home');

const BINARY = process.platform === 'win32' ? 'claude-wow.exe' : 'claude-wow';
const RELEASES_DIR = 'releases';
const KEEP_RELEASES = 5;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const LOCK_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const UNREADABLE_LOCK_GRACE_MS = 60 * 1000;
const RELEASE_INFO = 'release.json';
const PREPARING = 'preparing';
const SWITCHING = 'switching';
const SOURCE_DEV_DEPLOY = 'dev-deploy';
const SOURCE_SELF_UPDATE = 'self-update';
const SOURCE_RELEASE = 'release';
const PUBLISHED_SOURCES = [SOURCE_RELEASE, SOURCE_SELF_UPDATE];

function layout(base = H.resolve().dir) {
  return {
    base,
    releases: path.join(base, RELEASES_DIR),
    current: path.join(base, 'current'),
    previous: path.join(base, 'previous'),
    lock: path.join(base, 'deploy.lock'),
    bridgeLock: path.join(base, 'bridge.lock'),
    state: path.join(base, 'state.json'),
    config: path.join(base, 'config.json'),
  };
}

const releaseDir = (l, name) => path.join(l.releases, name);
const releaseBinary = (l, name) => path.join(releaseDir(l, name), BINARY);
const currentBinary = l => path.join(l.current, BINARY);

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function validName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

function checkName(name) {
  if (!validName(name)) throw new Error(`"${name}" is not a usable release name (letters, digits, dot, dash, plus, underscore; it must start with a letter or digit)`);
  return name;
}

function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function isInsideReleases(l, file) {
  if (!file) return false;
  const rel = path.relative(realOrResolved(l.releases), realOrResolved(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function currentName(l) {
  let target;
  try { target = fs.readlinkSync(l.current); } catch { return ''; }
  const resolved = path.resolve(l.base, target);
  if (path.dirname(resolved) !== path.resolve(l.releases)) return '';
  const name = path.basename(resolved);
  return validName(name) ? name : '';
}

function previousName(l) {
  let text;
  try { text = fs.readFileSync(l.previous, 'utf8').trim(); } catch { return ''; }
  return validName(text) ? text : '';
}

function releaseComplete(l, name) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(releaseDir(l, name), RELEASE_INFO), 'utf8'));
    return !!info && info.name === name && info.complete === true;
  } catch { return false; }
}

function hasRelease(l, name) {
  return validName(name) && isFile(releaseBinary(l, name)) && releaseComplete(l, name);
}

function fsyncPath(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    fs.fsyncSync(fd);
  } catch (e) {
    if (!isFile(p) && ['EISDIR', 'EPERM', 'EINVAL', 'EBADF'].includes(e.code)) return;
    throw e;
  } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function writeDurable(file, text) {
  const fd = fs.openSync(file, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

function installRelease(l, { name, binaryFile, meta = {}, now = Date.now }) {
  checkName(name);
  if (hasRelease(l, name) && !binaryFile) return { name, dir: releaseDir(l, name), reused: true };
  if (!binaryFile || !isFile(binaryFile)) throw new Error(`no binary to install for release ${name}${binaryFile ? ` (${binaryFile} is missing)` : ''}${fs.existsSync(releaseDir(l, name)) ? `; ${releaseDir(l, name)} is not a finished release, so it is not reused` : ''}`);
  fs.mkdirSync(l.releases, { recursive: true });
  const staging = path.join(l.releases, `.staging-${name}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(staging);
  try {
    const staged = path.join(staging, BINARY);
    fs.copyFileSync(binaryFile, staged);
    fs.chmodSync(staged, 0o755);
    fsyncPath(staged);
    writeDurable(path.join(staging, RELEASE_INFO), JSON.stringify({ ...meta, name, installedAt: now(), complete: true }, null, 2) + '\n');
    fsyncPath(staging);
    const dir = releaseDir(l, name);
    if (fs.existsSync(dir)) {
      if (name === currentName(l)) throw new Error(`release ${name} is the current release; it is not replaced in place`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.renameSync(staging, dir);
    fsyncPath(l.releases);
    return { name, dir, reused: false };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

function pointCurrentAt(l, name) {
  checkName(name);
  if (!hasRelease(l, name)) throw new Error(`release ${name} has no ${BINARY} in ${releaseDir(l, name)}`);
  const tmp = `${l.current}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.symlinkSync(path.join(RELEASES_DIR, name), tmp);
  try { fs.renameSync(tmp, l.current); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

function activate(l, name, { point = pointCurrentAt } = {}) {
  checkName(name);
  const was = currentName(l);
  if (was === name) return { name, previous: previousName(l), changed: false };
  if (!hasRelease(l, name)) throw new Error(`release ${name} has no ${BINARY} in ${releaseDir(l, name)}`);
  const recordedBefore = readPreviousFile(l);
  if (was) writeAtomic(l.previous, was + '\n');
  try {
    point(l, name);
  } catch (e) {
    try { restorePreviousFile(l, recordedBefore); } catch (restoreError) {
      e.message += `; ${l.previous} could not be put back to ${recordedBefore === null ? 'no previous release' : recordedBefore.trim()} (${restoreError.message})`;
    }
    throw e;
  }
  return { name, previous: was, changed: true };
}

function readPreviousFile(l) {
  try { return fs.readFileSync(l.previous, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function restorePreviousFile(l, text) {
  if (text === null) {
    try { fs.unlinkSync(l.previous); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  writeAtomic(l.previous, text);
}

function rollback(l) {
  const prev = previousName(l);
  if (!prev) throw new Error(`no previous release is recorded in ${l.previous}`);
  if (!hasRelease(l, prev)) throw new Error(`the previous release ${prev} is gone from ${l.releases}`);
  const was = currentName(l);
  if (was === prev) throw new Error(previousIsCurrentMessage(l, prev));
  return activate(l, prev);
}

function releaseInfo(l, name) {
  if (!validName(name)) return null;
  try {
    const info = JSON.parse(fs.readFileSync(path.join(releaseDir(l, name), RELEASE_INFO), 'utf8'));
    return info && typeof info === 'object' && !Array.isArray(info) ? info : null;
  } catch { return null; }
}

function isPublishedRelease(l, name) {
  const info = releaseInfo(l, name);
  return !!info && PUBLISHED_SOURCES.includes(info.source);
}

function previousIsCurrentMessage(l, name) {
  return `${l.previous} names ${name}, the current release, so there is nothing to roll back to. A deploy or rollback stopped after it wrote ${l.previous} and before it switched; ${name} is still the release that runs. To finish that deploy, run it again; to go to another release, deploy its ref (a release already in ${l.releases} is not built again).`;
}

function releaseTime(l, name) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(releaseDir(l, name), RELEASE_INFO), 'utf8'));
    if (Number.isFinite(info.installedAt)) return info.installedAt;
  } catch {}
  try { return fs.statSync(releaseDir(l, name)).mtimeMs; } catch { return 0; }
}

function listReleases(l) {
  let names;
  try { names = fs.readdirSync(l.releases); } catch { return []; }
  return names
    .filter(n => validName(n) && fs.statSync(releaseDir(l, n)).isDirectory())
    .map(n => ({ name: n, installedAt: releaseTime(l, n) }))
    .sort((a, b) => b.installedAt - a.installedAt || (a.name < b.name ? 1 : -1));
}

const STAGING_PATTERN = /^\.staging-.+-(\d+)-[0-9a-f]{8}$/;

function pruneStaging(l, alive = pidAlive) {
  let names;
  try { names = fs.readdirSync(l.releases); } catch { return []; }
  const removed = [];
  for (const n of names) {
    const m = STAGING_PATTERN.exec(n);
    if (!m || alive(Number(m[1]))) continue;
    fs.rmSync(path.join(l.releases, n), { recursive: true, force: true });
    removed.push(n);
  }
  return removed;
}

function prune(l, keep = KEEP_RELEASES, { alive = pidAlive } = {}) {
  const staging = pruneStaging(l, alive);
  const current = currentName(l);
  if (!current) return { removed: [], staging, skipped: 'current does not point at a release' };
  const protectedNames = new Set([current, previousName(l)].filter(Boolean));
  const all = listReleases(l);
  const kept = new Set(all.slice(0, Math.max(0, keep)).map(r => r.name));
  const removed = [];
  for (const r of all) {
    if (kept.has(r.name) || protectedNames.has(r.name)) continue;
    fs.rmSync(releaseDir(l, r.name), { recursive: true, force: true });
    removed.push(r.name);
  }
  return { removed, staging, skipped: '' };
}

function pruneReported(l, keep, opts) {
  try {
    const r = prune(l, keep, opts);
    return { removed: r.removed, staging: r.staging, error: '' };
  } catch (e) {
    return { removed: [], staging: [], error: e && e.message ? e.message : String(e) };
  }
}

async function installAndActivate(l, { name, binaryFile, meta, keep = KEEP_RELEASES, now, alive }, { waitIdle, afterFlip } = {}) {
  const installed = installRelease(l, { name, binaryFile, meta, now });
  if (waitIdle) await waitIdle();
  const flip = activate(l, name);
  const outcome = afterFlip ? await afterFlip(flip) : undefined;
  const pruned = pruneReported(l, keep, { alive });
  return { ...installed, ...flip, outcome, pruned: pruned.removed, prunedStaging: pruned.staging, pruneError: pruned.error };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readLock(file) {
  let text = '', mtimeMs = 0, ino = 0;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    mtimeMs = st.mtimeMs;
    ino = st.ino;
    text = fs.readFileSync(fd, 'utf8');
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  const empty = { pid: 0, host: '', started: 0, command: '', token: '', phase: '', mtimeMs, ino };
  try {
    const v = JSON.parse(text);
    return { ...empty, pid: Number(v.pid) || 0, host: String(v.host || ''), started: Number(v.started) || 0, command: String(v.command || ''), token: String(v.token || ''), phase: String(v.phase || '') };
  } catch { return empty; }
}

const sameLockFile = (a, b) => !!a && !!b && a.ino === b.ino && a.token === b.token;

function createExclusive(file, text, token) {
  const tmp = `${file}.${token}.new`;
  fs.writeFileSync(tmp, text);
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function takeOverStale(file, held, pid = process.pid) {
  const aside = `${file}.stale-${pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.renameSync(file, aside); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  const moved = readLock(aside);
  if (sameLockFile(moved, held)) {
    fs.unlinkSync(aside);
    return true;
  }
  let restored = true;
  try { fs.linkSync(aside, file); } catch { restored = false; }
  try { fs.unlinkSync(aside); } catch {}
  if (!restored) throw new Error(`${file} changed while this deploy took over a stale lock, and the lock it moved aside (${moved && moved.pid ? `pid ${moved.pid}` : 'no pid'}) could not be put back because another deploy took the lock in between. That deploy stops before it switches anything. Nothing was done here; run this again.`);
  throw new Error(heldMessage(file, moved));
}

function lockHeldBy(file, token) {
  const held = readLock(file);
  return !!held && !!token && held.token === token;
}

function assertLockHeld(file, token) {
  if (!lockHeldBy(file, token)) throw new Error(`${file} is no longer held by this process (another deploy took it over); nothing was switched`);
}

function switchingHolder(file, { alive = pidAlive, now = Date.now, host = os.hostname(), maxAgeMs = LOCK_MAX_AGE_MS } = {}) {
  const held = readLock(file);
  if (!held || held.phase !== SWITCHING || !held.pid) return null;
  if (held.host && held.host !== host) return null;
  if (!alive(held.pid) || now() - held.started > maxAgeMs) return null;
  return held;
}

function lockIsStale(held, { alive, now, host, maxAgeMs }) {
  if (!held) return true;
  if (!held.pid) return now() - held.mtimeMs > UNREADABLE_LOCK_GRACE_MS;
  if (held.host && held.host !== host) return now() - held.started > maxAgeMs;
  if (!alive(held.pid)) return true;
  return now() - held.started > maxAgeMs;
}

function heldMessage(file, held) {
  const since = held && held.started ? new Date(held.started).toISOString() : 'an unknown time';
  const who = held && held.pid ? `pid ${held.pid}${held.command ? ` (${held.command})` : ''}` : 'a process that has not written its pid yet';
  return `another deploy holds ${file}: ${who}, since ${since}. Wait for it to finish; if that process is gone, delete ${file} and run this again.`;
}

function setLockPhase(file, token, phase) {
  assertLockHeld(file, token);
  const { pid, host, started, command } = readLock(file);
  writeAtomic(file, JSON.stringify({ pid, host, started, command, token, phase }));
}

function acquireLock(file, { pid = process.pid, command = '', alive = pidAlive, now = Date.now, host = os.hostname(), maxAgeMs = LOCK_MAX_AGE_MS } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const body = JSON.stringify({ pid, host, started: now(), command, token, phase: PREPARING });
  let staleRemoved = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createExclusive(file, body, token)) {
      return {
        file, pid, token, staleRemoved,
        release: () => releaseLock(file, token),
        setPhase: phase => setLockPhase(file, token, phase),
        assertHeld: () => assertLockHeld(file, token),
      };
    }
    const held = readLock(file);
    if (!held) continue;
    if (!lockIsStale(held, { alive, now, host, maxAgeMs })) throw new Error(heldMessage(file, held));
    if (takeOverStale(file, held, pid)) staleRemoved = true;
  }
  throw new Error(`could not take ${file}; run this again`);
}

function releaseLock(file, token) {
  if (!lockHeldBy(file, token)) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

module.exports = {
  BINARY, RELEASES_DIR, KEEP_RELEASES, LOCK_MAX_AGE_MS, RELEASE_INFO, PREPARING, SWITCHING,
  SOURCE_DEV_DEPLOY, SOURCE_RELEASE, SOURCE_SELF_UPDATE, PUBLISHED_SOURCES, releaseInfo, isPublishedRelease,
  layout, releaseDir, releaseBinary, currentBinary, validName, checkName, isInsideReleases,
  currentName, previousName, hasRelease, releaseComplete, installRelease, pointCurrentAt, activate, rollback, previousIsCurrentMessage,
  listReleases, prune, pruneStaging, pruneReported, installAndActivate,
  pidAlive, readLock, acquireLock, releaseLock, takeOverStale, switchingHolder,
};
