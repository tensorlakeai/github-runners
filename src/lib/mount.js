'use strict';

// Privileged helpers for the cache mount. The mount daemon runs as root, so
// its tools are reached through passwordless sudo, which Tensorlake runners
// grant to the job user. `sudo -n` fails fast instead of prompting.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PREFETCH_TIMEOUT_SECONDS = 180;

function tlBinary() {
  if (fs.existsSync('/usr/local/bin/tl')) return '/usr/local/bin/tl';
  const found = spawnSync('sh', ['-c', 'command -v tl'], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : null;
}

function sudoAvailable() {
  return spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 5000 }).status === 0;
}

// Starts a detached prefetch that outlives this step, writing its exit code
// to `<marker>` when it ends.
function startPrefetch(target, marker, log) {
  const tl = tlBinary();
  if (!tl || !sudoAvailable()) return false;
  const script = 'timeout "$1" sudo -n "$2" fs prefetch "$3"; echo $? > "$4.tmp" && mv "$4.tmp" "$4"';
  const output = fs.openSync(log, 'a');
  const child = spawn('bash', ['-c', script, 'prefetch', String(PREFETCH_TIMEOUT_SECONDS), tl, target, marker], {
    detached: true,
    stdio: ['ignore', output, output],
  });
  child.unref();
  fs.closeSync(output);
  return true;
}

async function waitForPrefetch(marker, timeoutSeconds = PREFETCH_TIMEOUT_SECONDS) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      return Number(fs.readFileSync(marker, 'utf8').trim());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return null;
}

function prefetch(targets) {
  const tl = tlBinary();
  if (!tl || !sudoAvailable() || targets.length === 0) return null;
  const result = spawnSync('sudo', ['-n', tl, 'fs', 'prefetch', ...targets], {
    encoding: 'utf8',
    timeout: PREFETCH_TIMEOUT_SECONDS * 1000,
  });
  const line = `${result.stdout || ''}${result.stderr || ''}`.split('\n').filter((item) => /Prefetched|phases/.test(item));
  return { status: result.status, detail: line.join(' ').slice(0, 400) };
}

function prefetchSummary(log) {
  try {
    return fs.readFileSync(log, 'utf8').split('\n').filter((line) => /Prefetched/.test(line)).pop() || '';
  } catch {
    return '';
  }
}

// Blocks until writes to the mount are published, so a cache saved at the end
// of a job survives runner teardown. Returns { status, output }.
function waitForUpload(mountpoint, timeoutSeconds) {
  if (!sudoAvailable()) return { status: 'unavailable', output: 'passwordless sudo is unavailable' };
  spawnSync('sync', [], { stdio: 'ignore', timeout: 60000 });
  const script = path.join(__dirname, '..', 'mount-sync.js');
  const result = spawnSync('sudo', ['-n', process.execPath, script, mountpoint, String(timeoutSeconds)], {
    encoding: 'utf8',
    timeout: (timeoutSeconds + 15) * 1000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status === 0) return { status: 'published', output };
  if (result.status === 3) return { status: 'unavailable', output };
  return { status: 'pending', output };
}

module.exports = { prefetch, prefetchSummary, startPrefetch, waitForPrefetch, waitForUpload };
