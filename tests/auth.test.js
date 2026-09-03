'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Mock undici.request BEFORE requiring the auth module
const undici = require('undici');
const {
  KiroAuthManager,
  parseExpiresAt,
  getKiroIdeProfilePath,
  discoverKiroIdeProfileArn,
} = require('../src/auth');
const { KiroHttpClient } = require('../src/httpClient');

// ==================================================================================================
// parseExpiresAt
// ==================================================================================================

test('parseExpiresAt: RFC3339 with Z suffix', () => {
  const ts = parseExpiresAt('2026-01-01T00:00:00Z');
  assert.equal(ts, Date.parse('2026-01-01T00:00:00Z') / 1000);
});

test('parseExpiresAt: nanoseconds precision is truncated', () => {
  const ts = parseExpiresAt('2026-01-01T00:00:00.123456789Z');
  assert.equal(ts, Date.parse('2026-01-01T00:00:00.123Z') / 1000);
});

test('parseExpiresAt: invalid input returns null', () => {
  assert.equal(parseExpiresAt('not-a-date'), null);
  assert.equal(parseExpiresAt(''), null);
});

// ==================================================================================================
// KiroAuthManager - constructor with credentials file
// ==================================================================================================

test('KiroAuthManager: loads credentials from JSON file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const credsFile = path.join(dir, 'credentials.json');
  fs.writeFileSync(
    credsFile,
    JSON.stringify({
      refreshToken: 'refresh-token-1',
      accessToken: 'access-token-1',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/id',
      region: 'us-east-1',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    })
  );

  const auth = new KiroAuthManager({ credsFile });
  assert.equal(auth.apiHost, 'https://runtime.us-east-1.kiro.dev');
  assert.equal(auth.qHost, 'https://runtime.us-east-1.kiro.dev');
  assert.equal(auth.authType, 'kiro_desktop');
  assert.equal(auth.isTokenExpiringSoon(), false);
});

test('KiroAuthManager: api_region override takes priority', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const credsFile = path.join(dir, 'credentials.json');
  fs.writeFileSync(
    credsFile,
    JSON.stringify({ refreshToken: 'rt', region: 'us-east-1' })
  );

  const auth = new KiroAuthManager({ credsFile, apiRegion: 'eu-central-1' });
  assert.equal(auth.apiHost, 'https://runtime.eu-central-1.kiro.dev');
});

// ==================================================================================================
// Kiro IDE profile ARN discovery
// ==================================================================================================

test('getKiroIdeProfilePath: darwin path', () => {
  const p = getKiroIdeProfilePath('darwin');
  assert.equal(
    p,
    path.join(os.homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json')
  );
});

test('getKiroIdeProfilePath: win32 path uses APPDATA', () => {
  const prevAppData = process.env.APPDATA;
  process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
  try {
    const p = getKiroIdeProfilePath('win32');
    assert.equal(
      p,
      path.join('C:\\Users\\test\\AppData\\Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json')
    );
  } finally {
    if (prevAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = prevAppData;
    }
  }
});

test('getKiroIdeProfilePath: win32 returns null without APPDATA', () => {
  const prevAppData = process.env.APPDATA;
  delete process.env.APPDATA;
  try {
    assert.equal(getKiroIdeProfilePath('win32'), null);
  } finally {
    if (prevAppData !== undefined) process.env.APPDATA = prevAppData;
  }
});

test('getKiroIdeProfilePath: linux path uses XDG_CONFIG_HOME', () => {
  const prevConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = '/custom/config';
  try {
    const p = getKiroIdeProfilePath('linux');
    assert.equal(
      p,
      path.join('/custom/config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json')
    );
  } finally {
    if (prevConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = prevConfigHome;
    }
  }
});

test('getKiroIdeProfilePath: linux falls back to ~/.config', () => {
  const prevConfigHome = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    const p = getKiroIdeProfilePath('linux');
    assert.equal(
      p,
      path.join(os.homedir(), '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json')
    );
  } finally {
    if (prevConfigHome !== undefined) process.env.XDG_CONFIG_HOME = prevConfigHome;
  }
});

test('getKiroIdeProfilePath: unsupported platform returns null', () => {
  assert.equal(getKiroIdeProfilePath('freebsd'), null);
});

test('discoverKiroIdeProfileArn: returns arn from a valid profile file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const profileFile = path.join(dir, 'profile.json');
  fs.writeFileSync(
    profileFile,
    JSON.stringify({ arn: 'arn:aws:codewhisperer:us-east-1:123:profile/id', name: 'Profile' })
  );

  assert.equal(
    discoverKiroIdeProfileArn(profileFile),
    'arn:aws:codewhisperer:us-east-1:123:profile/id'
  );
});

test('discoverKiroIdeProfileArn: missing file returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  assert.equal(discoverKiroIdeProfileArn(path.join(dir, 'does-not-exist.json')), null);
});

