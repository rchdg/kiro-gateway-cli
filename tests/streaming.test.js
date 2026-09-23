'use strict';

// Fake reasoning is opt-in (Kiro filters reasoning extraction), so the thinking
// tests below have to turn it on before config.js is first required.
process.env.FAKE_REASONING = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseKiroStream,
  collectStreamToResult,
  withKeepalive,
  FirstTokenTimeoutError,
  EmptyUpstreamStreamError,
} = require('../src/streaming/core');
const {
  streamKiroToOpenAI,
  collectStreamResponse,
  streamWithFirstTokenRetryOpenAI,
} = require('../src/streaming/openai');
const {
  streamKiroToAnthropic,
  collectAnthropicResponse,
} = require('../src/streaming/anthropic');
const { ModelInfoCache } = require('../src/cache');
const { KiroAuthManager } = require('../src/auth');

// ==================================================================================================
// Test helpers
// ==================================================================================================

/**
 * Builds a fake response body (async iterable of Uint8Array).
 *
 * @param {string[]} chunks - Text chunks
 * @returns {object} Fake response
 */
function makeResponse(chunks) {
  const body = {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield Buffer.from(chunk, 'utf8');
      }
    },
  };
  return { statusCode: 200, body };
}

/**
 * Builds an AWS event stream chunk string.
 *
 * @param {object[]} events - JSON events
 * @returns {string} Combined chunk
 */
function buildEventChunk(events) {
  return events
    .map((event) => `:message-type:event\n:event-type:test\n${JSON.stringify(event)}\n\n`)
    .join('');
}

function makeModelCache() {
  const cache = new ModelInfoCache();
  cache.update([{ modelId: 'claude-sonnet-4.5', tokenLimits: { maxInputTokens: 200000 } }]);
  return cache;
}

function makeDummyAuth() {
  return { fingerprint: 'test-fingerprint' };
}

// ==================================================================================================
// parseKiroStream
// ==================================================================================================

test('parseKiroStream: yields content events', async () => {
  const response = makeResponse([buildEventChunk([{ content: 'Hello' }, { content: ' world' }])]);

  const events = [];
  for await (const event of parseKiroStream(response)) {
    events.push(event);
  }

  const content = events.filter((e) => e.type === 'content').map((e) => e.content).join('');
  assert.equal(content, 'Hello world');
});

test('parseKiroStream: first token timeout raises', async () => {
  // Body that never yields
  const body = {
    [Symbol.asyncIterator]: async function* () {
      await new Promise(() => {}); // Hang forever
    },
  };
  const response = { body };

  await assert.rejects(
    (async () => {
      for await (const _event of parseKiroStream(response, { firstTokenTimeout: 0.1 })) {
        // Never reached
      }
    })(),
    FirstTokenTimeoutError
  );
});

test('parseKiroStream: a body that closes without data is reported, not swallowed', async () => {
  const response = makeResponse([]);
  await assert.rejects(
    (async () => {
      for await (const _event of parseKiroStream(response)) {
        // no event is expected
      }
    })(),
    EmptyUpstreamStreamError
  );
});

test('parseKiroStream: extracts tool calls', async () => {
  const response = makeResponse([
    buildEventChunk([
      { name: 'get_weather', toolUseId: 'toolu_1', input: {} },
      { input: '{"city": "Paris"}' },
      { stop: true },
    ]),
  ]);

  const events = [];
  for await (const event of parseKiroStream(response)) {
    events.push(event);
  }

  const toolEvents = events.filter((e) => e.type === 'tool_use');
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].toolUse.function.name, 'get_weather');
});

test('parseKiroStream: thinking block split across chunks', async () => {
  const response = makeResponse([
    buildEventChunk([{ content: '<think' }]),
    buildEventChunk([{ content: 'ing>secret reasoning' }]),
    buildEventChunk([{ content: '</thinking>final answer' }]),
  ]);

  const events = [];
  for await (const event of parseKiroStream(response)) {
    events.push(event);
  }

  const thinking = events.filter((e) => e.type === 'thinking').map((e) => e.thinkingContent).join('');
  assert.equal(thinking, 'secret reasoning');

  const content = events.filter((e) => e.type === 'content').map((e) => e.content).join('');
  assert.equal(content, 'final answer');
});

