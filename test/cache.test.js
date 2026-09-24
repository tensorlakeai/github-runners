'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');

const archive = require('../src/lib/archive');
const config = require('../src/lib/config');
const languages = require('../src/lib/languages');
const steps = require('../src/lib/steps');
const store = require('../src/lib/store');

const saved = { ...process.env };
let sandbox;

function write(file, contents = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

// Reads GitHub's `name<<delimiter` file-command format.
function readCommands(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  const lines = fs.readFileSync(file, 'utf8').split(os.EOL);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([^<]+)<<(.+)$/.exec(lines[index]);
    if (!match) continue;
    const body = [];
    for (index += 1; lines[index] !== match[2]; index += 1) body.push(lines[index]);
    values[match[1]] = body.join(os.EOL);
  }
  return values;
}

// Simulates one job: a fresh home, workspace and runner files, sharing the
// cache volume across calls.
function job({ event = 'push', ref = 'refs/heads/main', base = '', inputs = {} } = {}) {
  const id = fs.mkdtempSync(path.join(sandbox, 'job-'));
  const home = path.join(id, 'home');
  const workspace = path.join(id, 'workspace');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  for (const name of Object.keys(process.env)) {
    if (/^(INPUT_|STATE_|GITHUB_|CARGO_|RUSTUP_|GO|npm_config_)/.test(name)) delete process.env[name];
  }
  const eventPath = path.join(id, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: 'main' } }));
  Object.assign(process.env, {
    HOME: home,
    TENSORLAKE_CACHE_DIR: path.join(sandbox, 'volume'),
    GITHUB_WORKSPACE: workspace,
    GITHUB_REPOSITORY: 'acme/app',
    GITHUB_WORKFLOW_REF: `acme/app/.github/workflows/ci.yml@${ref}`,
    GITHUB_JOB: 'build',
    GITHUB_EVENT_NAME: event,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REF: ref,
    ...(base ? { GITHUB_BASE_REF: base } : {}),
    GITHUB_ENV: path.join(id, 'env'),
    GITHUB_PATH: path.join(id, 'path'),
    GITHUB_OUTPUT: path.join(id, 'output'),
    GITHUB_STATE: path.join(id, 'state'),
    GITHUB_STEP_SUMMARY: path.join(id, 'summary'),
    RUNNER_TEMP: id,
    'INPUT_PREFETCH': 'false',
    'INPUT_SYNC-TIMEOUT': '0',
  });
  for (const [name, value] of Object.entries(inputs)) process.env[`INPUT_${name.toUpperCase()}`] = value;
  return {
    home,
    workspace,
    async restore() {
      await steps.restore();
      for (const [name, value] of Object.entries(readCommands(process.env.GITHUB_STATE))) process.env[`STATE_${name}`] = value;
      return readCommands(process.env.GITHUB_OUTPUT);
    },
    save: () => steps.save(),
  };
}

function rustProject(current) {
  write(path.join(current.workspace, 'Cargo.toml'), '[package]\nname = "app"\n');
  write(path.join(current.workspace, 'Cargo.lock'), 'version = 4\n');
  write(path.join(current.home, '.cargo', 'registry', 'cache', 'index', 'serde-1.0.crate'), 'crate');
  write(path.join(current.home, '.cargo', 'bin', 'cargo'), '#!/bin/sh\n');
  write(path.join(current.home, '.rustup', 'toolchains', 'stable', 'bin', 'rustc'), 'rustc');
  write(path.join(current.home, '.rustup', 'downloads', 'partial'), 'skip me');
  const deps = path.join(current.workspace, 'target', 'debug', 'deps');
  write(path.join(deps, 'libserde.rlib'), 'rlib'.repeat(1000));
  write(path.join(current.workspace, 'target', 'debug', 'incremental', 'app', 'query-cache.bin'), 'skip me');
  fs.symlinkSync('deps/libserde.rlib', path.join(current.workspace, 'target', 'debug', 'libserde.rlib'));
  write(path.join(current.workspace, 'target', 'debug', 'build', 'app-1234', 'output'), 'cargo:rerun-if-changed=src');
  return path.join(current.workspace, 'target', 'debug', 'build');
}

