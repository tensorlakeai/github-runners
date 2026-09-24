'use strict';

// Layout under <TENSORLAKE_CACHE_DIR>/tensorlake-cache-v1/<scope>/<language>/:
//   latest                  name of the newest complete entry
//   <entry>/manifest.json   written last; lists every archive and its size
//   <entry>/shard-NN.tar.*  file contents, restored in parallel
//   <entry>/dirs.tar.*      directory entries, restored last for their mtimes
//
// An entry becomes visible only through rename, so a reader never sees a
// partial save. A size mismatch means the volume lost part of an upload.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const archive = require('./archive');

const MANIFEST = 'manifest.json';
const LATEST = 'latest';
const PRUNE_AFTER_MS = 10 * 60 * 1000;
const ABANDONED_TEMP_MS = 60 * 60 * 1000;

function writeDurable(file, contents) {
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, contents);
  archive.fsyncFile(temporary);
  fs.renameSync(temporary, file);
}

function readLatest(directory) {
  try {
    const name = fs.readFileSync(path.join(directory, LATEST), 'utf8').trim();
    return /^[0-9]+-[0-9a-f]+$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

// Returns the newest complete entry, or why none can be restored.
function find(directory) {
  const name = readLatest(directory);
  if (!name) return { found: false, reason: 'no saved entry yet' };
  const entry = path.join(directory, name);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(entry, MANIFEST), 'utf8'));
  } catch {
    return { found: false, reason: `entry ${name} has no readable manifest`, incomplete: true };
  }
  for (const item of [...manifest.shards, manifest.directories]) {
    let size;
    try {
      size = fs.statSync(path.join(entry, item.name)).size;
    } catch {
      size = -1;
    }
    if (size !== item.size) {
      return { found: false, reason: `entry ${name} is incomplete (${item.name}: ${size} of ${item.size} bytes)`, incomplete: true };
    }
  }
  if (!archive.canDecode(manifest.codec)) {
    return { found: false, reason: `entry ${name} uses ${manifest.codec}, which this runner cannot decode` };
  }
  return { found: true, name, entry, manifest };
}

async function restore(found) {
  const { entry, manifest } = found;
  await archive.mapLimit(manifest.shards, archive.parallelism(), (shard) =>
    archive.extractArchive(path.join(entry, shard.name), manifest.codec));
  // Parallel extraction touches shared directories; restoring them last puts
  // back the mtimes that build scripts (for example Cargo's) compare.
  await archive.extractArchive(path.join(entry, manifest.directories.name), manifest.codec);
}

async function save(directory, { language, key, specs, codec = archive.saveCodec(), now = Date.now() }) {
  const collected = archive.collect(specs);
  if (collected.files.length === 0) return { saved: false, reason: 'nothing to save' };

  fs.mkdirSync(directory, { recursive: true });
  const runId = `${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
  const temporary = path.join(directory, `.tmp-${runId}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(temporary);
  try {
    const suffix = archive.extension(codec);
    const shards = archive.plan(collected.files).map((shard, index) => ({
      name: `shard-${String(index).padStart(2, '0')}.${suffix}`,
      members: shard.members,
      bytes: shard.bytes,
    }));
    const directories = { name: `dirs.${suffix}`, members: collected.directories };
    await archive.mapLimit([...shards, directories], archive.parallelism(), (item) =>
      archive.createArchive(item.members, path.join(temporary, item.name), codec));

    const sized = (item) => ({ name: item.name, size: fs.statSync(path.join(temporary, item.name)).size });
    const manifest = {
      version: 1,
      language,
      key,
      codec,
      created: new Date(now).toISOString(),
      files: collected.files.length,
      bytes: collected.bytes,
      roots: collected.roots,
      shards: shards.map(sized),
      directories: sized(directories),
    };
    writeDurable(path.join(temporary, MANIFEST), JSON.stringify(manifest, null, 2));
    const name = `${now}-${key.slice(0, 12)}`;
    fs.renameSync(temporary, path.join(directory, name));
    writeDurable(path.join(directory, LATEST), `${name}\n`);
    prune(directory, name, now);
    const stored = manifest.shards.reduce((total, shard) => total + shard.size, manifest.directories.size);
    return { saved: true, name, manifest, stored };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

// Keeps the newest entry. Older ones linger briefly in case a concurrent job
// is still restoring them.
function prune(directory, keep, now = Date.now()) {
  for (const entry of fs.readdirSync(directory)) {
    if (entry === keep || entry === LATEST || entry.startsWith(`${LATEST}.tmp-`)) continue;
    const full = path.join(directory, entry);
    let age;
    if (entry.startsWith('.tmp-')) {
      try {
        age = now - fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (age < ABANDONED_TEMP_MS) continue;
    } else {
      const created = Number(entry.split('-')[0]);
      if (!Number.isFinite(created) || now - created < PRUNE_AFTER_MS) continue;
    }
    fs.rmSync(full, { recursive: true, force: true });
  }
}

module.exports = { find, prune, restore, save };
