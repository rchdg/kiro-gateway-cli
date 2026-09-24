'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  findMatchingBrace,
  parseBracketToolCalls,
  deduplicateToolCalls,
  AwsEventStreamParser,
} = require('../src/parsers');

// ==================================================================================================
// findMatchingBrace
// ==================================================================================================

test('findMatchingBrace: simple JSON', () => {
  assert.equal(findMatchingBrace('{"a": 1}', 0), 7);
});

test('findMatchingBrace: nested JSON', () => {
  assert.equal(findMatchingBrace('{"a": {"b": 1}}', 0), 14);
});

test('findMatchingBrace: braces inside strings are ignored', () => {
  assert.equal(findMatchingBrace('{"a": "{}"}', 0), 10);
});

test('findMatchingBrace: escaped quotes in strings', () => {
  assert.equal(findMatchingBrace('{"a": "\\"{"}', 0), 11);
});

test('findMatchingBrace: returns -1 for unclosed JSON', () => {
  assert.equal(findMatchingBrace('{"a": 1', 0), -1);
});

test('findMatchingBrace: returns -1 when not starting with brace', () => {
  assert.equal(findMatchingBrace('hello {"a": 1}', 3), -1);
});

// ==================================================================================================
// parseBracketToolCalls
// ==================================================================================================

test('parseBracketToolCalls: extracts tool call from text', () => {
  const calls = parseBracketToolCalls('[Called get_weather with args: {"city": "London"}]');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: 'London' });
  assert.ok(calls[0].id.startsWith('call_'));
});

test('parseBracketToolCalls: handles nested JSON arguments', () => {
  const calls = parseBracketToolCalls(
    '[Called run_query with args: {"filter": {"a": [1, 2, 3]}}]'
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { filter: { a: [1, 2, 3] } });
});

test('parseBracketToolCalls: empty for plain text', () => {
  assert.deepEqual(parseBracketToolCalls('Hello world'), []);
  assert.deepEqual(parseBracketToolCalls(''), []);
});

test('parseBracketToolCalls: multiple tool calls', () => {
  const calls = parseBracketToolCalls(
    '[Called foo with args: {"a": 1}] text [Called bar with args: {"b": 2}]'
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.name, 'foo');
  assert.equal(calls[1].function.name, 'bar');
});

// ==================================================================================================
// deduplicateToolCalls
// ==================================================================================================

test('deduplicateToolCalls: removes exact duplicates', () => {
  const tc = {
    id: 'call_1',
    type: 'function',
    function: { name: 'foo', arguments: '{"a": 1}' },
  };
  const result = deduplicateToolCalls([tc, { ...tc }]);
  assert.equal(result.length, 1);
});

test('deduplicateToolCalls: keeps the one with more arguments by id', () => {
  const result = deduplicateToolCalls([
    { id: 'call_1', function: { name: 'foo', arguments: '{}' } },
    { id: 'call_1', function: { name: 'foo', arguments: '{"a": 1, "b": 2}' } },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].function.arguments, '{"a": 1, "b": 2}');
});

test('deduplicateToolCalls: protects against None in function', () => {
  const result = deduplicateToolCalls([{ id: 'call_1', function: null }]);
  assert.equal(result.length, 1);
  // The original object is preserved (matching the Python implementation)
  assert.equal(result[0].function, null);
});

// ==================================================================================================
// AwsEventStreamParser
// ==================================================================================================

function buildEventStreamChunks(events) {
  // Simulate AWS event stream with :message-type...event delimiters
  const parts = [];
  for (const event of events) {
    parts.push(':message-type:event\n:event-type:test\n');
    parts.push(JSON.stringify(event));
    parts.push('\n\n');
  }
  return parts;
}

test('AwsEventStreamParser: parses content events with deduplication', () => {
  const parser = new AwsEventStreamParser();
  const chunks = buildEventStreamChunks([{ content: 'Hello' }, { content: 'Hello' }, { content: ' World' }]);

  const events = [];
  for (const chunk of chunks) {
    events.push(...parser.feed(chunk));
  }

  const contentEvents = events.filter((e) => e.type === 'content');
  assert.equal(contentEvents.length, 2);
  assert.equal(contentEvents[0].data, 'Hello');
  assert.equal(contentEvents[1].data, ' World');
});

test('AwsEventStreamParser: accumulates fragments split across chunks', () => {
  const parser = new AwsEventStreamParser();
  // Split a JSON event in the middle
  const chunk1 = ':message-type:event\n:event-type:test\n{"cont';
  const chunk2 = 'ent": "hi"}';

  const events1 = parser.feed(chunk1);
  const events2 = parser.feed(chunk2);

  assert.equal(events1.length, 0);
  assert.equal(events2.length, 1);
  assert.equal(events2[0].type, 'content');
  assert.equal(events2[0].data, 'hi');
});

