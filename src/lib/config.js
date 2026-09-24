'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const core = require('./core');

// Bump to abandon every existing entry after an incompatible layout change.
const LAYOUT = 'tensorlake-cache-v2';
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

// Every branch and pull request saves to its own ref; merge queue refs are
// temporary, so those runs only restore.
function saveDecision(mode) {
  if (mode === 'true') return { save: true, reason: 'save: true' };
  if (mode === 'false') return { save: false, reason: 'save: false' };
  if (mode !== 'auto') throw new Error(`Input save must be auto, true, or false, got "${mode}".`);
  const event = process.env.GITHUB_EVENT_NAME || '';
  if (event === 'merge_group') return { save: false, reason: 'merge queue runs only restore' };
  if (!process.env.GITHUB_REF) return { save: false, reason: 'the run has no ref' };
  return { save: true, reason: process.env.GITHUB_REF };
}

// Where a job looks for a cache, in order: its own ref, a pull request's base
// branch, then the default branch. It only ever writes to its own ref.
function refs(defaultBranch) {
  const own = process.env.GITHUB_REF || '';
  const base = process.env.GITHUB_BASE_REF ? `refs/heads/${process.env.GITHUB_BASE_REF}` : '';
  const fallback = defaultBranch ? `refs/heads/${defaultBranch}` : '';
  return [...new Set([own, base, fallback].filter(Boolean))];
}

function load() {
  const root = cacheRoot();
  const defaultBranch = core.getInput('default-branch', '') || readEvent().repository?.default_branch || '';
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
    ref: process.env.GITHUB_REF || '',
    refs: refs(defaultBranch),
    defaultRef: defaultBranch ? `refs/heads/${defaultBranch}` : '',
    prefetch: core.getBooleanInput('prefetch', true),
    syncTimeout,
  };
}

module.exports = { LANGUAGES, LAYOUT, load, parseLanguages, refs, saveDecision, sha256 };