// ==================================================================================================
// collectStreamToResult
// ==================================================================================================

test('collectStreamToResult: accumulates content, usage and context usage', async () => {
  const response = makeResponse([
    buildEventChunk([{ content: 'Hello' }, { usage: 42 }, { contextUsagePercentage: 30 }]),
  ]);

  const result = await collectStreamToResult(response);
  assert.equal(result.content, 'Hello');
  assert.equal(result.usage, 42);
  assert.equal(result.contextUsagePercentage, 30);
});

// ==================================================================================================
// streamKiroToOpenAI
// ==================================================================================================

test('streamKiroToOpenAI: emits content chunks and [DONE]', async () => {
  const response = makeResponse([
    buildEventChunk([{ content: 'Hello' }, { content: ' world' }, { contextUsagePercentage: 10 }]),
  ]);

  const chunks = [];
  for await (const chunk of streamKiroToOpenAI(response, {
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
    authManager: makeDummyAuth(),
  })) {
    chunks.push(chunk);
  }

  assert.ok(chunks.length >= 3);
  assert.ok(chunks[chunks.length - 1] === 'data: [DONE]\n\n');

  // First chunk should have the assistant role
  const first = JSON.parse(chunks[0].slice('data:'.length).trim());
  assert.equal(first.object, 'chat.completion.chunk');
  assert.equal(first.model, 'claude-sonnet-4.5');
  assert.equal(first.choices[0].delta.role, 'assistant');
  assert.equal(first.choices[0].delta.content, 'Hello');

  // Last data chunk should have usage
  const last = JSON.parse(chunks[chunks.length - 2].slice('data:'.length).trim());
  assert.ok(last.usage.prompt_tokens > 0);
  assert.equal(last.choices[0].finish_reason, 'stop');
});

test('streamKiroToOpenAI: emits reasoning_content for thinking blocks', async () => {
  const response = makeResponse([
    buildEventChunk([{ content: '<thinking>deep</thinking>answer' }]),
  ]);

  const chunks = [];
  for await (const chunk of streamKiroToOpenAI(response, {
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
    authManager: makeDummyAuth(),
  })) {
    chunks.push(chunk);
  }

  const parsed = chunks.map((c) => {
    const data = c.slice('data:'.length).trim();
    return data === '[DONE]' ? null : JSON.parse(data);
  });

  const reasoningChunks = parsed.filter((c) => c && c.choices[0].delta.reasoning_content);
  assert.equal(reasoningChunks.length, 1);
  assert.equal(reasoningChunks[0].choices[0].delta.reasoning_content, 'deep');

  const contentChunks = parsed.filter((c) => c && c.choices[0].delta.content);
  assert.equal(contentChunks.length, 1);
  assert.equal(contentChunks[0].choices[0].delta.content, 'answer');
});

test('streamKiroToOpenAI: emits tool_calls with finish_reason tool_calls', async () => {
  const response = makeResponse([
    buildEventChunk([
      { name: 'bash', toolUseId: 'toolu_1', input: {} },
      { input: '{"command": "ls"}' },
      { stop: true },
      { contextUsagePercentage: 10 },
    ]),
  ]);

  const chunks = [];
  for await (const chunk of streamKiroToOpenAI(response, {
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
    authManager: makeDummyAuth(),
  })) {
    chunks.push(chunk);
  }

  const parsed = chunks.map((c) => {
    const data = c.slice('data:'.length).trim();
    return data === '[DONE]' ? null : JSON.parse(data);
  });

  const toolChunk = parsed.find((c) => c && c.choices[0].delta.tool_calls);
  assert.ok(toolChunk, 'expected a tool_calls chunk');
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, 'bash');
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].index, 0);

  const finalChunk = parsed.filter(Boolean).pop();
  assert.equal(finalChunk.choices[0].finish_reason, 'tool_calls');
});

// ==================================================================================================
// collectStreamResponse (non-streaming)
// ==================================================================================================

