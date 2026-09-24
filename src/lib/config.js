'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const core = require('./core');

// Bump to abandon every existing entry after an incompatible layout change.
const LAYOUT = 'tensorlake-cache-v1';
const LANGUAGES = ['rust', 'node', 'go', 'python'];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cacheRoot() {
  const root = process.env.TENSORLAKE_CACHE_DIR;
  if (!root) return null;
  try {
    if (!fs.statSync(root).isDirectory()) return null;
    return fs.realpathSync(root);
  } catch {
    return null;
  }
}

function parseLanguages(value) {
  if (value === 'auto') return 'auto';
  if (value === 'none') return [];
  const requested = value
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => ({ ts: 'node', js: 'node', typescript: 'node', javascript: 'node', golang: 'go', uv: 'python' })[item] || item);
  for (const language of requested) {
    if (!LANGUAGES.includes(language)) {
      throw new Error(`Unsupported language "${language}". Use auto, none, or any of: ${LANGUAGES.join(', ')}.`);
    }
  }
  return [...new Set(requested)];
}

function workflowIdentity() {
  // owner/repo/.github/workflows/ci.yml@refs/heads/main -> drop the ref so
  // every branch of one workflow shares entries.
  const ref = process.env.GITHUB_WORKFLOW_REF || process.env.GITHUB_WORKFLOW || '';
  return ref.replace(/@.*$/, '');
}

function readEvent() {
  try {
    return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// Only default-branch runs publish: pull requests restore but never write, so
// untrusted branches cannot seed what the default branch later restores.
function saveDecision(mode, defaultBranchInput) {
  if (mode === 'true') return { save: true, reason: 'save: true' };
  if (mode === 'false') return { save: false, reason: 'save: false' };
  if (mode !== 'auto') throw new Error(`Input save must be auto, true, or false, got "${mode}".`);

  const event = process.env.GITHUB_EVENT_NAME || '';
  if (event.startsWith('pull_request') || event === 'merge_group') {
    return { save: false, reason: `${event} runs only restore` };
  }
  const defaultBranch = defaultBranchInput || readEvent().repository?.default_branch || '';
  if (!defaultBranch) return { save: false, reason: 'default branch unknown' };
  const ref = process.env.GITHUB_REF || '';
  if (ref !== `refs/heads/${defaultBranch}`) {
    return { save: false, reason: `only ${defaultBranch} saves (this run is ${ref || 'unknown'})` };
  }
  return { save: true, reason: `${defaultBranch} branch` };
}

function load() {
  const root = cacheRoot();
  const workingDirectory = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd(), core.getInput('working-directory', '.'));
  const key = core.getInput('key', '');
  const languages = parseLanguages(core.getInput('languages', 'auto'));
  const scope = sha256(JSON.stringify([
    process.env.GITHUB_REPOSITORY || '',
    workflowIdentity(),
    process.env.GITHUB_JOB || '',
    path.relative(process.env.GITHUB_WORKSPACE || process.cwd(), workingDirectory),
    key,
  ])).slice(0, 20);
  const syncTimeout = Number(core.getInput('sync-timeout', '180'));
  if (!Number.isFinite(syncTimeout) || syncTimeout < 0) throw new Error('Input sync-timeout must be a number of seconds.');

  return {
    root,
    scopeDirectory: root ? path.join(root, LAYOUT, scope) : null,
    scope,
    key,
    languages,
    paths: core.getInput('paths', '').split('\n').map((item) => item.trim()).filter(Boolean),
    workingDirectory,
    save: core.getInput('save', 'auto').toLowerCase(),
    defaultBranch: core.getInput('default-branch', ''),
    prefetch: core.getBooleanInput('prefetch', true),
    syncTimeout,
  };
}

module.exports = { LANGUAGES, LAYOUT, load, parseLanguages, saveDecision, sha256 };