function unitDirectory(language) {
  const scopes = path.join(sandbox, 'volume', config.LAYOUT);
  const [scope] = fs.readdirSync(scopes);
  return path.join(scopes, scope, language);
}

function entries(language, ref = 'refs/heads/main') {
  const directory = store.refDirectory(unitDirectory(language), ref);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => /^\d+-/.test(name));
}

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tensorlake-cache-test-')));
  fs.mkdirSync(path.join(sandbox, 'volume'));
});

afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
  // Go-style read-only trees need write permission back before removal.
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('detects languages from lockfiles and ignores dependency directories', () => {
  const root = path.join(sandbox, 'repo');
  write(path.join(root, 'Cargo.lock'));
  write(path.join(root, 'web', 'pnpm-lock.yaml'));
  write(path.join(root, 'services', 'api', 'go.mod'));
  write(path.join(root, 'node_modules', 'pkg', 'uv.lock'));
  write(path.join(root, 'tools', 'requirements-dev.txt'));
  assert.deepEqual(languages.detect(root), ['rust', 'node', 'go', 'python']);
  write(path.join(sandbox, 'only-sum', 'go.sum'));
  assert.deepEqual(languages.detect(path.join(sandbox, 'only-sum')), []);
});

test('parses language lists and aliases', () => {
  assert.equal(config.parseLanguages('auto'), 'auto');
  assert.deepEqual(config.parseLanguages('none'), []);
  assert.deepEqual(config.parseLanguages('TypeScript, golang rust'), ['node', 'go', 'rust']);
  assert.throws(() => config.parseLanguages('cobol'), /Unsupported language/);
});

test('saves from every ref except merge queue runs', () => {
  const cases = [
    ['push', 'refs/heads/main', 'auto', true],
    ['push', 'refs/heads/feature', 'auto', true],
    ['pull_request', 'refs/pull/1/merge', 'auto', true],
    ['merge_group', 'refs/heads/gh-readonly-queue/main/pr-1', 'auto', false],
    ['merge_group', 'refs/heads/gh-readonly-queue/main/pr-1', 'true', true],
    ['push', 'refs/heads/main', 'false', false],
  ];
  for (const [event, ref, mode, expected] of cases) {
    job({ event, ref });
    assert.equal(config.saveDecision(mode).save, expected, `${event} ${ref} ${mode}`);
  }
});

test('looks up the own ref, then the base branch, then the default branch', () => {
  job({ event: 'pull_request', ref: 'refs/pull/7/merge', base: 'release/1.2' });
  assert.deepEqual(config.refs('main'), ['refs/pull/7/merge', 'refs/heads/release/1.2', 'refs/heads/main']);
  job({ event: 'pull_request', ref: 'refs/pull/8/merge', base: 'main' });
  assert.deepEqual(config.refs('main'), ['refs/pull/8/merge', 'refs/heads/main']);
  job({ ref: 'refs/heads/main' });
  assert.deepEqual(config.refs('main'), ['refs/heads/main']);
  job({ ref: 'refs/heads/feature' });
  assert.deepEqual(config.refs(''), ['refs/heads/feature']);
});

test('balances shards by size', () => {
  const files = [900, 500, 400, 300, 200, 100].map((size, index) => ({ path: `f${index}`, size }));
  const shards = archive.plan(files, 1000);
  assert.equal(shards.length, 3);
  assert.deepEqual(shards.map((shard) => shard.bytes).sort((a, b) => a - b), [700, 800, 900]);
  assert.equal(archive.plan([{ path: 'small', size: 10 }]).length, 1);
  const mib = 1024 * 1024;
  const many = (count, size) => Array.from({ length: count }, (_, index) => ({ path: `m${index}`, size }));
  assert.equal(archive.plan(many(25, 10 * mib)).length, 3, '250 MiB still downloads in parallel');
  assert.equal(archive.plan(many(100, 10 * mib)).length, 4);
  assert.equal(archive.plan(many(400, 10 * mib)).length, 16);
});

