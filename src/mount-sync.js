'use strict';

// Runs as root (via sudo) and waits until everything written to the cache
// mount so far is published. It uses the logical-v1 daemon control socket the
// runner's own end-of-job publication uses: `seal` returns a watermark and
// `dirty` reports the published one. No Tensorlake login is involved.
//
// Usage: node mount-sync.js <mountpoint> <timeout-seconds> [mounts-directory]
// Exit codes: 0 published, 1 not published before the deadline, 3 no control
// socket for this mount (for example a mount that is not logical-v1).

const fs = require('fs');
const net = require('net');
const path = require('path');

const [mountpoint, timeoutArgument, mountsArgument] = process.argv.slice(2);
const mounts = mountsArgument || '/root/.local/share/tensorlake/mounts';
const deadline = Date.now() + Number(timeoutArgument || 180) * 1000;
const CALL_TIMEOUT_MS = 10000;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function controlDirectory() {
  let entries;
  try {
    entries = fs.readdirSync(mounts, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries.slice(0, 64)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(mounts, entry.name, 'state.json'), 'utf8'));
      if (state.mountpoint === mountpoint) return path.join(mounts, entry.name);
    } catch {
      // Not a mount session directory.
    }
  }
  return null;
}

function control(directory, op) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(directory, 'control.sock'));
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${op} timed out`));
    }, Math.max(1, Math.min(CALL_TIMEOUT_MS, deadline - Date.now())));
    socket.on('connect', () => socket.write(`${JSON.stringify({ op })}\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString();
      const end = data.indexOf('\n');
      if (end === -1) {
        if (data.length > 256 * 1024) socket.destroy(new Error('response too large'));
        return;
      }
      clearTimeout(timer);
      socket.end();
      try {
        const value = JSON.parse(data.slice(0, end));
        if (value.ok !== true) throw new Error(`${op} was rejected`);
        resolve(value);
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A busy daemon can answer slowly while it uploads; retry each call until the
// overall deadline instead of giving up on the first slow reply.
async function retrying(directory, op) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await control(directory, op);
    } catch (error) {
      lastError = error;
      await pause(500);
    }
  }
  throw lastError || new Error(`${op} deadline`);
}

async function main() {
  const directory = controlDirectory();
  if (!directory) {
    log(`no logical-v1 control socket for ${mountpoint}`);
    process.exit(3);
  }
  const ping = await retrying(directory, 'ping');
  if (ping.engine !== 'logical-v1') {
    log(`unsupported mount engine ${ping.engine}`);
    process.exit(3);
  }
  const started = Date.now();
  const target = (await retrying(directory, 'seal')).pending_watermark;
  if (typeof target !== 'number') throw new Error('seal returned no watermark');
  let reported = 0;
  while (Date.now() < deadline) {
    const published = (await retrying(directory, 'dirty')).logical_watermarks?.published;
    if (typeof published === 'number' && published >= target) {
      log(`published in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return;
    }
    if (Date.now() - reported > 5000) {
      reported = Date.now();
      log(`waiting for upload: watermark ${published ?? 'none'} of ${target}, ${Math.round((deadline - Date.now()) / 1000)}s left`);
    }
    await pause(250);
  }
  log('upload still pending at the deadline');
  process.exit(1);
}

main().catch((error) => {
  log(`sync failed: ${error.message}`);
  process.exit(1);
});