test('discoverKiroIdeProfileArn: malformed JSON returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const profileFile = path.join(dir, 'profile.json');
  fs.writeFileSync(profileFile, '{not valid json');

  assert.equal(discoverKiroIdeProfileArn(profileFile), null);
});

test('discoverKiroIdeProfileArn: empty arn field returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const profileFile = path.join(dir, 'profile.json');
  fs.writeFileSync(profileFile, JSON.stringify({ arn: '', name: 'Profile' }));

  assert.equal(discoverKiroIdeProfileArn(profileFile), null);
});

test('discoverKiroIdeProfileArn: missing arn field returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const profileFile = path.join(dir, 'profile.json');
  fs.writeFileSync(profileFile, JSON.stringify({ name: 'Profile' }));

  assert.equal(discoverKiroIdeProfileArn(profileFile), null);
});

test('discoverKiroIdeProfileArn: non-string arn returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const profileFile = path.join(dir, 'profile.json');
  fs.writeFileSync(profileFile, JSON.stringify({ arn: 123 }));

  assert.equal(discoverKiroIdeProfileArn(profileFile), null);
});

test('KiroAuthManager: discovers profileArn from Kiro IDE when credentials lack it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const credsFile = path.join(dir, 'credentials.json');
  fs.writeFileSync(credsFile, JSON.stringify({ refreshToken: 'rt', region: 'us-east-1' }));

  // Point the platform path resolution at the temp dir
  const origHomedir = os.homedir;
  os.homedir = () => dir;
  const profileFile = getKiroIdeProfilePath('darwin');

  try {
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    fs.writeFileSync(
      profileFile,
      JSON.stringify({ arn: 'arn:aws:codewhisperer:us-east-1:123:profile/discovered', name: 'Profile' })
    );

    const auth = new KiroAuthManager({ credsFile });
    assert.equal(auth.profileArn, 'arn:aws:codewhisperer:us-east-1:123:profile/discovered');
  } finally {
    os.homedir = origHomedir;
  }
});

test('KiroAuthManager: explicit profileArn takes priority over Kiro IDE discovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
  const credsFile = path.join(dir, 'credentials.json');
  fs.writeFileSync(
    credsFile,
    JSON.stringify({
      refreshToken: 'rt',
      region: 'us-east-1',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/explicit',
    })
  );

  // Point the platform path resolution at the temp dir
  const origHomedir = os.homedir;
  os.homedir = () => dir;
  const profileFile = getKiroIdeProfilePath('darwin');

  try {
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    fs.writeFileSync(
      profileFile,
      JSON.stringify({ arn: 'arn:aws:codewhisperer:us-east-1:123:profile/discovered', name: 'Profile' })
    );

    const auth = new KiroAuthManager({ credsFile });
    assert.equal(auth.profileArn, 'arn:aws:codewhisperer:us-east-1:123:profile/explicit');
  } finally {
    os.homedir = origHomedir;
  }
});

test('KiroAuthManager: getAccessToken returns valid cached token without network', async () => {
  const auth = new KiroAuthManager({
    refreshToken: 'rt',
    region: 'us-east-1',
  });
  // Inject a valid token directly
  auth._accessToken = 'cached-token';
  auth._expiresAt = Date.now() / 1000 + 7200;

  const token = await auth.getAccessToken();
  assert.equal(token, 'cached-token');
});

test('KiroAuthManager: getAccessToken refreshes when token expiring', async () => {
  const requests = [];

  undici.request = async (url, options) => {
    requests.push({ url, body: options.body });
    const body = JSON.stringify({
      accessToken: 'fresh-token',
      refreshToken: 'new-refresh-token',
      expiresIn: 3600,
    });
    return { statusCode: 200, body: makeJsonBody(body) };
  };

  const auth = new KiroAuthManager({ refreshToken: 'old-rt', region: 'us-east-1' });
  auth._expiresAt = Date.now() / 1000 - 10; // Already expired

  const token = await auth.getAccessToken();
  assert.equal(token, 'fresh-token');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.includes('auth.desktop.kiro.dev/refreshToken'));

  const sentBody = JSON.parse(requests[0].body);
  assert.deepEqual(sentBody, { refreshToken: 'old-rt' });
});

test('KiroAuthManager: refresh failure propagates', async () => {
  undici.request = async () => {
    return { statusCode: 500, body: makeJsonBody('{"error": "boom"}') };
  };

  const auth = new KiroAuthManager({ refreshToken: 'rt', region: 'us-east-1' });
  auth._expiresAt = Date.now() / 1000 - 10;

  await assert.rejects(auth.getAccessToken(), /refresh failed/);
});

