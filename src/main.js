'use strict';

// Compression runs on libuv's thread pool; size it before anything uses it.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || String(Math.max(4, require('os').cpus().length));

const core = require('./lib/core');
const steps = require('./lib/steps');

core.run('restore', () => steps.restore());
