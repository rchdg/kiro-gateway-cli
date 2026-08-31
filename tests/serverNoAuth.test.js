'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Mock undici.request BEFORE requiring gateway modules
const undici = require('undici');

// Empty PROXY_API_KEY = authentication disabled. Must be set before loading
// config (runs in its own test process, so it does not affect other files).
process.env.PROXY_API_KEY = '';

const { AccountManager } = require('../src/accountManager');
const { createServer } = require('../src/server');
const { PROXY_API_KEY } = require('../src/config');

assert.equal(PROXY_API_KEY, '', 'auth must be disabled for this test suite');

// ==================================================================================================
// Mock upstream
// ==================================================================================================

function makeBodyFromText(text) {
  const body = {
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(text, 'utf8');
    },
  };
  body.json = async () => JSON.parse(text);
  return body;
}

function buildEventStreamText(events) {
  return events
    .map((event) => `:message-type:event\n:event-type:test\n${JSON.stringify(event)}\n\n`)
    .join('');
}

const mockRequest = async (url, options) => {
  const urlStr = String(url);

  if (urlStr.includes('auth.desktop.kiro.dev/refreshToken')) {
    return {
      statusCode: 200,
      body: makeBodyFromText(
        JSON.stringify({ accessToken: 'test-access-token', expiresIn: 3600 })
      ),
    };
  }

  if (urlStr.includes('/generateAssistantResponse')) {
    return {
      statusCode: 200,
      body: makeBodyFromText(
        buildEventStreamText([
          { content: 'Hello' },
          { content: ' from Kiro' },
          { contextUsagePercentage: 10 },
        ])
      ),
    };
  }

  if (urlStr.includes('/ListAvailableModels')) {
    return {
      statusCode: 200,
      body: makeBodyFromText(JSON.stringify({ models: [{ modelId: 'claude-sonnet-4.5' }] })),
    };
  }

  throw new Error(`Unexpected request: ${urlStr}`);
};

// ==================================================================================================
// Setup
// ==================================================================================================

let server;
let baseUrl;
let dir;

before(async () => {
  undici.request = mockRequest;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-noauth-'));
  const credsFile = path.join(dir, 'credentials.json');
  fs.writeFileSync(
    credsFile,
    JSON.stringify([{ type: 'refresh_token', refresh_token: 'test-refresh-token' }])
  );

  const accountManager = new AccountManager(credsFile);
  await accountManager.loadCredentials();
  await accountManager._initializeAccount(accountManager.accountIds[0]);

  const app = createServer({ accountManager, accountSystem: false });

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ==================================================================================================
// Helpers
// ==================================================================================================

function requestJson(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: new URL(baseUrl).port,
        path: urlPath,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(responseBody);
          } catch {
            parsed = responseBody;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ==================================================================================================
// No-auth mode (PROXY_API_KEY unset)
// ==================================================================================================

test('no-auth: GET /v1/models works without any API key', async () => {
  const res = await requestJson('GET', '/v1/models');
  assert.equal(res.status, 200);
  assert.equal(res.body.object, 'list');
  assert.ok(res.body.data.length > 0);
});

test('no-auth: GET /v1/models accepts a key if the client sends one anyway', async () => {
  const res = await requestJson('GET', '/v1/models', {
    headers: { Authorization: 'Bearer whatever-key' },
  });
  assert.equal(res.status, 200);
});

test('no-auth: POST /v1/chat/completions works without an API key', async () => {
  const res = await requestJson('POST', '/v1/chat/completions', {
    body: { model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'Hi' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.object, 'chat.completion');
  assert.equal(res.body.choices[0].message.content, 'Hello from Kiro');
});

test('no-auth: POST /v1/messages works without an API key', async () => {
  const res = await requestJson('POST', '/v1/messages', {
    body: { model: 'claude-sonnet-4.5', max_tokens: 1000, messages: [{ role: 'user', content: 'Hi' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.type, 'message');
});

test('no-auth: POST /v1/messages/count_tokens works without an API key', async () => {
  const res = await requestJson('POST', '/v1/messages/count_tokens', {
    body: { model: 'claude-sonnet-4.5', max_tokens: 1000, messages: [{ role: 'user', content: 'Hello' }] },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.input_tokens > 0);
});