test('collectStreamResponse: forms full chat completion', async () => {
  const response = makeResponse([
    buildEventChunk([{ content: 'The answer is ' }, { content: '42' }, { contextUsagePercentage: 10 }]),
  ]);

  const result = await collectStreamResponse(response, {
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
    requestMessages: [{ role: 'user', content: 'What is 6*7?' }],
  });

  assert.equal(result.object, 'chat.completion');
  assert.equal(result.choices[0].message.role, 'assistant');
  assert.equal(result.choices[0].message.content, 'The answer is 42');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.ok(result.usage.total_tokens > 0);
});

test('collectStreamResponse: includes reasoning_content', async () => {
  const response = makeResponse([
    buildEventChunk([{ content: '<thinking>reasoning</thinking>conclusion' }]),
  ]);

  const result = await collectStreamResponse(response, {
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
  });

  assert.equal(result.choices[0].message.reasoning_content, 'reasoning');
  assert.equal(result.choices[0].message.content, 'conclusion');
});

// ==================================================================================================
// streamKiroToAnthropic
// ==================================================================================================

test('streamKiroToOpenAI: an upstream refusal becomes finish_reason content_filter', async () => {
  const response = makeResponse([
    buildEventChunk([
      { content: 'partial' },
      {
        stopDetails: {
          refusal: {
            category: 'REASONING_EXTRACTION',
            explanation: 'The selected model cannot continue this conversation.',
          },
        },
        stopReason: 'CONTENT_FILTERED',
      },
      { contextUsagePercentage: 10 },
    ]),
  ]);

  const chunks = [];
  for await (const chunk of streamKiroToOpenAI(response, {
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
    authManager: makeDummyAuth(),
  })) {
    chunks.push(chunk);
  }

  const last = JSON.parse(chunks[chunks.length - 2].slice('data:'.length).trim());
  assert.equal(last.choices[0].finish_reason, 'content_filter');
  assert.match(last.choices[0].delta.refusal, /cannot continue/);
});

