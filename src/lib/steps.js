'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./config');
const core = require('./core');
const languages = require('./languages');
const mount = require('./mount');
const store = require('./store');

const CUSTOM = 'custom';

function seconds(started) {
  return `${((Date.now() - started) / 1000).toFixed(1)}s`;
}

function size(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function prefetchFiles(cfg) {
  const base = path.join(process.env.RUNNER_TEMP || os.tmpdir(), `tensorlake-cache-${cfg.scope}`);
  return { started: `${base}.prefetch-started`, done: `${base}.prefetch-done`, log: `${base}.prefetch.log` };
}

function expand(item, workingDirectory) {
  if (item === '~' || item.startsWith('~/')) return path.join(os.homedir(), item.slice(1));
  return path.resolve(workingDirectory, item);
}

// One unit per language plus one for the `paths` input.
function units(cfg) {
  const markers = languages.findMarkers(cfg.workingDirectory);
  const selected = cfg.languages === 'auto' ? languages.detect(cfg.workingDirectory) : cfg.languages;
  const result = selected.map((language) => ({
    language,
    spec: languages.SPECS[language],
    markers: markers[language],
    directory: path.join(cfg.scopeDirectory, language),
  }));
  if (cfg.paths.length > 0) {
    result.push({
      language: CUSTOM,
      spec: {
        configure: () => ({}),
        paths: () => cfg.paths.map((item) => ({ path: expand(item, cfg.workingDirectory) })),
        afterRestore() {},
        version: () => JSON.stringify(cfg.paths),
      },
      // Custom paths refresh whenever any detected lockfile changes.
      markers: Object.values(markers).flat().sort(),
      directory: path.join(cfg.scopeDirectory, CUSTOM),
    });
  }
  return result;
}

function unitKey(cfg, unit) {
  const files = unit.markers.map((file) => [
    path.relative(cfg.workingDirectory, file),
    config.sha256(fs.readFileSync(file)),
  ]);
  return config.sha256(JSON.stringify([config.LAYOUT, unit.language, cfg.key, files, unit.spec.version()]));
}

// Before any step: warm the scope's archives on the mount in the background,
// so the download overlaps checkout and toolchain setup.
function pre() {
  const cfg = config.load();
  if (!cfg.root || !cfg.prefetch || !fs.existsSync(cfg.scopeDirectory)) return;
  const files = prefetchFiles(cfg);
  if (mount.startPrefetch(cfg.scopeDirectory, files.done, files.log)) {
    fs.writeFileSync(files.started, '');
    core.info('Started prefetching the Tensorlake cache in the background.');
  }
}

async function restore() {
  const cfg = config.load();
  if (!cfg.root) {
    core.notice('No Tensorlake cache volume is mounted on this runner (TENSORLAKE_CACHE_DIR is unset); building without a persistent cache.');
    core.setOutput('restored', '');
    return;
  }
  const selected = units(cfg);
  core.saveState('enabled', 'true');
  // Save exactly what was restored: files created by the build (for example a
  // generated lockfile) must not add a cache that no later restore reads.
  core.saveState('units', JSON.stringify(selected.map((unit) => unit.language)));
  core.setOutput('languages', selected.map((unit) => unit.language).join(','));
  if (selected.length === 0) {
    core.info('No Rust, Node.js, Go or Python project found; set `languages` or `paths` to cache something else.');
    return;
  }

  for (const unit of selected) {
    for (const [name, value] of Object.entries(unit.spec.configure())) core.exportVariable(name, value);
  }

  const started = Date.now();
  const candidates = selected.map((unit) => ({ unit, found: store.find(unit.directory) }));
  const files = prefetchFiles(cfg);
  if (fs.existsSync(files.started)) {
    const code = await mount.waitForPrefetch(files.done);
    core.info(`Background prefetch ${code === 0 ? 'finished' : `ended with ${code}`} after ${seconds(started)}. ${mount.prefetchSummary(files.log)}`);
  } else if (cfg.prefetch) {
    const entries = candidates.filter((item) => item.found.found).map((item) => item.found.entry);
    if (entries.length > 0) {
      const code = mount.prefetch(entries);
      core.info(`Prefetch ${code === 0 ? 'finished' : 'skipped'} in ${seconds(started)}.`);
    }
  }

  const restored = {};
  const rows = [];
  for (const { unit, found } of candidates) {
    if (!found.found) {
      const message = `${unit.language}: cache miss, ${found.reason}.`;
      if (found.incomplete) core.warning(`${message} A previous job's upload did not finish before its runner stopped.`);
      else core.info(message);
      rows.push(`| ${unit.language} | miss | ${found.reason} |`);
      continue;
    }
    const unitStarted = Date.now();
    try {
      await store.restore(found);
    } catch (error) {
      core.warning(`${unit.language}: restore failed (${error.message}); building cold.`);
      rows.push(`| ${unit.language} | failed | ${error.message.slice(0, 200)} |`);
      continue;
    }
    unit.spec.afterRestore(core);
    restored[unit.language] = found.manifest.key;
    const detail = `${size(found.manifest.bytes)} in ${found.manifest.shards.length} shard(s), saved ${found.manifest.created}`;
    core.info(`${unit.language}: restored ${detail} in ${seconds(unitStarted)}.`);
    rows.push(`| ${unit.language} | hit | ${detail} |`);
  }
  core.saveState('restored', JSON.stringify(restored));
  core.setOutput('restored', Object.keys(restored).join(','));
  core.info(`Tensorlake cache restore took ${seconds(started)}.`);
  core.summary(['### Tensorlake cache restore', '', '| Cache | Result | Detail |', '|---|---|---|', ...rows, '']);
}

async function save() {
  if (core.getState('enabled') !== 'true') return;
  const cfg = config.load();
  if (!cfg.root) return;
  const decision = config.saveDecision(cfg.save, cfg.defaultBranch);
  if (!decision.save) {
    core.info(`Not saving the Tensorlake cache: ${decision.reason}.`);
    return;
  }
  let restored = {};
  try {
    restored = JSON.parse(core.getState('restored') || '{}');
  } catch {
    restored = {};
  }

  let selected = [];
  try {
    selected = JSON.parse(core.getState('units') || '[]');
  } catch {
    selected = [];
  }

  const started = Date.now();
  const rows = [];
  let saved = 0;
  for (const unit of units(cfg).filter((item) => selected.includes(item.language))) {
    const key = unitKey(cfg, unit);
    if (restored[unit.language] === key) {
      core.info(`${unit.language}: unchanged since the restored entry; not saving.`);
      rows.push(`| ${unit.language} | unchanged | |`);
      continue;
    }
    if (unit.spec.beforeSave) unit.spec.beforeSave(core);
    const unitStarted = Date.now();
    const result = await store.save(unit.directory, {
      language: unit.language,
      key,
      specs: unit.spec.paths(unit.markers),
    });
    if (!result.saved) {
      core.info(`${unit.language}: ${result.reason}.`);
      rows.push(`| ${unit.language} | skipped | ${result.reason} |`);
      continue;
    }
    saved += 1;
    const detail = `${size(result.manifest.bytes)} as ${size(result.stored)} in ${result.manifest.shards.length} shard(s)`;
    core.info(`${unit.language}: saved ${detail} in ${seconds(unitStarted)}.`);
    rows.push(`| ${unit.language} | saved | ${detail} |`);
  }

  if (saved > 0 && cfg.syncTimeout > 0) {
    const waitStarted = Date.now();
    const upload = mount.waitForUpload(cfg.root, cfg.syncTimeout);
    if (upload.status === 'published') {
      core.info(`Cache upload finished in ${seconds(waitStarted)}.`);
    } else {
      core.warning(`Could not confirm the cache upload (${upload.status}): ${upload.output || 'no detail'}. The runner still publishes the cache when the job ends.`);
    }
    rows.push(`| upload | ${upload.status} | ${seconds(waitStarted)} |`);
  }
  core.info(`Tensorlake cache save took ${seconds(started)}.`);
  core.summary(['### Tensorlake cache save', '', '| Cache | Result | Detail |', '|---|---|---|', ...rows, '']);
}

module.exports = { pre, restore, save, unitKey, units };