test('KiroAuthManager: AWS SSO OIDC refresh uses camelCase payload', async () => {
  const requests = [];

  undici.request = async (url, options) => {
    requests.push({ url, body: options.body });
    return {
      statusCode: 200,
      body: makeJsonBody(JSON.stringify({ accessToken: 'sso-token', expiresIn: 3600 })),
    };
  };

  const auth = new KiroAuthManager({
    refreshToken: 'rt-sso',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    region: 'us-east-1',
  });
  auth._expiresAt = Date.now() / 1000 - 10;

  const token = await auth.getAccessToken();
  assert.equal(token, 'sso-token');
  assert.equal(auth.authType, 'aws_sso_oidc');
  assert.ok(requests[0].url.includes('oidc.us-east-1.amazonaws.com/token'));

  const sentBody = JSON.parse(requests[0].body);
  assert.deepEqual(sentBody, {
    grantType: 'refresh_token',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    refreshToken: 'rt-sso',
  });
});

// ==================================================================================================
// KiroHttpClient
// ==================================================================================================

function makeJsonBody(text) {
  const body = {
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(text, 'utf8');
    },
  };
  body.json = async () => JSON.parse(text);
  return body;
}

test('KiroHttpClient: returns 200 responses', async () => {
  undici.request = async () => ({ statusCode: 200, body: makeJsonBody('{}') });

  const auth = new KiroAuthManager({ refreshToken: 'rt', region: 'us-east-1' });
  auth._accessToken = 'token';
  auth._expiresAt = Date.now() / 1000 + 7200;

  const client = new KiroHttpClient(auth, { sleep: async () => {} });
  const response = await client.requestWithRetry('POST', 'https://example.com', { json: {} });
  assert.equal(response.statusCode, 200);
});

test('KiroHttpClient: 403 triggers token refresh and retry', async () => {
  let callCount = 0;

  undici.request = async () => {
    callCount += 1;
    if (callCount === 1) {
      return { statusCode: 403, body: makeJsonBody('{}') };
    }
    return { statusCode: 200, body: makeJsonBody('{}') };
  };

  const auth = new KiroAuthManager({ refreshToken: 'rt', region: 'us-east-1' });
  auth._accessToken = 'stale-token';
  auth._expiresAt = Date.now() / 1000 + 7200;
  auth.forceRefresh = async () => {
    auth._accessToken = 'refreshed-token';
    return 'refreshed-token';
  };

  const client = new KiroHttpClient(auth, { sleep: async () => {} });
  const response = await client.requestWithRetry('POST', 'https://example.com', {});
  assert.equal(response.statusCode, 200);
  assert.equal(callCount, 2);
  assert.equal(auth._accessToken, 'refreshed-token');
});

test('KiroHttpClient: 429 retries with backoff then returns last response', async () => {
  let callCount = 0;

  undici.request = async () => {
    callCount += 1;
    return { statusCode: 429, body: makeJsonBody('{}') };
  };

  const auth = new KiroAuthManager({ refreshToken: 'rt', region: 'us-east-1' });
  auth._accessToken = 'token';
  auth._expiresAt = Date.now() / 1000 + 7200;

  const sleeps = [];
  const client = new KiroHttpClient(auth, {
    sleep: async (delay) => {
      sleeps.push(delay);
    },
  });

  const response = await client.requestWithRetry('POST', 'https://example.com', {});
  assert.equal(response.statusCode, 429);
  assert.equal(callCount, 3); // MAX_RETRIES
  // Exponential backoff with ±30% jitter
  const expectedBase = [1, 2, 4];
  assert.equal(sleeps.length, expectedBase.length);
  expectedBase.forEach((base, i) => {
    assert.ok(
      sleeps[i] >= base * 0.7 && sleeps[i] <= base * 1.3,
      `delay ${sleeps[i]} not within jittered range of ${base}`
    );
  });
});

test('KiroHttpClient: 400 errors are returned as-is without retry', async () => {
  let callCount = 0;

  undici.request = async () => {
    callCount += 1;
    return { statusCode: 400, body: makeJsonBody('{"message": "bad"}') };
  };

  const auth = new KiroAuthManager({ refreshToken: 'rt', region: 'us-east-1' });
  auth._accessToken = 'token';
  auth._expiresAt = Date.now() / 1000 + 7200;

  const client = new KiroHttpClient(auth, { sleep: async () => {} });
  const response = await client.requestWithRetry('POST', 'https://example.com', {});
  assert.equal(response.statusCode, 400);
  assert.equal(callCount, 1);
});

test('KiroHttpClient: network errors raise ApiError after retries', async () => {
  undici.request = async () => {
    const cause = new Error('getaddrinfo ENOTFOUND api.kiro.dev');
    cause.code = 'ENOTFOUND';
    const err = new TypeError('fetch failed');
    err.cause = cause;
    throw err;
  };

  const auth = new KiroAuthManager({ refreshToken: 'rt', region: 'us-east-1' });
  auth._accessToken = 'token';
  auth._expiresAt = Date.now() / 1000 + 7200;

  const client = new KiroHttpClient(auth, { sleep: async () => {} });

  await assert.rejects(
    client.requestWithRetry('POST', 'https://example.com', {}),
    (err) => {
      assert.equal(err.statusCode, 502);
      assert.ok(err.message.includes('DNS'));
      return true;
    }
  );
});