// zstd-node is the path on runners without a zstd binary, like today's image.
for (const variant of ['zstd', 'zstd-node', 'gzip']) {
  test(`round-trips a Rust cache with ${variant}, keeping mtimes and symlinks`, async () => {
    process.env.TENSORLAKE_CACHE_CODEC = variant.replace('-node', '');
    if (variant === 'zstd-node') process.env.TENSORLAKE_CACHE_CODEC_IMPL = 'node';
    const first = job();
    const buildDirectory = rustProject(first);
    const past = new Date('2026-01-02T03:04:05Z');
    fs.utimesSync(buildDirectory, past, past);
    const cold = await first.restore();
    assert.equal(cold.languages, 'rust');
    assert.equal(cold.restored, '');
    await first.save();
    assert.equal(entries('rust').length, 1);

    // The next job gets a fresh machine at the same absolute paths.
    fs.rmSync(path.join(first.home, '.cargo'), { recursive: true });
    fs.rmSync(path.join(first.home, '.rustup'), { recursive: true });
    fs.rmSync(path.join(first.workspace, 'target'), { recursive: true });
    const warm = await first.restore();
    assert.equal(warm.restored, 'rust');
    const deps = path.join(first.workspace, 'target', 'debug');
    assert.equal(fs.readFileSync(path.join(deps, 'deps', 'libserde.rlib'), 'utf8'), 'rlib'.repeat(1000));
    assert.equal(fs.readlinkSync(path.join(deps, 'libserde.rlib')), 'deps/libserde.rlib');
    assert.equal(fs.statSync(buildDirectory).mtimeMs, past.getTime());
    assert.ok(fs.existsSync(path.join(first.home, '.rustup', 'toolchains', 'stable', 'bin', 'rustc')));
    assert.ok(!fs.existsSync(path.join(deps, 'incremental')), 'incremental output is not cached');
    assert.ok(!fs.existsSync(path.join(first.home, '.rustup', 'downloads')), 'rustup downloads are not cached');
    assert.match(fs.readFileSync(process.env.GITHUB_PATH, 'utf8'), /\.cargo\/bin/);
    assert.match(fs.readFileSync(process.env.GITHUB_ENV, 'utf8'), /CARGO_INCREMENTAL/);
  });
}

test('skips unchanged saves and refreshes when the lockfile changes', async () => {
  const first = job();
  rustProject(first);
  await first.restore();
  await first.save();
  const [original] = entries('rust');

  await first.restore();
  await first.save();
  assert.deepEqual(entries('rust'), [original], 'an unchanged key does not save again');

  fs.writeFileSync(path.join(first.workspace, 'Cargo.lock'), 'version = 4\n# new dependency\n');
  await first.restore();
  await first.save();
  assert.equal(entries('rust').length, 2, 'the previous entry is kept briefly for concurrent readers');
});

