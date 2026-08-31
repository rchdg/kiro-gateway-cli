'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Mock undici.request BEFORE requiring gateway modules
const undici = require('undici');

// Set an explicit API key BEFORE loading config so the auth-enforcement
// behavior can be tested (a separate test file covers the no-key mode).
process.env.PROXY_API_KEY = 'test-proxy-key';

const { AccountManager } = require('../src/accountManager');
const { createServer } = require('../src/server');
const { PROXY_API_KEY } = require('../src/config');

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

let refreshCount = 0;
let chatRequestCount = 0;
let failChatRequests = false;

const mockRequest = async (url, options) => {
  const urlStr = String(url);

  // Token refresh endpoint
  if (urlStr.includes('auth.desktop.kiro.dev/refreshToken')) {
    refreshCount += 1;
    return {
      statusCode: 200,
      body: makeBodyFromText(
        JSON.stringify({ accessToken: 'test-access-token', expiresIn: 3600 })
      ),
    };
  }

  // Chat completions endpoint
  if (urlStr.includes('/generateAssistantResponse')) {
    chatRequestCount += 1;
    if (failChatRequests) {
      return {
        statusCode: 400,
        body: makeBodyFromText(JSON.stringify({ message: 'Improperly formed request.', reason: null })),
      };
    }
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

  // ListAvailableModels (old endpoint)
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

  // Create temporary credentials.json
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-e2e-'));
  const credsFile = path.join(dir, 'credentials.json');
  fs.writeFileSync(
    credsFile,
    JSON.stringify([{ type: 'refresh_token', refresh_token: 'test-refresh-token' }])
  );

  // Initialize the account manager and server
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

function requestStream(method, urlPath, { headers = {}, body = null } = {}) {
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
          resolve({ status: res.statusCode, headers: res.headers, body: responseBody });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ==================================================================================================
// Health checks
// ==================================================================================================

test('GET / returns ok status', async () => {
  const res = await requestJson('GET', '/');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('GET /health returns healthy', async () => {
  const res = await requestJson('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'healthy');
});

// ==================================================================================================
// Authentication
// ==================================================================================================

test('GET /v1/models rejects invalid API key', async () => {
  const res = await requestJson('GET', '/v1/models', {
    headers: { Authorization: 'Bearer wrong-key' },
  });
  assert.equal(res.status, 401);
  assert.ok(res.body.error.message.includes('Invalid'));
});

test('POST /v1/chat/completions rejects missing API key', async () => {
  const res = await requestJson('POST', '/v1/chat/completions', {
    body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 401);
});

// ==================================================================================================
// Models
// ==================================================================================================

test('GET /v1/models returns model list', async () => {
  const res = await requestJson('GET', '/v1/models', {
    headers: { Authorization: `Bearer ${PROXY_API_KEY}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.object, 'list');
  assert.ok(res.body.data.length > 0);
  assert.ok(res.body.data.some((m) => m.id === 'claude-sonnet-4.5'));
  assert.ok(res.body.data.every((m) => m.object === 'model'));
});

// ==================================================================================================
// OpenAI chat completions
// ==================================================================================================

test('POST /v1/chat/completions (non-streaming)', async () => {
  const res = await requestJson('POST', '/v1/chat/completions', {
    headers: { Authorization: `Bearer ${PROXY_API_KEY}` },
    body: { model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'Hi' }] },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.object, 'chat.completion');
  assert.equal(res.body.choices[0].message.content, 'Hello from Kiro');
  assert.equal(res.body.choices[0].finish_reason, 'stop');
  assert.ok(res.body.usage.total_tokens > 0);
});

test('POST /v1/chat/completions (streaming)', async () => {
  const res = await requestStream('POST', '/v1/chat/completions', {
    headers: { Authorization: `Bearer ${PROXY_API_KEY}` },
    body: { model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'Hi' }], stream: true },
  });

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);

  const lines = res.body.split('\n').filter((l) => l.startsWith('data: '));
  assert.ok(lines.length >= 3);
  assert.equal(lines[lines.length - 1], 'data: [DONE]');

  const first = JSON.parse(lines[0].replace('data: ', ''));
  assert.equal(first.object, 'chat.completion.chunk');
});

test('POST /v1/chat/completions validates empty messages', async () => {
  const res = await requestJson('POST', '/v1/chat/completions', {
    headers: { Authorization: `Bearer ${PROXY_API_KEY}` },
    body: { model: 'auto', messages: [] },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.message.includes('messages'));
});

test('POST /v1/chat/completions formats upstream errors', async () => {
  failChatRequests = true;
  try {
    const res = await requestJson('POST', '/v1/chat/completions', {
      headers: { Authorization: `Bearer ${PROXY_API_KEY}` },
      body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('Kiro API rejected the request'));
    assert.equal(res.body.error.type, 'kiro_api_error');
  } finally {
    failChatRequests = false;
  }
});

// ==================================================================================================
// Anthropic messages
// ==================================================================================================

test('POST /v1/messages (non-streaming)', async () => {
  const res = await requestJson('POST', '/v1/messages', {
    headers: { 'x-api-key': PROXY_API_KEY, 'anthropic-version': '2023-06-01' },
    body: { model: 'claude-sonnet-4.5', max_tokens: 1000, messages: [{ role: 'user', content: 'Hi' }] },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.type, 'message');
  assert.equal(res.body.role, 'assistant');
  assert.equal(res.body.content[0].type, 'text');
  assert.equal(res.body.content[0].text, 'Hello from Kiro');
  assert.equal(res.body.stop_reason, 'end_turn');
  assert.ok(res.body.usage.input_tokens > 0);
});

test('POST /v1/messages (streaming)', async () => {
  const res = await requestStream('POST', '/v1/messages', {
    headers: { 'x-api-key': PROXY_API_KEY },
    body: {
      model: 'claude-sonnet-4.5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    },
  });

  assert.equal(res.status, 200);

  const events = res.body
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => block.split('\n')[0].replace('event: ', ''));

  assert.ok(events.includes('message_start'));
  assert.ok(events.includes('content_block_start'));
  assert.ok(events.includes('content_block_delta'));
  assert.ok(events.includes('content_block_stop'));
  assert.ok(events.includes('message_delta'));
  assert.equal(events[events.length - 1], 'message_stop');
});

test('POST /v1/messages supports Authorization Bearer', async () => {
  const res = await requestJson('POST', '/v1/messages', {
    headers: { Authorization: `Bearer ${PROXY_API_KEY}` },
    body: { model: 'claude-sonnet-4.5', max_tokens: 1000, messages: [{ role: 'user', content: 'Hi' }] },
  });
  assert.equal(res.status, 200);
});

test('POST /v1/messages/count_tokens returns estimation', async () => {
  const res = await requestJson('POST', '/v1/messages/count_tokens', {
    headers: { 'x-api-key': PROXY_API_KEY },
    body: { model: 'claude-sonnet-4.5', max_tokens: 1000, messages: [{ role: 'user', content: 'Hello world' }] },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.input_tokens > 0);
});

test('POST /v1/messages formats upstream errors in Anthropic format', async () => {
  failChatRequests = true;
  try {
    const res = await requestJson('POST', '/v1/messages', {
      headers: { 'x-api-key': PROXY_API_KEY },
      body: { model: 'auto', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.type, 'error');
    assert.ok(res.body.error.message.includes('Kiro API rejected the request'));
  } finally {
    failChatRequests = false;
  }
});