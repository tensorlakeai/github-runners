# Tensorlake GitHub Actions cache

One step that makes jobs on [Tensorlake runners](https://docs.tensorlake.ai/github-actions/quickstart)
reuse dependencies, toolchains and build outputs between runs. It detects Rust, Node.js
(JavaScript and TypeScript), Go and Python projects and needs no configuration.

```yaml
- uses: actions/checkout@v6
- uses: tensorlakeai/github-runners@v1
```

## Run jobs on Tensorlake

1. In the [Tensorlake dashboard](https://cloud.tensorlake.ai), open your project's **GitHub Actions**
   view and click **Connect GitHub**. Install the **Tensorlake GitHub Actions** App on the
   repositories that should use Tensorlake runners.
2. Set `runs-on` to a Tensorlake runner label. You don't need `self-hosted` or an API key.

   | Label | vCPUs | Memory | Disk |
   |---|---:|---:|---:|
   | `tensorlake-small` (or `tensorlake`) | 2 | 4 GiB | 10 GiB |
   | `tensorlake-medium` | 4 | 8 GiB | 50 GiB |
   | `tensorlake-large` | 8 | 16 GiB | 100 GiB |
   | `tensorlake-xlarge` | 16 | 32 GiB | 100 GiB |

   Custom sizes are in [Choose runner resources](https://docs.tensorlake.ai/github-actions/runners).
3. Add the cache step after `actions/checkout`, as in the examples below.

Every repository gets a persistent cache volume, mounted at `TENSORLAKE_CACHE_DIR`. This action
manages what goes into it.

## Examples

Put the cache step after checkout and after any setup action for the language runtime.
Turn off the setup action's own cache, which would otherwise also use GitHub's cache service.

### Rust

```yaml
jobs:
  test:
    runs-on: tensorlake-large
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v6
      - uses: tensorlakeai/github-runners@v1
      # After the cache step, so a restored toolchain is reused.
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt
      - run: cargo fmt --all -- --check
      - run: cargo clippy --locked --workspace --all-targets -- -D warnings
      - run: cargo test --locked --workspace
```

### TypeScript and JavaScript

npm, pnpm, Yarn and Bun are detected from their lockfiles.

```yaml
jobs:
  build:
    runs-on: tensorlake-medium
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          package-manager-cache: false
      - uses: tensorlakeai/github-runners@v1
      - run: npm ci
      - run: npm run build
      - run: npm test
```

With pnpm, add `- uses: pnpm/action-setup@v4` before `actions/setup-node`, then run
`pnpm install --frozen-lockfile`. To keep framework build caches too, list them in `paths`:

```yaml
      - uses: tensorlakeai/github-runners@v1
        with:
          paths: |
            .next/cache
            node_modules/.cache
```

### Go

```yaml
jobs:
  build:
    runs-on: tensorlake-medium
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-go@v6
        with:
          go-version-file: go.mod
          cache: false
      - uses: tensorlakeai/github-runners@v1
      - run: go build ./...
      - run: go test ./...
```

### Python

```yaml
jobs:
  test:
    runs-on: tensorlake-small
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
      - uses: astral-sh/setup-uv@v8
        with:
          enable-cache: false
      - uses: tensorlakeai/github-runners@v1
      - run: uv sync --locked
      - run: uv run pytest
```

pip and Poetry projects are detected from `requirements*.txt`, `poetry.lock` or `Pipfile.lock`.
With `actions/setup-python`, leave its `cache` input unset.

### Matrix jobs

Jobs share a cache when they run the same job of the same workflow. Give each matrix entry that
builds something different its own `key`:

```yaml
      - uses: tensorlakeai/github-runners@v1
        with:
          key: ${{ matrix.target }}
```

## What is cached

| Language | Detected from | Cached |
|---|---|---|
| Rust | `Cargo.lock`, or `Cargo.toml` without one | Cargo registry and git dependencies, installed binaries, the rustup toolchain, and `target` (or `CARGO_TARGET_DIR`) without incremental data or the workspace's own crates, which rebuild on every run. Sets `CARGO_INCREMENTAL=0`. |
| Node.js | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, or `package.json` | The package manager's download store, as reported by `npm`, `pnpm`, `yarn` or `bun`. `node_modules` is rebuilt from it. |
| Go | `go.mod` | The module cache (`GOMODCACHE`), the build cache (`GOCACHE`) and the golangci-lint cache. |
| Python | `uv.lock`, `poetry.lock`, `requirements*.txt`, `pyproject.toml` | The uv cache and uv-installed Pythons, the pip cache and the Poetry cache. |

Lockfiles are found up to four directories deep, so monorepos with several projects work
without extra configuration.

## How it works

Restore and save run as their own phases, so tools never touch the network-backed volume while
they build:

- **Before the job's first step**, the action starts downloading this job's cache from the volume
  in the background, while checkout and toolchain setup run.
- **At the cache step**, the archives are unpacked to local disk in parallel. Each branch and
  pull request has its own cache. A job restores its own ref's newest save; without one, a pull
  request falls back to its base branch, and anything else falls back to the default branch.
- **After the job succeeds**, the cache is saved to the job's own ref, but only if the lockfiles
  or toolchain differ from what it restored. A pull request that doesn't change dependencies
  reuses the default branch's cache and writes nothing. The action then waits, up to
  `sync-timeout`, for the mount to report the upload as published; the runner also publishes the
  volume when the job ends. Merge queue runs restore but don't save.

Each save is stored as zstd archives of up to 256 MiB, at least four for caches over 256 MiB, so
the download runs in parallel. Directory timestamps are restored last, so Cargo doesn't rerun
build scripts.

Measured with this action on `tensorlake-medium`, with random (incompressible) data:

| Cache | Warm restore | Save | Upload wait |
|---|---:|---:|---:|
| 250 MB | 2.6–4.1 s | 1.9 s | 3.3 s |
| 1 GB | 5.9–9.7 s | 4.4 s | 15–20 s |

Without the bulk prefetch, reading the same 1 GB lazily from the volume took about 70 s.

The layout follows a customer's measurements of Rust CI with a 4.7 GB target directory on
`tensorlake-large`, where they compared these hand-built setups:

| Setup | Warm job |
|---|---:|
| `CARGO_TARGET_DIR` on the cache volume | 9–11 min (slower than a cold 4 min build) |
| One 1.2 GB archive | 85–128 s |
| Eight parallel archives extracted to local disk (the layout this action uses) | 41–58 s |
| GitHub-hosted 8-core runner with `Swatinem/rust-cache` | 36–44 s |

Pointing a tool directly at `TENSORLAKE_CACHE_DIR` still works, but it's slower for any cache made
of many small files.

## Inputs

| Input | Default | Description |
|---|---|---|
| `languages` | `auto` | `auto`, `none`, or a comma list of `rust`, `node`, `go`, `python`. |
| `paths` | | Extra files or directories to cache, one per line, relative to `working-directory` or starting with `~/`. |
| `key` | | Separates caches for jobs that build different things, such as matrix entries. |
| `working-directory` | `.` | Where to search for lockfiles. |
| `save` | `auto` | `auto` saves to the job's own branch or pull request when dependencies changed, except in merge queue runs; `true` also saves in merge queue runs; `false` never saves. |
| `default-branch` | the repository's | The fallback cache for branches, and never expired. |
| `prefetch` | `true` | Download the cache in bulk before restoring it. |
| `sync-timeout` | `180` | Seconds to wait for the upload after saving; `0` leaves it to the runner's end-of-job upload. |

Outputs: `languages` lists the caches managed by the step, and `restored` lists the ones restored
from an earlier run.

## Cache scope and safety

- Jobs of a repository share one volume. Keep secrets out of cached paths.
- A branch or pull request writes only to its own cache, so it can't change what the default
  branch restores through this action. The volume itself is mounted read-write, though, so code
  in a pull request can still write to it directly.
- Caches of branches and pull requests are deleted after a week without use. The default
  branch's cache is kept.
- Without a cache volume (another runner, or a mount that failed its health check), the step logs
  a notice and the job builds normally. A failed restore or save never fails the job.
- To start over, change `key`, or delete the `tensorlake-cache-v2` directory on the volume from a
  job.

## Development

The action is plain Node.js with no dependencies or build step.

```bash
npm test
```

`.github/workflows/canary.yml` runs the action on a Tensorlake runner. It needs this repository
connected to a Tensorlake project.
