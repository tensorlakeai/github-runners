'use strict';

// Sharded tar archives. Large sequential files are the fast path on a
// Tensorlake Cloud Volume: one multi-gigabyte file prefetches slowly and
// unevenly, many small files are slow to stat, and ~100-200 MB shards fetch
// in parallel windows.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');

// Uncompressed bytes per shard. Measured on a 1 GB warm restore, 2 and 16
// shards both prefetched in 6-8 s; small caches still get a few shards so
// their download runs in parallel.
const SHARD_TARGET_BYTES = 256 * 1024 * 1024;
const MIN_SHARD_BYTES = 64 * 1024 * 1024;
const MIN_SHARDS = 4;
const MAX_SHARDS = 16;
const CREATE_ARGS = ['-c', '-f', '-', '-C', '/', '--null', '--no-recursion', '-T', '-'];
const EXTRACT_ARGS = ['-x', '-p', '-f', '-', '-C', '/'];

let zstdPath;
function zstdBinary() {
  if (zstdPath === undefined) {
    try {
      zstdPath = execFileSync('sh', ['-c', 'command -v zstd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      zstdPath = null;
    }
  }
  return zstdPath;
}

function nodeZstd() {
  return typeof zlib.createZstdCompress === 'function';
}

function saveCodec() {
  const forced = process.env.TENSORLAKE_CACHE_CODEC;
  if (forced) return forced;
  return zstdBinary() || nodeZstd() ? 'zstd' : 'gzip';
}

function canDecode(codec) {
  if (codec === 'gzip') return true;
  if (codec === 'zstd') return Boolean(zstdBinary() || nodeZstd());
  return false;
}

function extension(codec) {
  return codec === 'zstd' ? 'tar.zst' : 'tar.gz';
}

function useBinary(codec) {
  return codec === 'zstd' && zstdBinary() && process.env.TENSORLAKE_CACHE_CODEC_IMPL !== 'node';
}

function compressor(codec) {
  if (codec === 'zstd') {
    return zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 } });
  }
  return zlib.createGzip({ level: 1 });
}

function decompressor(codec) {
  return codec === 'zstd' ? zlib.createZstdDecompress() : zlib.createGunzip();
}

function exited(child, name, okCodes = [0]) {
  let stderr = '';
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
  }
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (okCodes.includes(code)) resolve({ code, stderr });
      else reject(new Error(`${name} exited with ${signal || code}: ${stderr.trim().slice(0, 1000)}`));
    });
  });
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// GNU tar exits 1 when a file changed while it was read; the archive is still
// usable and tools revalidate their caches.
async function createArchive(members, file, codec) {
  const tar = spawn('tar', CREATE_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
  const tarDone = exited(tar, 'tar', [0, 1]);
  tar.stdin.end(Buffer.from(members.map((member) => `${member}\0`).join('')));
  const output = fs.createWriteStream(file);
  if (useBinary(codec)) {
    const zstd = spawn(zstdBinary(), ['-1', '-T1', '-q', '-c'], { stdio: ['pipe', 'pipe', 'pipe'] });
    await Promise.all([pipeline(tar.stdout, zstd.stdin), pipeline(zstd.stdout, output), tarDone, exited(zstd, 'zstd')]);
  } else {
    await Promise.all([pipeline(tar.stdout, compressor(codec), output), tarDone]);
  }
  fsyncFile(file);
}

async function extractArchive(file, codec) {
  const tar = spawn('tar', EXTRACT_ARGS, { stdio: ['pipe', 'ignore', 'pipe'] });
  const tarDone = exited(tar, 'tar');
  const input = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
  if (useBinary(codec)) {
    const zstd = spawn(zstdBinary(), ['-d', '-q', '-c'], { stdio: ['pipe', 'pipe', 'pipe'] });
    await Promise.all([pipeline(input, zstd.stdin), pipeline(zstd.stdout, tar.stdin), tarDone, exited(zstd, 'zstd')]);
  } else {
    await Promise.all([pipeline(input, decompressor(codec), tar.stdin), tarDone]);
  }
}

// Walks every root without following symlinks. Paths are relative to / so the
// archive restores to the same absolute locations on the next runner.
function collect(specs) {
  const files = [];
  const directories = [];
  const roots = [];
  for (const spec of specs) {
    let root;
    try {
      root = fs.realpathSync(spec.path);
    } catch {
      continue;
    }
    const excludeTop = new Set(spec.excludeTop || []);
    const excludeAny = new Set(spec.excludeAny || []);
    const rootStat = fs.lstatSync(root);
    roots.push(root);
    if (!rootStat.isDirectory()) {
      files.push({ path: root.slice(1), size: rootStat.size });
      continue;
    }
    const visit = (directory, depth) => {
      directories.push(directory.slice(1));
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.includes('\0')) continue;
        const full = path.join(directory, entry.name);
        if (spec.skip && spec.skip(directory, entry.name)) continue;
        if (entry.isDirectory()) {
          if ((depth === 0 && excludeTop.has(entry.name)) || excludeAny.has(entry.name)) continue;
          visit(full, depth + 1);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          let size = 0;
          try {
            size = fs.lstatSync(full).size;
          } catch {
            continue;
          }
          files.push({ path: full.slice(1), size });
        }
      }
    };
    visit(root, 0);
  }
  return { files, directories, roots, bytes: files.reduce((total, file) => total + file.size, 0) };
}

// Largest-first greedy packing keeps shards close in size, so parallel
// extraction finishes together.
function plan(files, targetBytes = Number(process.env.TENSORLAKE_CACHE_SHARD_BYTES) || SHARD_TARGET_BYTES) {
  const bytes = files.reduce((total, file) => total + file.size, 0);
  const wanted = Math.max(Math.ceil(bytes / targetBytes), Math.min(MIN_SHARDS, Math.floor(bytes / MIN_SHARD_BYTES)));
  const count = Math.max(1, Math.min(MAX_SHARDS, wanted));
  const shards = Array.from({ length: count }, () => ({ bytes: 0, members: [] }));
  for (const file of [...files].sort((a, b) => b.size - a.size)) {
    let smallest = shards[0];
    for (const shard of shards) if (shard.bytes < smallest.bytes) smallest = shard;
    smallest.members.push(file.path);
    smallest.bytes += file.size;
  }
  return shards.filter((shard) => shard.members.length > 0);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function parallelism() {
  return Math.max(2, (os.availableParallelism ? os.availableParallelism() : os.cpus().length));
}

module.exports = {
  canDecode,
  collect,
  createArchive,
  extension,
  extractArchive,
  fsyncFile,
  mapLimit,
  parallelism,
  plan,
  saveCodec,
};
