'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'target', 'vendor', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', '.turbo',
]);
const MAX_DEPTH = 4;

// Files that mark a project and, together with toolchain versions, form the
// save key. A changed key means new dependencies, so the entry is refreshed.
// Manifests (Cargo.toml, package.json, pyproject.toml) cover projects that
// don't commit a lockfile, such as Rust libraries.
const MARKERS = {
  rust: ['Cargo.lock', 'Cargo.toml', 'rust-toolchain', 'rust-toolchain.toml'],
  node: ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package.json'],
  go: ['go.mod', 'go.sum', 'go.work', 'go.work.sum'],
  python: ['uv.lock', 'poetry.lock', 'Pipfile.lock', 'pylock.toml', 'requirements.txt', 'pyproject.toml'],
};
// A marker that alone does not make a language present.
const SECONDARY = new Set(['rust-toolchain', 'rust-toolchain.toml', 'go.sum', 'go.work.sum']);

function findMarkers(root) {
  const found = Object.fromEntries(Object.keys(MARKERS).map((language) => [language, []]));
  const byName = new Map();
  for (const [language, names] of Object.entries(MARKERS)) {
    for (const name of names) byName.set(name, language);
  }
  const visit = (directory, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRECTORIES.has(entry.name)) visit(full, depth + 1);
      } else if (entry.isFile()) {
        const language = byName.get(entry.name) || (/^requirements.*\.txt$/.test(entry.name) ? 'python' : null);
        if (language) found[language].push(full);
      }
    }
  };
  visit(root, 0);
  for (const files of Object.values(found)) files.sort();
  return found;
}

function detect(root) {
  const markers = findMarkers(root);
  return Object.keys(MARKERS).filter((language) =>
    markers[language].some((file) => !SECONDARY.has(path.basename(file))));
}

function home(...parts) {
  return path.join(os.homedir(), ...parts);
}

function commandOutput(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      // Corepack would otherwise ask before downloading a package manager.
      env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    }).trim();
  } catch {
    return '';
  }
}

function hasMarker(markers, name) {
  return markers.some((file) => path.basename(file) === name);
}

function named(markers, name) {
  return markers.filter((file) => path.basename(file) === name);
}

// The directory where each project's cache is configured: the shallowest
// marker, since workspace members sit below the root.
function projectDirectory(markers, names) {
  const candidates = markers.filter((file) => names.includes(path.basename(file)));
  if (candidates.length === 0) return undefined;
  const depth = (file) => file.split(path.sep).length;
  return path.dirname(candidates.reduce((best, file) => (depth(file) < depth(best) ? file : best)));
}

// Asks the package manager for its cache location, falling back to its
// documented default when the tool is not installed.
function toolPath(command, args, cwd, fallback) {
  const reported = commandOutput(command, args, cwd).split('\n').pop();
  return reported && path.isAbsolute(reported) && reported !== 'undefined' ? reported : fallback;
}

