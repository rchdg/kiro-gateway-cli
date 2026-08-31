'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// config.js reads process.env at module load time, so each test must reload
// it fresh and restore the previous environment afterwards.

function loadConfigWithEnv(overrides = {}) {
  const prev = {};
  for (const [key, value] of Object.entries(overrides)) {
    prev[key] = process.env[key];
    if (value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');

  for (const [key, value] of Object.entries(overrides)) {
    if (prev[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev[key];
    }
  }

  return config;
}

test('config: KIRO_CREDS_FILE defaults to the Kiro IDE credentials path', () => {
  const config = loadConfigWithEnv({ KIRO_CREDS_FILE: null });
  assert.equal(
    config.KIRO_CREDS_FILE,
    path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json')
  );
});

test('config: DEFAULT_KIRO_CREDS_FILE is the tilde form of the default', () => {
  const config = loadConfigWithEnv({ KIRO_CREDS_FILE: null });
  assert.equal(config.DEFAULT_KIRO_CREDS_FILE, '~/.aws/sso/cache/kiro-auth-token.json');
});

test('config: KIRO_CREDS_FILE respects an explicit env var', () => {
  const config = loadConfigWithEnv({ KIRO_CREDS_FILE: '/custom/creds.json' });
  assert.equal(config.KIRO_CREDS_FILE, '/custom/creds.json');
});

test('config: KIRO_CREDS_FILE expands a tilde prefix from env', () => {
  const config = loadConfigWithEnv({ KIRO_CREDS_FILE: '~/custom/creds.json' });
  assert.equal(config.KIRO_CREDS_FILE, path.join(os.homedir(), 'custom', 'creds.json'));
});

test('config: explicit empty KIRO_CREDS_FILE disables the default', () => {
  const config = loadConfigWithEnv({ KIRO_CREDS_FILE: '' });
  assert.equal(config.KIRO_CREDS_FILE, '');
});

test('config: PROXY_API_KEY defaults to empty (authentication disabled)', () => {
  const config = loadConfigWithEnv({ PROXY_API_KEY: null });
  assert.equal(config.PROXY_API_KEY, '');
});

test('config: PROXY_API_KEY respects an explicit env var', () => {
  const config = loadConfigWithEnv({ PROXY_API_KEY: 'my-secret-key' });
  assert.equal(config.PROXY_API_KEY, 'my-secret-key');
});