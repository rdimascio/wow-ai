'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const UPD = require('../bridge/selfupdate');
const B = require('../build');
const REL = require('../bridge/releases');

const POSIX = process.platform !== 'win32';
const PLATFORM = POSIX ? 'linux' : 'win32';
const ARCH = 'x64';
const ASSET = UPD.assetName(PLATFORM, ARCH);
const OLD = Buffer.from('OLD BINARY');
const NEW = Buffer.from('NEW BINARY 9.9.9');

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `claude-wow-update-${label}-`));
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function serve(handler) {
  return new Promise(resolve => {
    const hits = [];
    const server = http.createServer((req, res) => { hits.push(req.url); handler(req, res, server); });
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base, hits,
        downloads: () => hits.filter(h => h.startsWith('/files/')),
        close: () => new Promise(r => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

function releaseServer({ tag = 'v9.9.9', body = NEW, sums, omitAsset = false, omitSums = false, chunked = false } = {}) {
  const sumsText = sums !== undefined ? sums : `${sha(body)}  ${ASSET}\n${sha(Buffer.from('other'))}  claude-wow-darwin-arm64\n`;
  return serve((req, res, server) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/repos/x/releases/latest') {
      const assets = [];
      if (!omitAsset) assets.push({ name: ASSET, browser_download_url: `${base}/dl/${ASSET}`, size: body.length });
      if (!omitSums) assets.push({ name: 'SHA256SUMS', browser_download_url: `${base}/dl/SHA256SUMS`, size: sumsText.length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tag_name: tag, assets }));
    } else if (req.url.startsWith('/dl/')) {
      res.writeHead(302, { Location: `/files/${req.url.slice(4)}` });
      res.end();
    } else if (req.url === `/files/${ASSET}` && chunked) {
      res.writeHead(200);
      res.write(body.subarray(0, 3));
      setTimeout(() => res.end(body.subarray(3)), 20);
    } else if (req.url === `/files/${ASSET}`) {
      res.writeHead(200, { 'Content-Length': body.length });
      res.end(body);
    } else if (req.url === '/files/SHA256SUMS') {
      res.end(sumsText);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

function setup(label) {
  const dir = tmpDir(label);
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const binary = path.join(bin, POSIX ? 'claude-wow' : 'claude-wow.exe');
  fs.writeFileSync(binary, OLD, { mode: 0o755 });
  return { dir, home, bin, binary, install: { kind: 'binary', binary } };
}

function opts(t, srv, extra = {}) {
  return { home: t.home, version: '1.0.0', api: `${srv.base}/repos/x`, install: t.install, platform: PLATFORM, arch: ARCH, probe: async file => ({ ok: true, version: file === t.binary ? '1.0.0' : '9.9.9' }), ...extra };
}

function untouched(t) {
  assert.deepEqual(fs.readFileSync(t.binary), OLD, 'the running binary is untouched');
  assert.deepEqual(fs.readdirSync(t.bin), [path.basename(t.binary)], 'no temp file is left next to it');
}

test('semver compare: prereleases sort before their release, identifiers by semver rules, no compare on junk', () => {
  const cases = [
    ['0.5.0-beta.1', '0.5.0', -1],
    ['0.5.0', '0.5.0-beta.1', 1],
    ['0.5.0-beta.2', '0.5.0-beta.10', -1],
    ['0.5.0-alpha', '0.5.0-beta', -1],
    ['0.5.0-beta', '0.5.0-beta.1', -1],
    ['0.5.0-rc.1', '0.5.0-beta.11', 1],
    ['1.0.0-1', '1.0.0-a', -1],
    ['1.0.0', '0.9.9', 1],
    ['0.10.0', '0.9.0', 1],
    ['v1.2.3', '1.2.3', 0],
    ['1.2.3+build.5', '1.2.3', 0],
  ];
  for (const [a, b, want] of cases) assert.equal(UPD.compareSemver(a, b), want, `${a} vs ${b}`);
  assert.equal(UPD.compareSemver('1.2', '1.2.3'), null);
  assert.equal(UPD.compareSemver('01.2.3', '1.2.3'), null);
  assert.equal(UPD.normalizeVersion('v0.5.0-beta.1+sha'), '0.5.0-beta.1');
});

test('the asset name is the one build.js gives each target, and none for an unbuilt platform', () => {
  for (const target of B.TARGETS) {
    const [, osName, arch] = target.split('-');
    assert.equal(UPD.assetName(osName === 'windows' ? 'win32' : osName, arch), B.outName(target));
  }
  assert.equal(UPD.assetName('linux', 'arm64'), '');
  assert.equal(UPD.assetName('freebsd', 'x64'), '');
});

test('install kind: source, a Homebrew keg, a git checkout and a dev deploy are refused; a plain binary and a release are not', () => {
  assert.equal(UPD.installKind({ compiled: false, execPath: process.execPath }).kind, 'dev');
  assert.equal(UPD.installKind({ compiled: true, execPath: '/opt/homebrew/Cellar/claude-wow/0.5.0/bin/claude-wow' }).kind, 'homebrew');
  assert.equal(UPD.installKind({ compiled: true, execPath: '/usr/local/Cellar/claude-wow/0.5.0/bin/claude-wow' }).kind, 'homebrew');
  assert.equal(UPD.installKind({ compiled: true, execPath: '/home/linuxbrew/.linuxbrew/bin/claude-wow' }).kind, 'homebrew');
  const repo = tmpDir('repo');
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'dist'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'claude-wow' }));
  fs.writeFileSync(path.join(repo, 'dist', 'claude-wow'), OLD);
  const inRepo = UPD.installKind({ compiled: true, execPath: path.join(repo, 'dist', 'claude-wow') });
  assert.equal(inRepo.kind, 'dev');
  assert.match(inRepo.why, /git checkout/);
  for (const [label, files] of [['dotfiles', {}], ['another project', { 'package.json': JSON.stringify({ name: 'something-else' }) }]]) {
    const home = tmpDir('dotfiles');
    fs.mkdirSync(path.join(home, '.git'));
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(home, f), text);
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude-wow'), OLD);
    assert.equal(UPD.installKind({ compiled: true, execPath: path.join(home, '.local', 'bin', 'claude-wow') }).kind, 'binary', `${label}: a git repo above the binary that is not this project does not turn updates off`);
    fs.rmSync(home, { recursive: true, force: true });
  }
  const t = setup('kind');
  const plain = UPD.installKind({ compiled: true, execPath: t.binary });
  assert.equal(plain.kind, 'binary');
  assert.equal(plain.binary, fs.realpathSync(t.binary));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('end to end: a newer release replaces the binary, verified, executable, with pendingRestart recorded', async () => {
  const t = setup('e2e');
  const srv = await releaseServer();
  try {
    const out = await UPD.checkAndRecord(opts(t, srv, { now: () => 1000 }));
    assert.equal(out.status, 'updated', out.message);
    assert.deepEqual(fs.readFileSync(t.binary), NEW);
    if (POSIX) assert.equal(fs.statSync(t.binary).mode & 0o111, 0o111, 'executable');
    const base = path.basename(t.binary);
    assert.deepEqual(fs.readdirSync(t.bin).sort(), POSIX ? [base] : [base, `${base}.old`], 'no temp file left');
    assert.ok(srv.hits.includes(`/dl/${ASSET}`) && srv.hits.includes(`/files/${ASSET}`), 'the asset came through the redirect');
    const rec = UPD.readRecord(t.home);
    assert.equal(rec.pendingRestart, true);
    assert.equal(rec.version, '9.9.9');
    assert.equal(rec.from, '1.0.0');
    assert.equal(rec.ok, true);
    assert.equal(rec.attemptAt, 1000);
    assert.match(UPD.statusLine(rec), /9\.9\.9 installed/);
  } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('a checksum that does not match leaves the binary untouched and records a failure', async () => {
  const t = setup('badsum');
  const srv = await releaseServer({ sums: `${sha(Buffer.from('something else'))}  ${ASSET}\n` });
  try {
    const out = await UPD.checkAndRecord(opts(t, srv));
    assert.equal(out.status, 'failed');
    assert.match(out.message, /does not match SHA256SUMS/);
    untouched(t);
    const rec = UPD.readRecord(t.home);
    assert.equal(rec.ok, false);
    assert.notEqual(rec.pendingRestart, true);
  } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('a release without this platform\'s asset, without SHA256SUMS, or without a line for the asset changes nothing', async () => {
  for (const [label, cfg, re] of [
    ['noasset', { omitAsset: true }, new RegExp(`has no ${ASSET.replace('.', '\\.')}`)],
    ['nosums', { omitSums: true }, /has no SHA256SUMS/],
    ['noline', { sums: `${sha(NEW)}  claude-wow-darwin-arm64\n` }, /no line for/],
  ]) {
    const t = setup(label);
    const srv = await releaseServer(cfg);
    try {
      const out = await UPD.checkAndRecord(opts(t, srv));
      assert.equal(out.status, 'failed', label);
      assert.match(out.message, re, label);
      assert.deepEqual(srv.downloads().filter(h => h === `/files/${ASSET}`), [], `${label}: the binary was never downloaded`);
      untouched(t);
    } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
  }
});

test('an equal, older or prerelease-of-current release is a no-op: nothing is downloaded', async () => {
  for (const [tag, version] of [['v1.0.0', '1.0.0'], ['v0.9.0', '1.0.0'], ['v1.0.0-beta.3', '1.0.0'], ['v0.5.0-beta.1', '0.5.0-beta.2']]) {
    const t = setup('same');
    const srv = await releaseServer({ tag });
    try {
      const out = await UPD.checkAndRecord(opts(t, srv, { version }));
      assert.equal(out.status, 'current', `${tag} vs ${version}: ${out.message}`);
      assert.deepEqual(srv.downloads(), []);
      untouched(t);
      assert.equal(UPD.readRecord(t.home).ok, true);
    } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
  }
});

test('a beta install updates to the release of that version', async () => {
  const t = setup('beta');
  const srv = await releaseServer({ tag: 'v0.5.0' });
  try {
    const out = await UPD.checkAndRecord(opts(t, srv, { version: '0.5.0-beta.1', probe: async file => ({ ok: true, version: file === t.binary ? '0.5.0-beta.1' : '0.5.0' }) }));
    assert.equal(out.status, 'updated', out.message);
  } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('a Homebrew keg is never swapped: it says brew upgrade and downloads nothing', async () => {
  const t = setup('brew');
  const srv = await releaseServer();
  try {
    const install = UPD.installKind({ compiled: true, execPath: '/opt/homebrew/Cellar/claude-wow/1.0.0/bin/claude-wow' });
    const out = await UPD.checkAndRecord(opts(t, srv, { install }));
    assert.equal(out.status, 'homebrew');
    assert.match(out.message, /brew upgrade claude-wow/);
    assert.deepEqual(srv.downloads(), []);
    untouched(t);
  } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('a checkout never self-updates and never touches the network', async () => {
  const t = setup('dev');
  const srv = await releaseServer();
  try {
    const out = await UPD.checkAndRecord(opts(t, srv, { install: UPD.installKind({ compiled: false }) }));
    assert.equal(out.status, 'refused');
    assert.match(out.message, /self-update is off/);
    assert.deepEqual(srv.hits, []);
    assert.deepEqual(UPD.readRecord(t.home), {}, 'no record written');
    untouched(t);
  } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('a binary that does not run, or says another version, is not put in place', async () => {
  for (const probe of [async () => ({ ok: false, why: 'exec format error' }), async () => ({ ok: true, version: '9.9.8' })]) {
    const t = setup('probe');
    const srv = await releaseServer();
    try {
      const out = await UPD.checkAndRecord(opts(t, srv, { probe }));
      assert.equal(out.status, 'failed');
      assert.match(out.message, /does not run|says it is 9\.9\.8/);
      untouched(t);
    } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
  }
});

test('the real probe runs the downloaded file and reads its version', { skip: !POSIX }, async () => {
  for (const [printed, status] of [['9.9.9', 'updated'], ['9.9.8', 'failed']]) {
    const t = setup('realprobe');
    const body = Buffer.from(`#!/bin/sh\necho "claude-wow ${printed} (fake)"\n`);
    const srv = await releaseServer({ body });
    try {
      const out = await UPD.checkAndRecord(opts(t, srv, { probe: UPD.probeBinary }));
      assert.equal(out.status, status, out.message);
      if (status === 'updated') assert.deepEqual(fs.readFileSync(t.binary), body);
      else untouched(t);
    } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
  }
});

test('network bounds: a download over the size limit, a silent server and a redirect loop fail without touching the binary', async () => {
  const t = setup('bounds');
  for (const [chunked, re] of [[false, /16 bytes, more than the 4 allowed/], [true, /passed the 4 bytes allowed/]]) {
    const srv = await releaseServer({ chunked });
    try {
      const limits = { ...UPD.LIMITS, asset: { maxBytes: 4, timeoutMs: 5000, idleMs: 5000 } };
      const out = await UPD.checkAndRecord(opts(t, srv, { limits }));
      assert.equal(out.status, 'failed');
      assert.match(out.message, re);
      untouched(t);
    } finally { await srv.close(); }
  }
  const silent = await serve(() => {});
  try {
    const limits = { ...UPD.LIMITS, json: { maxBytes: 1024, timeoutMs: 400, idleMs: 300 } };
    const started = Date.now();
    const out = await UPD.checkAndRecord(opts(t, silent, { limits }));
    assert.equal(out.status, 'failed');
    assert.match(out.message, /no data for|timed out/);
    assert.ok(Date.now() - started < 3000, 'it gave up in time');
    assert.equal(UPD.readRecord(t.home).ok, false);
  } finally { await silent.close(); }
  const loop = await serve((req, res) => { res.writeHead(302, { Location: req.url }); res.end(); });
  try {
    const out = await UPD.checkAndRecord(opts(t, loop));
    assert.match(out.message, /too many redirects/);
    assert.equal(loop.hits.length, 6);
    untouched(t);
  } finally { await loop.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('Windows swap: the running exe is renamed aside, the new one takes its name, and the copy is cleaned at the next start', () => {
  const t = setup('win');
  const tmp = path.join(t.bin, '.new.exe');
  fs.writeFileSync(tmp, NEW);
  UPD.replaceFile(tmp, t.binary, 'win32');
  assert.deepEqual(fs.readFileSync(t.binary), NEW);
  assert.deepEqual(fs.readFileSync(`${t.binary}.old`), OLD);
  assert.equal(fs.existsSync(tmp), false);
  assert.equal(UPD.cleanupAside(t.install, 'win32'), 1);
  assert.deepEqual(fs.readdirSync(t.bin), [path.basename(t.binary)]);
  fs.rmSync(t.dir, { recursive: true, force: true });
});

function releasesRoot(label) {
  const root = fs.realpathSync(tmpDir(label));
  const l = REL.layout(root);
  const add = (name, meta) => {
    const file = path.join(root, `.src-${name}`);
    fs.writeFileSync(file, OLD, { mode: 0o755 });
    REL.installRelease(l, { name, binaryFile: file, meta });
    fs.rmSync(file);
    return REL.releaseBinary(l, name);
  };
  return { root, l, add };
}

test('releases layout: a published release updates through installAndActivate: a new releases/<version>/, current flipped, previous kept for rollback', { skip: !POSIX }, async () => {
  const { root, l, add } = releasesRoot('releases');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const oldBin = add('1.0.0', { source: REL.SOURCE_RELEASE });
  REL.activate(l, '1.0.0');
  const install = UPD.installKind({ compiled: true, execPath: REL.currentBinary(l) });
  assert.equal(install.kind, 'releases', install.why);
  assert.equal(UPD.launchPath({ compiled: true, execPath: oldBin }), REL.currentBinary(l));
  const srv = await releaseServer();
  try {
    const out = await UPD.checkAndRecord({ home, version: '1.0.0', api: `${srv.base}/repos/x`, install, platform: PLATFORM, arch: ARCH, probe: async () => ({ ok: true, version: '9.9.9' }) });
    assert.equal(out.status, 'updated', out.message);
    assert.equal(REL.currentName(l), '9.9.9');
    assert.equal(REL.previousName(l), '1.0.0', 'claude-wow dev rollback can go back');
    assert.deepEqual(fs.readFileSync(REL.releaseBinary(l, '9.9.9')), NEW);
    assert.equal(REL.releaseInfo(l, '9.9.9').source, REL.SOURCE_SELF_UPDATE);
    assert.equal(REL.releaseInfo(l, '9.9.9').sha256, sha(NEW));
    assert.deepEqual(fs.readFileSync(oldBin), OLD, 'the old release stays');
    assert.equal(UPD.readRecord(home).binary, REL.currentBinary(l));
    assert.deepEqual(fs.readdirSync(l.releases).filter(n => !n.startsWith('.')).sort(), ['1.0.0', '9.9.9'], 'no temp file left');
    assert.equal(UPD.installKind({ compiled: true, execPath: REL.currentBinary(l) }).kind, 'releases', 'a self-updated release updates again');
    assert.equal(fs.existsSync(l.lock), false, 'the deploy lock is released');
  } finally { await srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('releases layout: while a deploy holds deploy.lock, self-update switches nothing and says who holds it', { skip: !POSIX }, async () => {
  const { root, l, add } = releasesRoot('locked');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  add('1.0.0', { source: REL.SOURCE_RELEASE });
  REL.activate(l, '1.0.0');
  const install = UPD.installKind({ compiled: true, execPath: REL.currentBinary(l) });
  const deploy = REL.acquireLock(l.lock, { command: 'dev deploy' });
  const srv = await releaseServer();
  try {
    const out = await UPD.checkAndRecord({ home, version: '1.0.0', api: `${srv.base}/repos/x`, install, platform: PLATFORM, arch: ARCH, probe: async () => ({ ok: true, version: '9.9.9' }) });
    assert.equal(out.status, 'failed');
    assert.match(out.message, /another deploy holds .*dev deploy/);
    assert.equal(REL.currentName(l), '1.0.0');
    assert.equal(REL.hasRelease(l, '9.9.9'), false);
    assert.notEqual(UPD.readRecord(home).pendingRestart, true);
    assert.ok(fs.existsSync(l.lock), 'the deploy keeps its lock');
    assert.deepEqual(fs.readdirSync(l.releases).filter(n => n.startsWith('.')), [], 'no temp file left');
  } finally { deploy.release(); await srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('releases layout: an E-style dev deploy (0.5.0-beta.1-abc123def456) is never self-updated, though its name parses as semver', { skip: !POSIX }, async () => {
  const DEV = '0.5.0-beta.1-abc123def456';
  assert.ok(UPD.parseSemver(DEV), 'the name is a valid semver prerelease, so a name rule alone cannot tell');
  for (const [label, meta] of [['tagged', { source: REL.SOURCE_DEV_DEPLOY, sha: 'abc123def456', version: '0.5.0-beta.1' }], ['untagged', { sha: 'abc123def456', version: '0.5.0-beta.1' }]]) {
    const { root, l, add } = releasesRoot(`dev-${label}`);
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    add(DEV, meta);
    REL.activate(l, DEV);
    const install = UPD.installKind({ compiled: true, execPath: REL.currentBinary(l) });
    assert.equal(install.kind, 'dev', label);
    assert.match(install.why, new RegExp(`releases/${DEV.replace(/\./g, '\\.')} is not a published release`));
    const srv = await releaseServer();
    try {
      const out = await UPD.checkAndRecord({ home, version: '0.5.0-beta.1', api: `${srv.base}/repos/x`, install, platform: PLATFORM, arch: ARCH, probe: async () => ({ ok: true, version: '9.9.9' }) });
      assert.equal(out.status, 'refused', label);
      assert.deepEqual(srv.hits, [], `${label}: no network`);
      assert.equal(REL.currentName(l), DEV);
    } finally { await srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('releases layout: a release with no release.json, or a published one while current points at a dev deploy, is not self-updated', { skip: !POSIX }, () => {
  const { root, l, add } = releasesRoot('mixed');
  const bare = path.join(l.releases, '1.0.0');
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, REL.BINARY), OLD, { mode: 0o755 });
  fs.symlinkSync(path.join(REL.RELEASES_DIR, '1.0.0'), l.current);
  assert.equal(UPD.installKind({ compiled: true, execPath: REL.currentBinary(l) }).kind, 'dev', 'no release.json');
  fs.rmSync(l.current);
  const published = add('2.0.0', { source: REL.SOURCE_RELEASE });
  add('2.0.0-abc123def456', { source: REL.SOURCE_DEV_DEPLOY });
  REL.activate(l, '2.0.0-abc123def456');
  const install = UPD.installKind({ compiled: true, execPath: published });
  assert.equal(install.kind, 'dev', 'running a published release, but the supervisor would restart onto the dev deploy');
  assert.match(install.why, /2\.0\.0-abc123def456/);
  REL.activate(l, '2.0.0');
  assert.equal(UPD.installKind({ compiled: true, execPath: published }).kind, 'releases');
  fs.rmSync(root, { recursive: true, force: true });
});

test('releases layout: under deploy.lock the update looks at current again, so a newer release or a dev deploy that landed meanwhile is never replaced', { skip: !POSIX }, async () => {
  for (const [label, landed, meta] of [['newer release', '10.0.0', { source: REL.SOURCE_RELEASE, version: '10.0.0' }], ['same version', '9.9.9-other', { source: REL.SOURCE_SELF_UPDATE, version: '9.9.9' }], ['dev deploy', '0.5.0-beta.1-abc123def456', { source: REL.SOURCE_DEV_DEPLOY, version: '0.5.0-beta.1' }]]) {
    const { root, l, add } = releasesRoot(`race-${label.replace(/ /g, '-')}`);
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    add('1.0.0', { source: REL.SOURCE_RELEASE, version: '1.0.0' });
    REL.activate(l, '1.0.0');
    const install = UPD.installKind({ compiled: true, execPath: REL.currentBinary(l) });
    assert.equal(install.kind, 'releases');
    add(landed, meta);
    const srv = await releaseServer();
    try {
      const probe = async () => { REL.activate(l, landed); return { ok: true, version: '9.9.9' }; };
      const out = await UPD.checkAndRecord({ home, version: '1.0.0', api: `${srv.base}/repos/x`, install, platform: PLATFORM, arch: ARCH, probe });
      assert.equal(out.status, 'skipped', `${label}: ${out.message}`);
      assert.equal(REL.currentName(l), landed, `${label}: current is left where the other install put it`);
      assert.equal(REL.hasRelease(l, '9.9.9'), false, `${label}: nothing was installed`);
      assert.notEqual(UPD.readRecord(home).pendingRestart, true, `${label}: no restart is asked for`);
      assert.equal(fs.existsSync(l.lock), false, `${label}: the lock is released`);
    } finally { await srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

function withPatched(obj, name, wrap, fn) {
  const original = obj[name];
  obj[name] = wrap(original);
  return Promise.resolve().then(fn).finally(() => { obj[name] = original; });
}

test('releases layout: a deploy.lock taken over before the switch stops the update; nothing is activated', { skip: !POSIX }, async () => {
  const { root, l, add } = releasesRoot('stolen');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  add('1.0.0', { source: REL.SOURCE_RELEASE, version: '1.0.0' });
  REL.activate(l, '1.0.0');
  const install = UPD.installKind({ compiled: true, execPath: REL.currentBinary(l) });
  const srv = await releaseServer();
  try {
    let stolen = false;
    const steal = original => (...args) => {
      if (!stolen && fs.existsSync(l.lock)) {
        stolen = true;
        fs.writeFileSync(l.lock, JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now(), command: 'dev deploy', token: 'f'.repeat(32), phase: 'preparing' }));
      }
      return original(...args);
    };
    const out = await withPatched(REL, 'currentName', steal, () => UPD.checkAndRecord({ home, version: '1.0.0', api: `${srv.base}/repos/x`, install, platform: PLATFORM, arch: ARCH, probe: async () => ({ ok: true, version: '9.9.9' }) }));
    assert.ok(stolen, 'the lock was taken over inside the locked window');
    assert.equal(out.status, 'failed', out.message);
    assert.equal(REL.currentName(l), '1.0.0');
    assert.equal(REL.hasRelease(l, '9.9.9'), false);
  } finally { await srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a skip written while the download ran (a rollback meanwhile) is honored under the lock, in both layouts', async () => {
  const t = setup('skiplate');
  const srv = await releaseServer();
  try {
    const probe = async file => { if (file !== t.binary) UPD.skipVersion(t.home, '9.9.9', 'dev rollback meanwhile'); return { ok: true, version: file === t.binary ? '1.0.0' : '9.9.9' }; };
    const out = await UPD.checkAndRecord(opts(t, srv, { probe }));
    assert.equal(out.status, 'skipped', out.message);
    assert.match(out.message, /9\.9\.9 is skipped/);
    untouched(t);
  } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
  if (!POSIX) return;
  const { root, l, add } = releasesRoot('skiplate-rel');
  add('1.0.0', { source: REL.SOURCE_RELEASE, version: '1.0.0' });
  REL.activate(l, '1.0.0');
  const install = UPD.installKind({ compiled: true, execPath: REL.currentBinary(l) });
  const srv2 = await releaseServer();
  try {
    const probe = async () => { UPD.skipVersion(l.base, '9.9.9', 'dev rollback meanwhile'); return { ok: true, version: '9.9.9' }; };
    const out = await UPD.checkAndRecord({ home: l.base, version: '1.0.0', api: `${srv2.base}/repos/x`, install, platform: PLATFORM, arch: ARCH, probe });
    assert.equal(out.status, 'skipped', out.message);
    assert.equal(REL.currentName(l), '1.0.0');
    assert.equal(REL.hasRelease(l, '9.9.9'), false);
  } finally { await srv2.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('plain binary: the swap takes a lock next to the binary and checks the installed version again, so it never puts an older binary over a newer one', async () => {
  const t = setup('plainlock');
  const srv = await releaseServer();
  try {
    const probe = async file => ({ ok: true, version: file === t.binary ? '10.0.0' : '9.9.9' });
    const out = await UPD.checkAndRecord(opts(t, srv, { probe }));
    assert.equal(out.status, 'skipped', out.message);
    assert.match(out.message, /10\.0\.0/);
    untouched(t);
    const other = REL.acquireLock(UPD.binaryLockFile(t.binary), { command: 'claude-wow update to 9.9.9', pid: process.pid });
    try {
      const busy = await UPD.checkAndRecord(opts(t, srv));
      assert.equal(busy.status, 'failed', busy.message);
      assert.match(busy.message, /holds/);
      assert.deepEqual(fs.readFileSync(t.binary), OLD, 'a second update while one holds the lock replaces nothing');
    } finally { other.release(); }
    const ok = await UPD.checkAndRecord(opts(t, srv));
    assert.equal(ok.status, 'updated', ok.message);
    assert.equal(fs.existsSync(UPD.binaryLockFile(t.binary)), false, 'the lock is released');
  } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('releases layout: a prune error after the switch is reported in the outcome, the update still counts', { skip: !POSIX }, async () => {
  const { root, l, add } = releasesRoot('pruneerr');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  add('1.0.0', { source: REL.SOURCE_RELEASE, version: '1.0.0' });
  REL.activate(l, '1.0.0');
  const install = UPD.installKind({ compiled: true, execPath: REL.currentBinary(l) });
  const srv = await releaseServer();
  try {
    const activate = async (...args) => ({ ...(await REL.installAndActivate(...args)), pruneError: 'EACCES on releases/0.1.0' });
    const out = await UPD.checkAndRecord({ home, version: '1.0.0', api: `${srv.base}/repos/x`, install, platform: PLATFORM, arch: ARCH, probe: async () => ({ ok: true, version: '9.9.9' }), activate });
    assert.equal(out.status, 'updated', out.message);
    assert.match(out.message, /old releases were not pruned \(EACCES on releases\/0\.1\.0\)/);
    assert.match(UPD.readRecord(home).message, /not pruned/);
  } finally { await srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a partial download left by a dead process, or one older than the limit, is removed; a fresh one of a live process is kept', async () => {
  const t = setup('stale');
  const dead = path.join(t.bin, `.${ASSET}.update-999999-deadbeef`);
  const old = path.join(t.bin, `.${ASSET}.update-${process.pid}-0badf00d`);
  const fresh = path.join(t.bin, `.${ASSET}.update-${process.pid}-c0ffee00`);
  const unrelated = path.join(t.bin, '.keep-me');
  for (const f of [dead, old, fresh, unrelated]) fs.writeFileSync(f, 'partial');
  const longAgo = new Date(Date.now() - UPD.STALE_DOWNLOAD_MS - 60000);
  fs.utimesSync(old, longAgo, longAgo);
  const srv = await releaseServer({ tag: 'v1.0.0' });
  try {
    const out = await UPD.checkAndRecord(opts(t, srv, { alive: pid => pid === process.pid }));
    assert.equal(out.status, 'current', out.message);
    assert.deepEqual(fs.readdirSync(t.bin).sort(), [path.basename(fresh), '.keep-me', path.basename(t.binary)].sort());
  } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('a skipped version (after dev rollback) is not reinstalled by the daily check until a newer one is out; claude-wow update installs it and lifts the skip', async () => {
  const t = setup('skip');
  UPD.skipVersion(t.home, '9.9.9', 'dev rollback from releases/9.9.9');
  assert.deepEqual(UPD.readSkip(t.home).version, '9.9.9');
  const srv = await releaseServer();
  try {
    const daily = await UPD.checkAndRecord(opts(t, srv));
    assert.equal(daily.status, 'skipped', daily.message);
    assert.match(daily.message, /9\.9\.9 is skipped \(dev rollback from releases\/9\.9\.9\)/);
    assert.deepEqual(srv.downloads(), []);
    untouched(t);
    assert.equal(UPD.readRecord(t.home).ok, true, 'a skip is not a failure, so no hourly retry');
    const lines = [];
    assert.equal(await UPD.main(['--check'], { ...opts(t, srv), out: l => lines.push(l), err: l => lines.push(l) }), 0);
    assert.match(lines.join('\n'), /skipped/);
    untouched(t);
    assert.equal(await UPD.main([], { ...opts(t, srv), out: l => lines.push(l), err: l => lines.push(l) }), 0);
    assert.deepEqual(fs.readFileSync(t.binary), NEW, 'the explicit command installs the skipped version');
    assert.equal(UPD.readSkip(t.home), null, 'and lifts the skip');
  } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
  const t2 = setup('skipnewer');
  UPD.skipVersion(t2.home, '9.9.8', 'dev rollback');
  const srv2 = await releaseServer();
  try {
    const out = await UPD.checkAndRecord(opts(t2, srv2));
    assert.equal(out.status, 'updated', `a release newer than the skipped one installs: ${out.message}`);
  } finally { await srv2.close(); fs.rmSync(t2.dir, { recursive: true, force: true }); }
});

test('skipRelease reads the version a rolled-back release carries, for dev rollback to call', { skip: !POSIX }, () => {
  const { root, l, add } = releasesRoot('skiprel');
  add('9.9.9', { source: REL.SOURCE_SELF_UPDATE, version: '9.9.9' });
  add('0.5.0-beta.1-abc123def456', { source: REL.SOURCE_DEV_DEPLOY, version: '0.5.0-beta.1' });
  assert.equal(UPD.skipRelease(l, '9.9.9', 'dev rollback').version, '9.9.9');
  assert.equal(UPD.readSkip(l.base).version, '9.9.9');
  assert.equal(UPD.skipRelease(l, '0.5.0-beta.1-abc123def456', 'dev rollback'), null, 'a dev deploy is not a release, so nothing is skipped');
  assert.equal(UPD.readSkip(l.base).version, '9.9.9');
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkDue: a day after a good check, an hour after a failed one, and at once with no record', () => {
  const now = 10 * UPD.DAY_MS;
  assert.equal(UPD.checkDue({}, now), true);
  assert.equal(UPD.checkDue({ attemptAt: now - UPD.DAY_MS + 1, ok: true }, now), false);
  assert.equal(UPD.checkDue({ attemptAt: now - UPD.DAY_MS, ok: true }, now), true);
  assert.equal(UPD.checkDue({ attemptAt: now - UPD.HOUR_MS + 1, ok: false }, now), false);
  assert.equal(UPD.checkDue({ attemptAt: now - UPD.HOUR_MS, ok: false }, now), true);
  assert.equal(UPD.checkDue({ attemptAt: now + 5000, ok: true }, now), true, 'a clock that went back does not stop the checks');
});

function fakeTimers() {
  const calls = [];
  return {
    calls,
    timers: {
      setTimeout: (fn, ms) => { calls.push({ kind: 'timeout', fn, ms }); return { unref() {} }; },
      setInterval: (fn, ms) => { calls.push({ kind: 'interval', fn, ms }); return { unref() {} }; },
    },
  };
}

test('autoUpdate false: no daily check is scheduled or run, the restart gate still runs', async () => {
  const home = tmpDir('off');
  let checks = 0;
  const logs = [];
  const ft = fakeTimers();
  const u = UPD.createUpdater({ home, cfg: { autoUpdate: false }, log: l => logs.push(l), version: '1.0.0', install: { kind: 'binary', binary: '/x/claude-wow' }, check: async () => { checks++; return { message: 'x' }; }, timers: ft.timers });
  u.start();
  assert.deepEqual(ft.calls.map(c => [c.kind, c.ms]), [['interval', UPD.RESTART_TICK_MS]]);
  assert.equal(await u.checkTick(), null);
  assert.equal(checks, 0);
  assert.ok(logs.some(l => /daily check is off/.test(l)));
  const on = UPD.createUpdater({ home, cfg: {}, version: '1.0.0', install: { kind: 'binary', binary: '/x/claude-wow' }, check: async () => { checks++; return { message: 'checked' }; }, timers: fakeTimers().timers });
  await on.checkTick();
  assert.equal(checks, 1, 'the same updater with autoUpdate on does check');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a dev bridge schedules no check and never calls the network', async () => {
  const home = tmpDir('devtick');
  let checks = 0;
  const logs = [];
  const ft = fakeTimers();
  const u = UPD.createUpdater({ home, log: l => logs.push(l), version: '1.0.0', install: UPD.installKind({ compiled: false }), check: async () => { checks++; return {}; }, timers: ft.timers });
  u.start();
  assert.deepEqual(ft.calls.map(c => c.ms), [UPD.RESTART_TICK_MS]);
  assert.equal(await u.checkTick(), null);
  assert.equal(checks, 0);
  assert.ok(logs.some(l => /self-update: off \(running from source/.test(l)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('a failed check keeps the daily timer: it is retried an hour later', async () => {
  const t = setup('retry');
  const srv = await serve((req, res) => { res.writeHead(500); res.end(); });
  let now = 50 * UPD.DAY_MS;
  const logs = [];
  try {
    const ft = fakeTimers();
    const u = UPD.createUpdater({ home: t.home, version: '1.0.0', install: t.install, api: `${srv.base}/repos/x`, now: () => now, log: l => logs.push(l), timers: ft.timers });
    u.start();
    const scheduled = ft.calls.filter(c => c.ms === UPD.CHECK_TICK_MS);
    assert.equal(scheduled.length, 1);
    const first = await scheduled[0].fn();
    assert.equal(first.status, 'failed');
    assert.equal(srv.hits.length, 1);
    now += 30 * 60000;
    assert.equal(await scheduled[0].fn(), null, 'not due yet');
    assert.equal(srv.hits.length, 1);
    now += 31 * 60000;
    const second = await scheduled[0].fn();
    assert.equal(second.status, 'failed');
    assert.equal(srv.hits.length, 2, 'the same timer checked again');
    assert.ok(logs.filter(l => /HTTP 500/.test(l)).length === 2);
  } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('restart verdict: never while busy or right after a message; at once when the game is closed; after the idle time otherwise', () => {
  const IDLE = { idle: true, reason: 'nothing' };
  const BUSY = { idle: false, reason: '1 agent run(s) in flight (#4)' };
  const base = { record: { pendingRestart: true, version: '9.9.9' }, version: '1.0.0', now: 1e9, idleMs: 600000, supervised: true, lastActivityAt: 1e9 - 700000, gameRunning: true, idle: IDLE };
  assert.equal(UPD.restartVerdict(base).restart, true, 'idle long enough with the game open');
  const busy = UPD.restartVerdict({ ...base, idle: BUSY });
  assert.equal(busy.code, 'busy');
  assert.equal(busy.why, BUSY.reason, 'the idle probe\'s reason is what gets logged');
  assert.equal(UPD.restartVerdict({ ...base, idle: BUSY, gameRunning: false }).restart, false, 'a run in flight blocks even with the game closed');
  assert.equal(UPD.restartVerdict({ ...base, idle: null }).restart, false, 'no idle answer counts as busy');
  assert.equal(UPD.restartVerdict({ ...base, lastActivityAt: 1e9 - 5000, gameRunning: false }).code, 'recent');
  assert.equal(UPD.restartVerdict({ ...base, lastActivityAt: 1e9 - 60000, gameRunning: false }).code, 'closed');
  assert.equal(UPD.restartVerdict({ ...base, lastActivityAt: 1e9 - 60000, gameRunning: true }).code, 'active');
  assert.equal(UPD.restartVerdict({ ...base, lastActivityAt: 1e9 - 60000, gameRunning: null }).code, 'active');
  assert.equal(UPD.restartVerdict({ ...base, gameRunning: null }).code, 'idle', 'a platform that cannot tell whether the game runs restarts on quiet time alone');
  assert.equal(UPD.restartVerdict({ ...base, gameRunning: () => null }).restart, true);
  assert.equal(UPD.restartVerdict({ ...base, supervised: false }).code, 'manual');
  assert.equal(UPD.restartVerdict({ ...base, record: { pendingRestart: true, version: '1.0.0' } }).restart, false, 'no restart onto the same version');
  assert.equal(UPD.restartVerdict({ ...base, record: { pendingRestart: true, version: '9.9.9', restartFrom: '1.0.0' } }).code, 'tried');
  assert.equal(UPD.restartVerdict({ ...base, record: {} }).pending, false);
  let asked = 0;
  UPD.restartVerdict({ ...base, idle: BUSY, gameRunning: () => { asked++; return false; } });
  assert.equal(asked, 0, 'no process scan while busy');
});

test('the restart gate defers while a run is in flight, then restarts once when idle, and never twice', () => {
  const home = tmpDir('gate');
  UPD.writeRecord(home, { pendingRestart: true, version: '9.9.9', from: '1.0.0', attemptAt: 1 });
  let busy = 1;
  let restarts = 0;
  const logs = [];
  const idle = () => (busy ? { idle: false, reason: `${busy} message(s) running or queued` } : { idle: true, reason: 'none' });
  const u = UPD.createUpdater({ home, version: '1.0.0', supervised: true, cfg: { autoUpdateIdleSeconds: 60 }, idle, lastActivityAt: () => 0, now: () => 1e9, gameRunning: () => false, restart: () => restarts++, log: l => logs.push(l), install: { kind: 'binary', binary: '/x' }, timers: fakeTimers().timers });
  assert.equal(u.restartTick().code, 'busy');
  assert.equal(u.restartTick().code, 'busy');
  assert.equal(restarts, 0);
  assert.equal(logs.filter(l => /restart waits: 1 message/.test(l)).length, 1, 'the wait is logged once');
  busy = 0;
  assert.equal(u.restartTick().restart, true);
  assert.equal(restarts, 1);
  assert.equal(UPD.readRecord(home).restartFrom, '1.0.0');
  assert.equal(u.restartTick().restart, false);
  assert.equal(restarts, 1, 'a restart that did not bring the new version does not loop');
  fs.rmSync(home, { recursive: true, force: true });
});

test('at start: a bridge on the new version clears pendingRestart; one still on the old version after the restart gives up', () => {
  const home = tmpDir('settle');
  const logs = [];
  UPD.writeRecord(home, { pendingRestart: true, version: '9.9.9', from: '1.0.0' });
  assert.equal(UPD.createUpdater({ home, version: '9.9.9', log: l => logs.push(l), install: { kind: 'binary', binary: '/x' } }).settleRecord(), 'running');
  assert.equal(UPD.readRecord(home).pendingRestart, false);
  assert.match(logs.pop(), /now running 9\.9\.9 \(updated from 1\.0\.0\)/);
  UPD.writeRecord(home, { pendingRestart: true, version: '9.9.9', restartFrom: '1.0.0' });
  assert.equal(UPD.createUpdater({ home, version: '1.0.0', log: l => logs.push(l), install: { kind: 'binary', binary: '/x' } }).settleRecord(), 'tried');
  assert.equal(UPD.readRecord(home).pendingRestart, false);
  assert.match(logs.pop(), /still 1\.0\.0/);
  UPD.writeRecord(home, { pendingRestart: true, version: '9.9.9', restartFrom: null });
  assert.equal(UPD.createUpdater({ home, version: '1.0.0', install: { kind: 'binary', binary: '/x' } }).settleRecord(), 'pending');
  assert.equal(UPD.readRecord(home).pendingRestart, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a pending update counts as the current version: the next check does not download it again', async () => {
  const t = setup('pending');
  UPD.writeRecord(t.home, { pendingRestart: true, version: '9.9.9' });
  const srv = await releaseServer();
  try {
    const out = await UPD.checkAndRecord(opts(t, srv));
    assert.equal(out.status, 'current', out.message);
    assert.deepEqual(srv.downloads(), []);
  } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('claude-wow update: --check only reports, the plain command installs, unknown options are usage errors', async () => {
  const t = setup('cli');
  const srv = await releaseServer();
  const lines = [];
  const errs = [];
  const deps = { ...opts(t, srv), out: l => lines.push(l), err: l => errs.push(l) };
  try {
    assert.equal(await UPD.main(['--check'], deps), 0);
    assert.match(lines.join('\n'), /9\.9\.9 is out \(this is 1\.0\.0\); run claude-wow update/);
    untouched(t);
    assert.equal(await UPD.main([], deps), 0);
    assert.match(lines.join('\n'), /updated claude-wow 1\.0\.0 to 9\.9\.9/);
    assert.deepEqual(fs.readFileSync(t.binary), NEW);
    assert.equal(await UPD.main(['--now'], deps), 2);
    assert.match(errs.join('\n'), /unknown option "--now"/);
    assert.equal(await UPD.main([], { ...deps, install: UPD.installKind({ compiled: false }) }), 3);
  } finally { await srv.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});
