'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getKiroCliDataDir,
  getDefaultCredentialCandidates,
  isValidJsonCredential,
  isValidSqliteCredential,
  discoverDefaultCredentials,
} = require('../src/credentialDiscovery');

// ==================================================================================================
// getKiroCliDataDir
// ==================================================================================================

test('getKiroCliDataDir: darwin path', () => {
  assert.equal(
    getKiroCliDataDir('darwin'),
    path.join(os.homedir(), 'Library', 'Application Support', 'kiro-cli')
  );
});

test('getKiroCliDataDir: linux uses XDG_DATA_HOME when set', () => {
  const prevDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = '/custom/data';
  try {
    assert.equal(getKiroCliDataDir('linux'), path.join('/custom/data', 'kiro-cli'));
  } finally {
    if (prevDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = prevDataHome;
    }
  }
});

test('getKiroCliDataDir: linux falls back to ~/.local/share', () => {
  const prevDataHome = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
  try {
    assert.equal(
      getKiroCliDataDir('linux'),
      path.join(os.homedir(), '.local', 'share', 'kiro-cli')
    );
  } finally {
    if (prevDataHome !== undefined) process.env.XDG_DATA_HOME = prevDataHome;
  }
});

test('getKiroCliDataDir: win32 uses APPDATA', () => {
  const prevAppData = process.env.APPDATA;
  process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
  try {
    assert.equal(
      getKiroCliDataDir('win32'),
      path.join('C:\\Users\\test\\AppData\\Roaming', 'kiro-cli')
    );
  } finally {
    if (prevAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = prevAppData;
    }
  }
});

test('getKiroCliDataDir: win32 returns null without APPDATA', () => {
  const prevAppData = process.env.APPDATA;
  delete process.env.APPDATA;
  try {
    assert.equal(getKiroCliDataDir('win32'), null);
  } finally {
    if (prevAppData !== undefined) process.env.APPDATA = prevAppData;
  }
});

test('getKiroCliDataDir: unsupported platform returns null', () => {
  assert.equal(getKiroCliDataDir('freebsd'), null);
});

// ==================================================================================================
// getDefaultCredentialCandidates
// ==================================================================================================

test('getDefaultCredentialCandidates: Kiro IDE first, kiro-cli second', () => {
  const candidates = getDefaultCredentialCandidates('darwin');

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].type, 'json');
  assert.equal(
    candidates[0].path,
    path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json')
  );
  assert.equal(candidates[0].description, 'Kiro IDE credentials');

  assert.equal(candidates[1].type, 'sqlite');
  assert.equal(
    candidates[1].path,
    path.join(os.homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')
  );
  assert.equal(candidates[1].description, 'kiro-cli database');
});

test('getDefaultCredentialCandidates: skips kiro-cli on unsupported platforms', () => {
  const candidates = getDefaultCredentialCandidates('freebsd');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].type, 'json');
});

// ==================================================================================================
// isValidJsonCredential
// ==================================================================================================

test('isValidJsonCredential: accepts a file with refreshToken', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const file = path.join(dir, 'creds.json');
  fs.writeFileSync(file, JSON.stringify({ refreshToken: 'rt', region: 'us-east-1' }));
  assert.equal(isValidJsonCredential(file), true);
});

test('isValidJsonCredential: accepts a file with clientId', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const file = path.join(dir, 'creds.json');
  fs.writeFileSync(file, JSON.stringify({ clientId: 'client-1' }));
  assert.equal(isValidJsonCredential(file), true);
});

test('isValidJsonCredential: rejects unrelated JSON files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const file = path.join(dir, 'creds.json');
  fs.writeFileSync(file, JSON.stringify({ foo: 'bar' }));
  assert.equal(isValidJsonCredential(file), false);
});

test('isValidJsonCredential: rejects arrays', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const file = path.join(dir, 'creds.json');
  fs.writeFileSync(file, JSON.stringify([{ refreshToken: 'rt' }]));
  assert.equal(isValidJsonCredential(file), false);
});

test('isValidJsonCredential: rejects malformed JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const file = path.join(dir, 'creds.json');
  fs.writeFileSync(file, '{not valid json');
  assert.equal(isValidJsonCredential(file), false);
});

test('isValidJsonCredential: missing file returns false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  assert.equal(isValidJsonCredential(path.join(dir, 'missing.json')), false);
});

// ==================================================================================================
// isValidSqliteCredential
// ==================================================================================================

function makeSqliteDb(dbPath, { authKv = true, tokenKey = false, registrationKey = false } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  if (authKv) {
    db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
  }
  if (tokenKey) {
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run(
      'kirocli:odic:token',
      JSON.stringify({ access_token: 'at', refresh_token: 'rt' })
    );
  }
  if (registrationKey) {
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run(
      'kirocli:odic:device-registration',
      JSON.stringify({ client_id: 'cid', client_secret: 'cs' })
    );
  }
  db.close();
}