test('collectStreamResponse: carries the refusal on the message', async () => {
  const response = makeResponse([
    buildEventChunk([
      { content: 'partial' },
      {
        stopDetails: { refusal: { category: 'REASONING_EXTRACTION', explanation: 'Blocked upstream.' } },
        stopReason: 'CONTENT_FILTERED',
      },
      { contextUsagePercentage: 10 },
    ]),
  ]);

  const result = await collectStreamResponse(response, {
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
    requestMessages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.choices[0].finish_reason, 'content_filter');
  assert.equal(result.choices[0].message.refusal, 'Blocked upstream.');
});

test('streamKiroToAnthropic: full SSE sequence', async () => {
  const response = makeResponse([
    buildEventChunk([{ content: 'Hello' }, { content: ' world' }, { contextUsagePercentage: 10 }]),
  ]);

  const chunks = [];
  for await (const chunk of streamKiroToAnthropic(response, {
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
    authManager: makeDummyAuth(),
    requestMessages: [{ role: 'user', content: 'Say hello' }],
  })) {
    chunks.push(chunk);
  }

  const events = chunks.map((c) => {
    const eventLine = c.split('\n')[0];
    return eventLine.replace('event: ', '');
  });

  assert.deepEqual(events, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);

  const startEvent = JSON.parse(chunks[0].split('\n')[1].replace('data: ', ''));
  assert.equal(startEvent.type, 'message_start');
  assert.equal(startEvent.message.model, 'claude-sonnet-4.5');
  assert.ok(startEvent.message.usage.input_tokens > 0);

  const deltaEvent = JSON.parse(chunks[2].split('\n')[1].replace('data: ', ''));
  assert.equal(deltaEvent.delta.type, 'text_delta');
  assert.equal(deltaEvent.delta.text, 'Hello');

  const deltaEvent2 = JSON.parse(chunks[3].split('\n')[1].replace('data: ', ''));
  assert.equal(deltaEvent2.delta.text, ' world');

  const messageDelta = JSON.parse(chunks[5].split('\n')[1].replace('data: ', ''));
  assert.equal(messageDelta.delta.stop_reason, 'end_turn');
  assert.ok(messageDelta.usage.output_tokens > 0);
});

test('streamKiroToAnthropic: tool_use block sequence', async () => {
  const response = makeResponse([
    buildEventChunk([
      { name: 'bash', toolUseId: 'toolu_x', input: {} },
      { input: '{"cmd": "pwd"}' },
      { stop: true },
      { contextUsagePercentage: 10 },
    ]),
  ]);

  const chunks = [];
  for await (const chunk of streamKiroToAnthropic(response, {
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
    authManager: makeDummyAuth(),
  })) {
    chunks.push(chunk);
  }

  const events = chunks.map((c) => c.split('\n')[0].replace('event: ', ''));
  assert.deepEqual(events, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);

  const toolStart = JSON.parse(chunks[1].split('\n')[1].replace('data: ', ''));
  assert.equal(toolStart.content_block.type, 'tool_use');
  assert.equal(toolStart.content_block.name, 'bash');
  assert.equal(toolStart.content_block.id, 'toolu_x');

  const toolDelta = JSON.parse(chunks[2].split('\n')[1].replace('data: ', ''));
  assert.equal(toolDelta.delta.type, 'input_json_delta');
  assert.equal(JSON.parse(toolDelta.delta.partial_json).cmd, 'pwd');

  const messageDelta = JSON.parse(chunks[4].split('\n')[1].replace('data: ', ''));
  assert.equal(messageDelta.delta.stop_reason, 'tool_use');
});

test('collectAnthropicResponse: forms full message', async () => {
  const response = makeResponse([
    buildEventChunk([{ content: 'Hello there' }, { contextUsagePercentage: 10 }]),
  ]);

  const result = await collectAnthropicResponse(response, {
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
    requestMessages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(result.type, 'message');
  assert.equal(result.role, 'assistant');
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, 'Hello there');
  assert.equal(result.stop_reason, 'end_turn');
  assert.ok(result.usage.input_tokens > 0);
  assert.ok(result.usage.output_tokens > 0);
});

test('collectAnthropicResponse: an upstream refusal becomes stop_reason refusal', async () => {
  const response = makeResponse([
    buildEventChunk([
      { content: 'partial' },
      {
        stopDetails: { refusal: { category: 'REASONING_EXTRACTION', explanation: 'Blocked upstream.' } },
        stopReason: 'CONTENT_FILTERED',
      },
      { contextUsagePercentage: 10 },
    ]),
  ]);

  const result = await collectAnthropicResponse(response, {
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
    requestMessages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(result.stop_reason, 'refusal');
});

// ==================================================================================================
// streamWithFirstTokenRetryOpenAI
// ==================================================================================================

test('streamWithFirstTokenRetryOpenAI: retries on first token timeout', async () => {
  let requestCount = 0;

  async function makeRequest() {
    requestCount += 1;
    if (requestCount === 1) {
      // First attempt: hangs (timeout)
      return {
        statusCode: 200,
        body: {
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        },
      };
    }
    // Second attempt: responds normally
    return makeResponse([buildEventChunk([{ content: 'recovered' }, { contextUsagePercentage: 10 }])]);
  }

  const chunks = [];
  for await (const chunk of streamWithFirstTokenRetryOpenAI({
    makeRequest,
    initialResponse: await makeRequest(),
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
    firstTokenTimeout: 0.1,
    maxRetries: 3,
  })) {
    chunks.push(chunk);
  }

  assert.ok(requestCount >= 2, `expected retries, got ${requestCount} requests`);
  assert.ok(chunks.some((c) => c.includes('recovered')));
  assert.ok(chunks[chunks.length - 1] === 'data: [DONE]\n\n');
});

test('streamWithFirstTokenRetryOpenAI: exhausts retries and raises', async () => {
  let requestCount = 0;

  async function makeRequest() {
    requestCount += 1;
    return {
      statusCode: 200,
      body: {
        [Symbol.asyncIterator]: async function* () {
          await new Promise(() => {});
        },
      },
    };
  }

  await assert.rejects(
    (async () => {
      for await (const _chunk of streamWithFirstTokenRetryOpenAI({
        makeRequest,
        initialResponse: await makeRequest(),
        model: 'claude-sonnet-4.5',
        modelCache: makeModelCache(),
        firstTokenTimeout: 0.1,
        maxRetries: 2,
      })) {
        // Never reached
      }
    })(),
    /did not respond within 0\.1s per attempt/
  );

  assert.equal(requestCount, 2);
});

test('streamWithFirstTokenRetryOpenAI: retries an upstream body that closes without data', async () => {
  let requestCount = 0;

  async function makeRequest() {
    requestCount += 1;
    // First attempt: 200 with an immediately finished body.
    if (requestCount === 1) return makeResponse([]);
    return makeResponse([buildEventChunk([{ content: 'recovered' }, { contextUsagePercentage: 10 }])]);
  }

  const chunks = [];
  for await (const chunk of streamWithFirstTokenRetryOpenAI({
    makeRequest,
    initialResponse: await makeRequest(),
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
    firstTokenTimeout: 0.5,
    maxRetries: 3,
  })) {
    chunks.push(chunk);
  }

  assert.ok(requestCount >= 2, `expected a retry, got ${requestCount} requests`);
  assert.ok(chunks.some((c) => c.includes('recovered')));
});

test('streamWithFirstTokenRetryOpenAI: reports the real reason when every attempt is reset', async () => {
  async function makeRequest() {
    return {
      statusCode: 200,
      body: {
        [Symbol.asyncIterator]: async function* () {
          const err = new Error('socket hang up');
          err.cause = { code: 'ECONNRESET' };
          throw err;
        },
      },
    };
  }

  await assert.rejects(
    (async () => {
      for await (const _chunk of streamWithFirstTokenRetryOpenAI({
        makeRequest,
        initialResponse: await makeRequest(),
        model: 'claude-sonnet-4.5',
        modelCache: makeModelCache(),
        firstTokenTimeout: 30,
        maxRetries: 2,
      })) {
        // Never reached
      }
    })(),
    // The old message blamed a first token timeout that never happened.
    (err) => /reset by the server/.test(err.message) && !/did not respond/.test(err.message)
  );
});

test('streamWithFirstTokenRetryOpenAI: propagates upstream HTTP errors', async () => {
  async function makeRequest() {
    return {
      statusCode: 400,
      body: makeResponse(['bad request']).body,
    };
  }

  await assert.rejects(
    (async () => {
      for await (const _chunk of streamWithFirstTokenRetryOpenAI({
        makeRequest,
        model: 'claude-sonnet-4.5',
        modelCache: makeModelCache(),
        firstTokenTimeout: 0.1,
      })) {
        // Never reached
      }
    })(),
    /Upstream API error/
  );
});

test('streamWithFirstTokenRetryOpenAI: retries connection errors before any data is sent', async () => {
  let requestCount = 0;

  async function makeRequest() {
    requestCount += 1;
    if (requestCount === 1) {
      // First attempt: the proxy drops the connection mid-response before
      // any chunk reaches the parser (e.g. "Invalid EOF state").
      return {
        statusCode: 200,
        body: {
          [Symbol.asyncIterator]: async function* () {
            throw new Error('Response does not match the HTTP/1.1 protocol (Invalid EOF state)');
          },
        },
      };
    }
    // Second attempt: responds normally
    return makeResponse([buildEventChunk([{ content: 'recovered' }, { contextUsagePercentage: 10 }])]);
  }

  const chunks = [];
  for await (const chunk of streamWithFirstTokenRetryOpenAI({
    makeRequest,
    initialResponse: await makeRequest(),
    model: 'claude-sonnet-4.5',
    modelCache: makeModelCache(),
    firstTokenTimeout: 0.5,
    maxRetries: 3,
  })) {
    chunks.push(chunk);
  }

  assert.ok(requestCount >= 2, `expected retries, got ${requestCount} requests`);
  assert.ok(chunks.some((c) => c.includes('recovered')));
  assert.ok(chunks[chunks.length - 1] === 'data: [DONE]\n\n');
});

test('streamWithFirstTokenRetryOpenAI: does not retry after data reached the client', async () => {
  let requestCount = 0;

  async function makeRequest() {
    requestCount += 1;
    return {
      statusCode: 200,
      body: {
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(buildEventChunk([{ content: 'partial' }]), 'utf8');
          throw new Error('Response does not match the HTTP/1.1 protocol (Invalid EOF state)');
        },
      },
    };
  }

  await assert.rejects(
    (async () => {
      for await (const _chunk of streamWithFirstTokenRetryOpenAI({
        makeRequest,
        model: 'claude-sonnet-4.5',
        modelCache: makeModelCache(),
        firstTokenTimeout: 0.5,
        maxRetries: 3,
      })) {
        // Consumer already received data before the failure
      }
    })(),
    /Invalid EOF state/
  );

  assert.equal(requestCount, 1);
});

// ==================================================================================================
// Keepalive during silent stretches
// ==================================================================================================

test('withKeepalive emits keepalive chunks while the source is silent', async () => {
  const KEEPALIVE = ': keepalive\n\n';

  // Silent for ~5 keepalive intervals, then a single real chunk.
  async function* slowSource() {
    await new Promise((resolve) => setTimeout(resolve, 100));
    yield 'data: real\n\n';
  }

  const received = [];
  for await (const chunk of withKeepalive(slowSource(), {
    keepaliveChunk: KEEPALIVE,
    intervalSeconds: 0.02,
  })) {
    received.push(chunk);
  }

  const keepalives = received.filter((c) => c === KEEPALIVE);
  const real = received.filter((c) => c !== KEEPALIVE);

  assert.ok(keepalives.length >= 2, `expected keepalives, got ${keepalives.length}`);
  assert.deepEqual(real, ['data: real\n\n']);
  // The real chunk must still arrive last, after the keepalives.
  assert.equal(received[received.length - 1], 'data: real\n\n');
});

test('withKeepalive forwards every chunk in order and adds none when the source is busy', async () => {
  async function* fastSource() {
    yield 'a';
    yield 'b';
    yield 'c';
  }

  const received = [];
  for await (const chunk of withKeepalive(fastSource(), {
    keepaliveChunk: ': keepalive\n\n',
    intervalSeconds: 5,
  })) {
    received.push(chunk);
  }

  assert.deepEqual(received, ['a', 'b', 'c']);
});

test('withKeepalive is a passthrough when disabled', async () => {
  async function* source() {
    await new Promise((resolve) => setTimeout(resolve, 30));
    yield 'x';
  }

  for (const intervalSeconds of [0, -1]) {
    const received = [];
    for await (const chunk of withKeepalive(source(), {
      keepaliveChunk: ': keepalive\n\n',
      intervalSeconds,
    })) {
      received.push(chunk);
    }
    assert.deepEqual(received, ['x']);
  }
});

test('withKeepalive propagates source errors instead of looping on keepalives', async () => {
  async function* failingSource() {
    yield 'first';
    await new Promise((resolve) => setTimeout(resolve, 60));
    throw new Error('Response does not match the HTTP/1.1 protocol (Invalid EOF state)');
  }

  const received = [];
  await assert.rejects(
    (async () => {
      for await (const chunk of withKeepalive(failingSource(), {
        keepaliveChunk: ': keepalive\n\n',
        intervalSeconds: 0.02,
      })) {
        received.push(chunk);
      }
    })(),
    /Invalid EOF state/
  );

  assert.equal(received[0], 'first');
  assert.ok(received.length >= 2, 'keepalives should precede the failure');
});

test('withKeepalive does not drop a chunk that resolves during a keepalive tick', async () => {
  // The source settles between ticks; a naive implementation that re-calls
  // next() on every tick would lose this value.
  async function* source() {
    for (const value of ['one', 'two', 'three']) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield value;
    }
  }

  const real = [];
  for await (const chunk of withKeepalive(source(), {
    keepaliveChunk: ': keepalive\n\n',
    intervalSeconds: 0.02,
  })) {
    if (chunk !== ': keepalive\n\n') real.push(chunk);
  }

  assert.deepEqual(real, ['one', 'two', 'three']);
});
