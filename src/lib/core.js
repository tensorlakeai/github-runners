'use strict';

// Minimal stand-ins for @actions/core so the action ships without a build
// step or node_modules. Semantics follow the runner's file-command protocol.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function getInput(name, fallback = '') {
  // The runner keeps hyphens and upper-cases the name: INPUT_SAVE-IF.
  const value = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function getBooleanInput(name, fallback) {
  const value = getInput(name, String(fallback)).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Input ${name} must be true or false, got "${value}".`);
}

function fileCommand(variable, line) {
  const file = process.env[variable];
  if (!file) return;
  fs.appendFileSync(file, line + os.EOL);
}

function delimited(name, value) {
  const delimiter = `tensorlake_${crypto.randomUUID()}`;
  return `${name}<<${delimiter}${os.EOL}${value}${os.EOL}${delimiter}`;
}

function exportVariable(name, value) {
  process.env[name] = value;
  fileCommand('GITHUB_ENV', delimited(name, value));
}

function addPath(directory) {
  process.env.PATH = `${directory}${path.delimiter}${process.env.PATH || ''}`;
  fileCommand('GITHUB_PATH', directory);
}

function setOutput(name, value) {
  fileCommand('GITHUB_OUTPUT', delimited(name, String(value)));
}

function saveState(name, value) {
  fileCommand('GITHUB_STATE', delimited(name, String(value)));
}

function getState(name) {
  return process.env[`STATE_${name}`] || '';
}

function escapeCommand(message) {
  return String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function info(message) {
  process.stdout.write(`${message}${os.EOL}`);
}

function notice(message) {
  process.stdout.write(`::notice::${escapeCommand(message)}${os.EOL}`);
}

function warning(message) {
  process.stdout.write(`::warning::${escapeCommand(message)}${os.EOL}`);
}

async function group(title, fn) {
  process.stdout.write(`::group::${escapeCommand(title)}${os.EOL}`);
  try {
    return await fn();
  } finally {
    process.stdout.write(`::endgroup::${os.EOL}`);
  }
}

function summary(lines) {
  fileCommand('GITHUB_STEP_SUMMARY', lines.join(os.EOL));
}

// Entry points never fail the job: a missing or broken cache degrades to a
// cold build, which is always correct.
function run(label, fn) {
  Promise.resolve()
    .then(fn)
    .catch((error) => {
      warning(`Tensorlake cache ${label} skipped: ${error && error.message ? error.message : error}`);
      if (process.env.TENSORLAKE_CACHE_DEBUG && error && error.stack) info(error.stack);
    });
}

module.exports = {
  addPath,
  exportVariable,
  getBooleanInput,
  getInput,
  getState,
  group,
  info,
  notice,
  run,
  saveState,
  setOutput,
  summary,
  warning,
};
