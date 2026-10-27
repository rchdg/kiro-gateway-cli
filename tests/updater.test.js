'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  UpdateError,
  normalizeVersion,
  fetchLatestVersion,
  installLatest,
  runUpdate,
} = require('../src/updater');

/**
 * Builds a fake fetch implementation.
 *
 * @param {{version?: string, ok?: boolean, throws?: boolean}} options - Response shape
 * @returns {Function} Fake fetch
 */
function fakeFetch(options = {}) {
  return async () => {
    if (options.throws) throw new Error('network down');
    return {
      ok: options.ok !== false,
      json: async () => ({ version: options.version }),
    };
  };
}

/**
 * Builds a fake spawn implementation that closes immediately.
 *
 * @param {number} code - Exit code for the child
 * @returns {{spawnImpl: Function, calls: object[]}} Fake spawn and recorded calls
 */
function fakeSpawn(code) {
  const calls = [];
  const spawnImpl = (command, args, opts) => {
    calls.push({ command, args, opts });
    const child = new EventEmitter();
    setImmediate(() => child.emit('close', code, null));
    return child;
  };
  return { spawnImpl, calls };
}

test('normalizeVersion: strips leading v and whitespace', () => {
  assert.equal(normalizeVersion('v1.7.0'), '1.7.0');
  assert.equal(normalizeVersion(' 1.7.0 '), '1.7.0');
  assert.equal(normalizeVersion(''), '');
  assert.equal(normalizeVersion(undefined), '');
});

test('fetchLatestVersion: returns the published version', async () => {
  const version = await fetchLatestVersion({ fetchImpl: fakeFetch({ version: 'v1.8.0' }) });
  assert.equal(version, '1.8.0');
});

test('fetchLatestVersion: returns null on network error', async () => {
  assert.equal(await fetchLatestVersion({ fetchImpl: fakeFetch({ throws: true }) }), null);
});

test('fetchLatestVersion: returns null on non-ok response', async () => {
  assert.equal(await fetchLatestVersion({ fetchImpl: fakeFetch({ ok: false }) }), null);
});

test('fetchLatestVersion: returns null when fetch is unavailable', async () => {
  assert.equal(await fetchLatestVersion({ fetchImpl: 'not-a-function' }), null);
});

test('installLatest: runs a global npm install of the package', async () => {
  const { spawnImpl, calls } = fakeSpawn(0);
  const result = await installLatest({ spawnImpl, stdio: 'ignore' });

  assert.equal(result.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.join(' '), 'install -g kiro-gateway-cli@latest');
});

test('installLatest: rejects when npm cannot be started', async () => {
  const spawnImpl = () => {
    throw new Error('spawn npm ENOENT');
  };
  await assert.rejects(() => installLatest({ spawnImpl }), UpdateError);
});

test('installLatest: non-zero exit code is reported by runUpdate', async () => {
  const { spawnImpl } = fakeSpawn(1);
  await assert.rejects(
    () =>
      runUpdate({
        currentVersion: '1.7.0',
        fetchImpl: fakeFetch({ version: '1.8.0' }),
        spawnImpl,
        stdout: () => {},
        stderr: () => {},
      }),
    UpdateError
  );
});

test('runUpdate: skips the install when already on the latest version', async () => {
  const { spawnImpl, calls } = fakeSpawn(0);
  const out = [];

  const updated = await runUpdate({
    currentVersion: 'v1.7.0',
    fetchImpl: fakeFetch({ version: '1.7.0' }),
    spawnImpl,
    stdout: (text) => out.push(text),
  });

  assert.equal(updated, false);
  assert.equal(calls.length, 0);
  assert.ok(out.join('').includes('already up to date'));
});

test('runUpdate: installs the latest version when outdated', async () => {
  const { spawnImpl, calls } = fakeSpawn(0);
  const out = [];

  const updated = await runUpdate({
    currentVersion: '1.7.0',
    fetchImpl: fakeFetch({ version: '1.8.0' }),
    spawnImpl,
    stdout: (text) => out.push(text),
  });

  assert.equal(updated, true);
  assert.equal(calls.length, 1);
  assert.ok(out.join('').includes('v1.7.0 -> v1.8.0'));
  assert.ok(out.join('').includes('Updated kiro-gateway to v1.8.0'));
});

test('runUpdate: installs anyway when the registry is unreachable', async () => {
  const { spawnImpl, calls } = fakeSpawn(0);
  const err = [];

  const updated = await runUpdate({
    currentVersion: '1.7.0',
    fetchImpl: fakeFetch({ throws: true }),
    spawnImpl,
    stdout: () => {},
    stderr: (text) => err.push(text),
  });

  assert.equal(updated, true);
  assert.equal(calls.length, 1);
  assert.ok(err.join('').includes('could not check the npm registry'));
});

// ==================================================================================================
// Background-server awareness
// ==================================================================================================

test('runUpdate: warns that a running background server keeps the old version', async () => {
  const { spawnImpl } = fakeSpawn(0);
  const out = [];
  const err = [];

  await runUpdate({
    currentVersion: '1.7.0',
    fetchImpl: fakeFetch({ version: '1.8.0' }),
    spawnImpl,
    statusProvider: async () => ({ running: true, pid: 4242 }),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });

  const combined = err.join('');
  assert.ok(combined.includes('4242'));
  assert.ok(combined.includes('still running the previous'));
  assert.ok(combined.includes('kiro-gateway stop'));
});

test('runUpdate: stays quiet when no background server is running', async () => {
  const { spawnImpl } = fakeSpawn(0);
  const out = [];
  const err = [];

  await runUpdate({
    currentVersion: '1.7.0',
    fetchImpl: fakeFetch({ version: '1.8.0' }),
    spawnImpl,
    statusProvider: async () => ({ running: false, pid: null }),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });

  assert.equal(err.join(''), '');
  assert.ok(!out.join('').includes('background server'));
});

test('runUpdate: a failing status probe does not block the upgrade', async () => {
  const { spawnImpl, calls } = fakeSpawn(0);

  const updated = await runUpdate({
    currentVersion: '1.7.0',
    fetchImpl: fakeFetch({ version: '1.8.0' }),
    spawnImpl,
    statusProvider: async () => {
      throw new Error('pid file unreadable');
    },
    stdout: () => {},
    stderr: () => {},
  });

  assert.equal(updated, true);
  assert.equal(calls.length, 1);
});

test('runUpdate: notes the running server even when already up to date', async () => {
  const { spawnImpl, calls } = fakeSpawn(0);
  const out = [];

  const updated = await runUpdate({
    currentVersion: '1.7.0',
    fetchImpl: fakeFetch({ version: '1.7.0' }),
    spawnImpl,
    statusProvider: async () => ({ running: true, pid: 4242 }),
    stdout: (text) => out.push(text),
  });

  assert.equal(updated, false);
  assert.equal(calls.length, 0);
  assert.ok(out.join('').includes('keeps running the current version'));
});