test('AwsEventStreamParser: only adjacent duplicate content is dropped', () => {
  const parser = new AwsEventStreamParser();
  const chunks = buildEventStreamChunks([
    { content: 'ok' },
    { content: 'ok' },
    { content: 'x' },
    { content: 'ok' },
  ]);

  const events = [];
  for (const chunk of chunks) {
    events.push(...parser.feed(chunk));
  }

  // The repeat after 'x' is not adjacent, so it survives
  assert.deepEqual(
    events.filter((e) => e.type === 'content').map((e) => e.data),
    ['ok', 'x', 'ok']
  );
});

test('AwsEventStreamParser: parses native reasoningContentEvent fragments', () => {
  const parser = new AwsEventStreamParser();
  const chunks = buildEventStreamChunks([
    { text: 'first ' },
    { text: 'first ' },
    { text: 'second' },
    { content: 'answer' },
  ]);

  const events = [];
  for (const chunk of chunks) {
    events.push(...parser.feed(chunk));
  }

  const reasoning = events.filter((e) => e.type === 'reasoning').map((e) => e.data);
  // Identical fragments are kept: reasoning repeats short tokens legitimately
  assert.deepEqual(reasoning, ['first ', 'first ', 'second']);
  assert.deepEqual(
    events.filter((e) => e.type === 'content').map((e) => e.data),
    ['answer']
  );
});

test('AwsEventStreamParser: surfaces a CONTENT_FILTERED refusal', () => {
  const parser = new AwsEventStreamParser();
  const chunks = buildEventStreamChunks([
    { content: '<thinking>The' },
    {
      stopDetails: {
        refusal: {
          category: 'REASONING_EXTRACTION',
          explanation: 'The selected model cannot continue this conversation.',
        },
      },
      stopReason: 'CONTENT_FILTERED',
    },
  ]);

  const events = [];
  for (const chunk of chunks) {
    events.push(...parser.feed(chunk));
  }

  const refusals = events.filter((e) => e.type === 'refusal');
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].data.stopReason, 'CONTENT_FILTERED');
  assert.equal(refusals[0].data.category, 'REASONING_EXTRACTION');
  assert.match(refusals[0].data.explanation, /cannot continue/);
});

test('AwsEventStreamParser: a plain END_TURN stop is not a refusal', () => {
  const parser = new AwsEventStreamParser();
  const chunks = buildEventStreamChunks([{ stopReason: 'END_TURN' }]);

  const events = [];
  for (const chunk of chunks) {
    events.push(...parser.feed(chunk));
  }

  assert.equal(events.filter((e) => e.type === 'refusal').length, 0);
});

test('AwsEventStreamParser: tool calls assembled from start/input/stop events', () => {
  const parser = new AwsEventStreamParser();

  const events = buildEventStreamChunks([
    { name: 'get_weather', toolUseId: 'toolu_1', input: {} },
    { input: '{"city": "Lo' },
    { input: 'ndon"}' },
    { stop: true },
  ]);

  for (const chunk of events) {
    parser.feed(chunk);
  }

  const toolCalls = parser.getToolCalls();
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].id, 'toolu_1');
  assert.equal(toolCalls[0].function.name, 'get_weather');
  assert.equal(JSON.parse(toolCalls[0].function.arguments).city, 'London');
});

test('AwsEventStreamParser: truncated tool call arguments become empty object', () => {
  const parser = new AwsEventStreamParser();

  const events = buildEventStreamChunks([
    { name: 'broken_tool', toolUseId: 'toolu_2', input: {} },
    { input: '{"unclosed": ' },
    { stop: true },
  ]);

  for (const chunk of events) {
    parser.feed(chunk);
  }

  const toolCalls = parser.getToolCalls();
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.arguments, '{}');
});

test('AwsEventStreamParser: parses usage and context_usage events', () => {
  const parser = new AwsEventStreamParser();

  const events = buildEventStreamChunks([
    { usage: 12 },
    { contextUsagePercentage: 45.5 },
  ]);

  const parsed = [];
  for (const chunk of events) {
    parsed.push(...parser.feed(chunk));
  }

  const usageEvent = parsed.find((e) => e.type === 'usage');
  assert.deepEqual(usageEvent.data, 12);

  const contextEvent = parsed.find((e) => e.type === 'context_usage');
  assert.deepEqual(contextEvent.data, 45.5);
});

test('AwsEventStreamParser: follows up prompt is skipped', () => {
  const parser = new AwsEventStreamParser();
  const events = buildEventStreamChunks([{ content: 'x', followupPrompt: 'y' }]);
  const parsed = [];
  for (const chunk of events) {
    parsed.push(...parser.feed(chunk));
  }
  assert.equal(parsed.length, 0);
});

test('AwsEventStreamParser: malformed JSON is skipped without crashing', () => {
  const parser = new AwsEventStreamParser();
  const events = parser.feed(':message-type:event\n{"content": "unclosed');
  assert.equal(events.length, 0);
  assert.equal(parser.buffer.includes('unclosed'), true);
});