test('pull requests start from the default branch and save to their own ref', async () => {
  const main = job();
  rustProject(main);
  await main.restore();
  await main.save();
  const mainEntries = entries('rust');

  // Unchanged dependencies: restore main's entry and write nothing.
  const pr = job({ event: 'pull_request', ref: 'refs/pull/7/merge', base: 'main' });
  rustProject(pr);
  assert.equal((await pr.restore()).restored, 'rust');
  await pr.save();
  assert.deepEqual(entries('rust', 'refs/pull/7/merge'), []);

  // A dependency change saves once, to the pull request's ref only.
  const changed = job({ event: 'pull_request', ref: 'refs/pull/7/merge', base: 'main' });
  rustProject(changed);
  write(path.join(changed.workspace, 'Cargo.lock'), 'version = 4\n# pr change\n');
  await changed.restore();
  await changed.save();
  assert.equal(entries('rust', 'refs/pull/7/merge').length, 1);
  assert.deepEqual(entries('rust'), mainEntries, 'main is never written by a pull request');

  // The next run of the pull request restores its own entry and doesn't save again.
  const next = job({ event: 'pull_request', ref: 'refs/pull/7/merge', base: 'main' });
  rustProject(next);
  write(path.join(next.workspace, 'Cargo.lock'), 'version = 4\n# pr change\n');
  assert.equal((await next.restore()).restored, 'rust');
  await next.save();
  assert.equal(entries('rust', 'refs/pull/7/merge').length, 1);
  assert.match(fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8'), /from this ref/);

  // The default branch never restores another ref's entry.
  const later = job();
  rustProject(later);
  await later.restore();
  assert.match(fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8'), /from this ref/);
});

test('merge queue runs restore without saving', async () => {
  const main = job();
  rustProject(main);
  await main.restore();
  await main.save();
  const queue = job({ event: 'merge_group', ref: 'refs/heads/gh-readonly-queue/main/pr-7-abc' });
  rustProject(queue);
  write(path.join(queue.workspace, 'Cargo.lock'), 'version = 4\n# queued change\n');
  assert.equal((await queue.restore()).restored, 'rust');
  await queue.save();
  assert.deepEqual(entries('rust', 'refs/heads/gh-readonly-queue/main/pr-7-abc'), []);
});

test('expires refs unused for a week, never the default branch', async () => {
  for (const ref of ['refs/heads/main', 'refs/heads/stale', 'refs/heads/active']) {
    const current = job({ ref });
    rustProject(current);
    // Each branch changes dependencies, so each saves its own entry.
    write(path.join(current.workspace, 'Cargo.lock'), `version = 4\n# ${ref}\n`);
    await current.restore();
    await current.save();
  }
  const directory = unitDirectory('rust');
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  for (const ref of ['refs/heads/main', 'refs/heads/stale']) {
    fs.utimesSync(path.join(store.refDirectory(directory, ref), 'latest'), old, old);
  }
  store.expire(directory, ['refs/heads/main', 'refs/heads/active']);
  assert.equal(entries('rust', 'refs/heads/main').length, 1);
  assert.equal(entries('rust', 'refs/heads/active').length, 1);
  assert.deepEqual(entries('rust', 'refs/heads/stale'), []);
});

test('treats a partially uploaded entry as a miss', async () => {
  const first = job();
  rustProject(first);
  await first.restore();
  await first.save();
  const [name] = entries('rust');
  const entry = path.join(store.refDirectory(unitDirectory('rust'), 'refs/heads/main'), name);
  const shard = fs.readdirSync(entry).find((file) => file.startsWith('shard-'));
  fs.truncateSync(path.join(entry, shard), 3);

  const next = job();
  rustProject(next);
  const output = await next.restore();
  assert.equal(output.restored, '');
});

test('builds normally when no cache volume is mounted', async () => {
  const current = job();
  delete process.env.TENSORLAKE_CACHE_DIR;
  rustProject(current);
  assert.equal((await current.restore()).restored, '');
  await current.save();
});

test('caches Go modules with read-only files, and custom paths', async () => {
  const first = job({ inputs: { paths: '.next/cache\n~/.cache/extra' } });
  write(path.join(first.workspace, 'go.mod'), 'module example.com/app\n');
  write(path.join(first.workspace, 'go.sum'), 'example.com/dep v1 h1:abc\n');
  const module = path.join(first.home, 'go', 'pkg', 'mod', 'example.com', 'dep@v1');
  write(path.join(module, 'dep.go'), 'package dep');
  fs.chmodSync(path.join(module, 'dep.go'), 0o444);
  fs.chmodSync(module, 0o555);
  write(path.join(first.home, '.cache', 'go-build', 'ab', 'abc-d'), 'object');
  write(path.join(first.workspace, '.next', 'cache', 'webpack', 'pack'), 'next');
  write(path.join(first.home, '.cache', 'extra', 'blob'), 'extra');
  const output = await first.restore();
  assert.equal(output.languages, 'go,custom');
  const env = fs.readFileSync(process.env.GITHUB_ENV, 'utf8');
  assert.match(env, /GOMODCACHE/);
  assert.match(env, /GOCACHE/);
  await first.save();

  const second = job({ inputs: { paths: '.next/cache\n~/.cache/extra' } });
  // Same absolute paths as the first job, as on a fresh runner.
  process.env.HOME = first.home;
  process.env.GITHUB_WORKSPACE = first.workspace;
  fs.chmodSync(module, 0o755);
  fs.rmSync(path.join(first.home, 'go'), { recursive: true });
  fs.rmSync(path.join(first.workspace, '.next'), { recursive: true });
  assert.equal((await second.restore()).restored, 'go,custom');
  assert.equal(fs.readFileSync(path.join(module, 'dep.go'), 'utf8'), 'package dep');
  assert.equal(fs.statSync(module).mode & 0o777, 0o555);
  assert.ok(fs.existsSync(path.join(first.workspace, '.next', 'cache', 'webpack', 'pack')));
  fs.chmodSync(module, 0o755);
});

test('prunes superseded entries after a grace period', () => {
  const directory = path.join(sandbox, 'prune');
  fs.mkdirSync(directory);
  const now = Date.now();
  for (const name of [`${now - 3600000}-aaaa`, `${now - 60000}-bbbb`, `${now}-cccc`]) fs.mkdirSync(path.join(directory, name));
  fs.writeFileSync(path.join(directory, 'latest'), `${now}-cccc\n`);
  store.prune(directory, `${now}-cccc`, now);
  assert.deepEqual(fs.readdirSync(directory).sort(), [`${now - 60000}-bbbb`, `${now}-cccc`, 'latest'].sort());
});

function runSync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mount-sync.js'), ...args], { encoding: 'utf8' });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('waits for the mount daemon to publish sealed writes', async () => {
  // Short path: macOS limits Unix socket paths to 104 bytes.
  const mounts = fs.mkdtempSync('/tmp/tl-mounts-');
  const session = path.join(mounts, 's1');
  fs.mkdirSync(session);
  fs.writeFileSync(path.join(session, 'state.json'), JSON.stringify({ mountpoint: '/mnt/tensorlake-cache' }));
  const socketPath = path.join(session, 'control.sock');
  let polls = 0;
  const server = net.createServer((socket) => {
    socket.once('data', (data) => {
      const { op } = JSON.parse(data.toString());
      const reply = {
        ping: { ok: true, engine: 'logical-v1' },
        seal: { ok: true, pending_watermark: 42 },
        dirty: { ok: true, logical_watermarks: { published: (polls += 1) < 3 ? 40 : 42 } },
      }[op];
      // A slow first status reply must not end the wait.
      setTimeout(() => socket.end(`${JSON.stringify(reply)}\n`), op === 'dirty' && polls === 1 ? 50 : 0);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const published = await runSync(['/mnt/tensorlake-cache', '10', mounts]);
    assert.equal(published.code, 0, published.output);
    assert.ok(polls >= 3);
    const missing = await runSync(['/mnt/other', '2', mounts]);
    assert.equal(missing.code, 3);
  } finally {
    server.close();
    fs.rmSync(mounts, { recursive: true, force: true });
  }
});

test('saves only the caches selected at restore', async () => {
  const current = job();
  write(path.join(current.workspace, 'go.mod'), 'module example.com/app\n');
  write(path.join(current.home, '.cache', 'go-build', 'ab', 'abc-d'), 'object');
  assert.equal((await current.restore()).languages, 'go');
  // The build generates a Rust project; its cache was never restorable.
  rustProject(current);
  await current.save();
  const scopes = path.join(sandbox, 'volume', config.LAYOUT);
  assert.deepEqual(fs.readdirSync(path.join(scopes, fs.readdirSync(scopes)[0])), ['go']);
});

test('caches a Rust crate without a committed Cargo.lock', async () => {
  const current = job();
  write(path.join(current.workspace, 'Cargo.toml'), '[package]\nname = "lib"\n');
  write(path.join(current.workspace, 'crates', 'inner', 'Cargo.toml'), '[package]\nname = "inner"\n');
  write(path.join(current.workspace, 'target', 'debug', 'deps', 'liblib.rlib'), 'rlib');
  assert.equal((await current.restore()).languages, 'rust');
  await current.save();
  fs.rmSync(path.join(current.workspace, 'target'), { recursive: true });
  assert.equal((await current.restore()).restored, 'rust');
  assert.ok(fs.existsSync(path.join(current.workspace, 'target', 'debug', 'deps', 'liblib.rlib')));
});

const hasCargo = require('node:child_process').spawnSync('cargo', ['--version']).status === 0;

test('drops workspace crate artifacts but keeps dependencies', { skip: !hasCargo && 'cargo is not installed' }, () => {
  const root = path.join(sandbox, 'crate');
  write(path.join(root, 'Cargo.toml'), '[package]\nname = "my-app"\nversion = "0.1.0"\nedition = "2021"\n');
  write(path.join(root, 'src', 'main.rs'), 'fn main() {}\n');
  const debug = path.join(root, 'target', 'debug');
  fs.mkdirSync(path.join(debug, 'deps'), { recursive: true });
  // cargo needs the real toolchain home to answer metadata.
  const skip = languages.workspaceArtifacts([root]);
  assert.ok(skip, 'cargo metadata listed the workspace');
  const hash = '0123456789abcdef';
  const deps = path.join(debug, 'deps');
  for (const name of [`my_app-${hash}`, `my_app-${hash}.d`, `libmy_app-${hash}.rlib`]) assert.ok(skip(deps, name), name);
  assert.ok(skip(path.join(debug, '.fingerprint'), `my-app-${hash}`));
  assert.ok(skip(path.join(debug, 'build'), `my-app-${hash}`));
  assert.ok(skip(debug, 'my-app'), 'uplifted binary');
  for (const name of [`libserde-${hash}.rlib`, `my_app_utils-${hash}.rlib`, 'serde-1.0']) assert.ok(!skip(deps, name), name);
  assert.ok(!skip(path.join(root, 'elsewhere'), 'my-app'), 'uplifted names only next to deps/');
});

test('keys on lockfiles, falling back to manifests', () => {
  const locked = ['/r/Cargo.lock', '/r/Cargo.toml', '/r/crates/a/Cargo.toml', '/r/rust-toolchain.toml'];
  assert.deepEqual(steps.keyFiles(locked), ['/r/Cargo.lock', '/r/rust-toolchain.toml']);
  const unlocked = ['/r/Cargo.toml', '/r/rust-toolchain.toml'];
  assert.deepEqual(steps.keyFiles(unlocked), unlocked);
  assert.deepEqual(steps.keyFiles(['/r/go.mod', '/r/go.sum']), ['/r/go.mod', '/r/go.sum']);
  assert.deepEqual(steps.keyFiles(['/r/package.json', '/r/package-lock.json']), ['/r/package-lock.json']);
});

test('a save that succeeded survives failing cleanup', async () => {
  const directory = path.join(sandbox, 'unit');
  const ref = 'refs/heads/main';
  const cached = path.join(sandbox, 'cached');
  write(path.join(cached, 'file'), 'data');
  const first = await store.save(directory, { ref, language: 'custom', key: 'a'.repeat(64), specs: [{ path: cached }] });
  assert.ok(first.saved);
  // Listing the ref directory fails, as it did with a mount's EIO, while writes succeed.
  const refDirectory = store.refDirectory(directory, ref);
  fs.chmodSync(refDirectory, 0o300);
  try {
    const second = await store.save(directory, { ref, language: 'custom', key: 'b'.repeat(64), specs: [{ path: cached }] });
    assert.ok(second.saved);
  } finally {
    fs.chmodSync(refDirectory, 0o755);
  }
  assert.equal(store.find(refDirectory).manifest.key, 'b'.repeat(64));
});
