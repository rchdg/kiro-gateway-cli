'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Mock undici.request BEFORE requiring the auth module
const undici = require('undici');
const { KiroAuthManager, parseExpiresAt } = require('../src/auth');
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
  assert.deepEqual(sleeps, [1, 2, 4]); // exponential backoff
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