test('isValidSqliteCredential: accepts a database with a token key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const dbPath = path.join(dir, 'data.sqlite3');
  makeSqliteDb(dbPath, { tokenKey: true });
  assert.equal(isValidSqliteCredential(dbPath), true);
});

test('isValidSqliteCredential: accepts a database with a registration key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const dbPath = path.join(dir, 'data.sqlite3');
  makeSqliteDb(dbPath, { registrationKey: true });
  assert.equal(isValidSqliteCredential(dbPath), true);
});

test('isValidSqliteCredential: rejects a database without auth_kv', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const dbPath = path.join(dir, 'data.sqlite3');
  makeSqliteDb(dbPath, { authKv: false });
  assert.equal(isValidSqliteCredential(dbPath), false);
});

test('isValidSqliteCredential: rejects a database with an empty auth_kv', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const dbPath = path.join(dir, 'data.sqlite3');
  makeSqliteDb(dbPath, {});
  assert.equal(isValidSqliteCredential(dbPath), false);
});

test('isValidSqliteCredential: rejects unrelated tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const dbPath = path.join(dir, 'data.sqlite3');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  db.close();
  assert.equal(isValidSqliteCredential(dbPath), false);
});

test('isValidSqliteCredential: missing file returns false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  assert.equal(isValidSqliteCredential(path.join(dir, 'missing.sqlite3')), false);
});

test('isValidSqliteCredential: rejects a non-SQLite file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const file = path.join(dir, 'data.sqlite3');
  fs.writeFileSync(file, 'this is not a sqlite database at all');
  assert.equal(isValidSqliteCredential(file), false);
});

// ==================================================================================================
// discoverDefaultCredentials
// ==================================================================================================

test('discoverDefaultCredentials: finds the Kiro IDE token file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const credsFile = path.join(dir, '.aws', 'sso', 'cache', 'kiro-auth-token.json');
  fs.mkdirSync(path.dirname(credsFile), { recursive: true });
  fs.writeFileSync(
    credsFile,
    JSON.stringify({ refreshToken: 'rt', accessToken: 'at', region: 'us-east-1' })
  );

  const origHomedir = os.homedir;
  os.homedir = () => dir;
  try {
    const entries = discoverDefaultCredentials();
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { type: 'json', path: credsFile });
  } finally {
    os.homedir = origHomedir;
  }
});

test('discoverDefaultCredentials: finds the kiro-cli database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const dbPath = path.join(dir, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  makeSqliteDb(dbPath, { tokenKey: true });

  const origHomedir = os.homedir;
  os.homedir = () => dir;
  try {
    const entries = discoverDefaultCredentials();
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { type: 'sqlite', path: dbPath });
  } finally {
    os.homedir = origHomedir;
  }
});

test('discoverDefaultCredentials: finds both sources in priority order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const credsFile = path.join(dir, '.aws', 'sso', 'cache', 'kiro-auth-token.json');
  fs.mkdirSync(path.dirname(credsFile), { recursive: true });
  fs.writeFileSync(credsFile, JSON.stringify({ refreshToken: 'rt', region: 'us-east-1' }));

  const dbPath = path.join(dir, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  makeSqliteDb(dbPath, { tokenKey: true });

  const origHomedir = os.homedir;
  os.homedir = () => dir;
  try {
    const entries = discoverDefaultCredentials();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { type: 'json', path: credsFile });
    assert.deepEqual(entries[1], { type: 'sqlite', path: dbPath });
  } finally {
    os.homedir = origHomedir;
  }
});

test('discoverDefaultCredentials: ignores invalid credential files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const credsFile = path.join(dir, '.aws', 'sso', 'cache', 'kiro-auth-token.json');
  fs.mkdirSync(path.dirname(credsFile), { recursive: true });
  fs.writeFileSync(credsFile, JSON.stringify({ foo: 'unrelated' }));

  const dbPath = path.join(dir, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  makeSqliteDb(dbPath, {});

  const origHomedir = os.homedir;
  os.homedir = () => dir;
  try {
    const entries = discoverDefaultCredentials();
    assert.equal(entries.length, 0);
  } finally {
    os.homedir = origHomedir;
  }
});

test('discoverDefaultCredentials: finds nothing when files are missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const origHomedir = os.homedir;
  os.homedir = () => dir;
  try {
    const entries = discoverDefaultCredentials();
    assert.equal(entries.length, 0);
  } finally {
    os.homedir = origHomedir;
  }
});