// Each spec lists local directories. They are archived after the build and
// extracted to local disk before it, so nothing reads the mount while tools run.
const SPECS = {
  rust: {
    configure() {
      if (!process.env.CARGO_INCREMENTAL) return { CARGO_INCREMENTAL: '0' };
      return {};
    },
    paths(markers) {
      const cargoHome = process.env.CARGO_HOME || home('.cargo');
      const rustupHome = process.env.RUSTUP_HOME || home('.rustup');
      const lockfiles = named(markers, 'Cargo.lock');
      const roots = lockfiles.length > 0
        ? lockfiles.map((file) => path.dirname(file))
        : [projectDirectory(markers, ['Cargo.toml'])].filter(Boolean);
      const targets = process.env.CARGO_TARGET_DIR
        ? [process.env.CARGO_TARGET_DIR]
        : roots.map((root) => path.join(root, 'target'));
      return [
        { path: path.join(cargoHome, 'registry', 'index') },
        { path: path.join(cargoHome, 'registry', 'cache') },
        { path: path.join(cargoHome, 'git', 'db') },
        { path: path.join(cargoHome, 'bin') },
        { path: path.join(cargoHome, '.crates.toml') },
        { path: path.join(cargoHome, '.crates2.json') },
        // Restoring the toolchain saves the rustup install on every job.
        { path: rustupHome, excludeTop: ['downloads', 'tmp'] },
        // Incremental data is disabled above and only bloats the archive.
        ...targets.map((target) => ({ path: target, excludeAny: ['incremental'] })),
      ];
    },
    afterRestore(core) {
      const bin = path.join(process.env.CARGO_HOME || home('.cargo'), 'bin');
      if (fs.existsSync(path.join(bin, 'rustup')) || fs.existsSync(path.join(bin, 'cargo'))) core.addPath(bin);
    },
    version() {
      return commandOutput('rustc', ['-vV']);
    },
  },
  node: {
    configure() {
      return {};
    },
    paths(markers) {
      const cwd = projectDirectory(markers, MARKERS.node);
      const paths = [];
      const pnpm = hasMarker(markers, 'pnpm-lock.yaml');
      const yarn = hasMarker(markers, 'yarn.lock');
      const bun = hasMarker(markers, 'bun.lock') || hasMarker(markers, 'bun.lockb');
      // npm also covers projects without a lockfile.
      if ((!pnpm && !yarn && !bun) || hasMarker(markers, 'package-lock.json') || hasMarker(markers, 'npm-shrinkwrap.json')) {
        paths.push({ path: path.join(toolPath('npm', ['config', 'get', 'cache'], cwd, home('.npm')), '_cacache') });
      }
      if (pnpm) {
        const fallback = process.env.PNPM_HOME ? path.join(process.env.PNPM_HOME, 'store') : home('.local', 'share', 'pnpm', 'store');
        paths.push({ path: toolPath('pnpm', ['store', 'path'], cwd, fallback) });
      }
      if (yarn) {
        // Yarn 2+ answers `config get cacheFolder`; Yarn 1 answers `cache dir`.
        const berry = toolPath('yarn', ['config', 'get', 'cacheFolder'], cwd, '');
        paths.push({ path: berry || toolPath('yarn', ['cache', 'dir'], cwd, home('.cache', 'yarn')) });
        paths.push({ path: home('.yarn', 'berry', 'cache') });
      }
      if (bun) {
        paths.push({ path: toolPath('bun', ['pm', 'cache'], cwd, process.env.BUN_INSTALL_CACHE_DIR || home('.bun', 'install', 'cache')) });
      }
      return paths;
    },
    afterRestore() {},
    version() {
      // Package manager caches are content-addressed and version independent.
      return '';
    },
  },
  go: {
    configure() {
      return {
        GOMODCACHE: process.env.GOMODCACHE || home('go', 'pkg', 'mod'),
        GOCACHE: process.env.GOCACHE || home('.cache', 'go-build'),
      };
    },
    paths() {
      return [
        { path: process.env.GOMODCACHE || home('go', 'pkg', 'mod') },
        { path: process.env.GOCACHE || home('.cache', 'go-build') },
        { path: process.env.GOLANGCI_LINT_CACHE || home('.cache', 'golangci-lint') },
      ];
    },
    afterRestore() {},
    version() {
      return commandOutput('go', ['env', 'GOVERSION']);
    },
  },
  python: {
    configure() {
      return {};
    },
    paths(markers) {
      const paths = [{ path: process.env.PIP_CACHE_DIR || home('.cache', 'pip') }];
      if (hasMarker(markers, 'uv.lock') || commandOutput('uv', ['--version'])) {
        paths.push({ path: process.env.UV_CACHE_DIR || home('.cache', 'uv') });
        // Interpreters installed by `uv python install`.
        paths.push({ path: process.env.UV_PYTHON_INSTALL_DIR || home('.local', 'share', 'uv', 'python') });
      }
      if (hasMarker(markers, 'poetry.lock')) paths.push({ path: home('.cache', 'pypoetry') });
      return paths;
    },
    beforeSave(core) {
      // Drops wheels uv can rebuild cheaply, as uv recommends for CI caches.
      try {
        execFileSync('uv', ['cache', 'prune', '--ci'], { stdio: 'ignore', timeout: 60000 });
        core.info('Pruned the uv cache for CI.');
      } catch {
        // uv is not installed or has no cache; nothing to prune.
      }
    },
    afterRestore() {},
    version() {
      return '';
    },
  },
};

module.exports = { MARKERS, SPECS, detect, findMarkers };
