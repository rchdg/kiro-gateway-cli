'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AccountManager } = require('../src/accountManager');

// Keep the refresh attempts off the network: every refresh is rejected.
const undici = require('undici');
undici.request = async () => ({
  statusCode: 400,
  body: {
    json: async () => ({ error: 'invalid_grant' }),
    text: async () => '{"error":"invalid_grant"}',
  },
});

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-account-test-'));
}

function writeCredsJson(dir, name, data) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

function makeWorkingCreds(dir, name) {
  return writeCredsJson(dir, name, {
    refreshToken: 'refresh-token',
    accessToken: 'access-token',
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    region: 'us-east-1',
    profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/id',
  });
}

function makeUsableManager(dir, entries) {
  const credsFile = path.join(dir, 'credentials.json');
  fs.writeFileSync(credsFile, JSON.stringify(entries));
  return { manager: new AccountManager(credsFile), credsFile };
}

test('addCredentialEntries: adds discovered credentials without touching the file', async () => {
  const dir = makeTempDir();
  const jsonPath = makeWorkingCreds(dir, 'kiro-auth-token.json');
  const { manager, credsFile } = makeUsableManager(dir, [{ type: 'json', path: jsonPath }]);
  await manager.loadCredentials();

  const before = fs.readFileSync(credsFile, 'utf8');
  const sqliteLike = path.join(dir, 'data.sqlite3');
  fs.writeFileSync(sqliteLike, 'not a real database');

  const added = manager.addCredentialEntries([
    { type: 'json', path: jsonPath },
    { type: 'sqlite', path: sqliteLike },
    { type: 'sqlite', path: path.join(dir, 'missing.sqlite3') },
    { type: 'bogus', path: jsonPath },
  ]);

  assert.deepEqual(added, [path.resolve(sqliteLike)]);
  assert.equal(manager.accountCount, 2);
  assert.equal(fs.readFileSync(credsFile, 'utf8'), before);
});

test('addCredentialEntries: tolerates non-array input', async () => {
  const dir = makeTempDir();
  const jsonPath = makeWorkingCreds(dir, 'kiro-auth-token.json');
  const { manager } = makeUsableManager(dir, [{ type: 'json', path: jsonPath }]);
  await manager.loadCredentials();

  assert.deepEqual(manager.addCredentialEntries(null), []);
  assert.deepEqual(manager.addCredentialEntries([null, undefined, {}]), []);
});

test('initializeFirstWorking: falls back to the next usable account', async () => {
  const dir = makeTempDir();
  const brokenPath = writeCredsJson(dir, 'broken.json', {
    refreshToken: 'refresh-token',
    accessToken: 'access-token',
    expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
    region: 'us-east-1',
  });
  const workingPath = makeWorkingCreds(dir, 'working.json');

  const { manager } = makeUsableManager(dir, [
    { type: 'json', path: brokenPath },
    { type: 'json', path: workingPath },
  ]);
  await manager.loadCredentials();

  const initializedId = await manager.initializeFirstWorking();
  assert.equal(initializedId, path.resolve(workingPath));
});

test('initializeFirstWorking: returns null when every account fails', async () => {
  const dir = makeTempDir();
  const brokenPath = writeCredsJson(dir, 'broken.json', {
    refreshToken: 'refresh-token',
    accessToken: 'access-token',
    expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
    region: 'us-east-1',
  });

  const { manager } = makeUsableManager(dir, [{ type: 'json', path: brokenPath }]);
  await manager.loadCredentials();

  assert.equal(await manager.initializeFirstWorking(), null);
  assert.equal(manager.accountCount, 0);
});
