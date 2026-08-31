'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ThinkingParser, ParserState } = require('../src/thinkingParser');

test('ThinkingParser: tag split across chunks', () => {
  const parser = new ThinkingParser();

  let result = parser.feed('<think');
  assert.equal(result.thinkingContent, null); // Still buffering

  result = parser.feed('ing>Hello');
  // 'Hello' is shorter than maxTagLength - kept in the buffer (cautious sending)
  assert.equal(result.thinkingContent, null);

  result = parser.feed('</thinking>World');
  assert.equal(result.thinkingContent, 'Hello');
  assert.equal(result.isFirstThinkingChunk, true);
  assert.equal(result.isLastThinkingChunk, true);
  assert.equal(result.regularContent, 'World');

  assert.equal(parser.state, ParserState.STREAMING);
  assert.equal(parser.foundThinkingBlock, true);
});

test('ThinkingParser: no thinking tag - everything is regular content', () => {
  const parser = new ThinkingParser();

  let result = parser.feed('Hello');
  assert.equal(result.regularContent, 'Hello');
  assert.equal(parser.state, ParserState.STREAMING);

  result = parser.feed(' world');
  assert.equal(result.regularContent, ' world');
  assert.equal(parser.foundThinkingBlock, false);
});

test('ThinkingParser: thinking content larger than buffer is flushed incrementally', () => {
  const parser = new ThinkingParser();
  const longThinking = 'a'.repeat(100);

  const result = parser.feed(`<thinking>${longThinking}</thinking>rest`);
  // 100 chars > maxTagLength (18), so it should be emitted
  assert.equal(result.thinkingContent, longThinking);
  assert.equal(result.regularContent, 'rest');
});

test('ThinkingParser: remove mode drops thinking content', () => {
  const parser = new ThinkingParser({ handlingMode: 'remove' });
  parser.feed('<thinking>secret');
  const result = parser.feed('</thinking>visible');
  assert.equal(result.regularContent, 'visible');
  // Thinking content is emitted but dropped by processForOutput in remove mode
  assert.equal(result.thinkingContent, 'secret');
  assert.equal(parser.processForOutput(result.thinkingContent, false, true), null);
});

test('ThinkingParser: pass mode restores tags', () => {
  const parser = new ThinkingParser({ handlingMode: 'pass' });
  parser.feed('<thinking>secret'); // Buffered, no emission yet
  const result = parser.feed('</thinking>');

  const processed = parser.processForOutput(
    'secret',
    result.isFirstThinkingChunk,
    result.isLastThinkingChunk
  );
  assert.equal(processed, '<thinking>secret</thinking>');
});

test('ThinkingParser: finalize flushes remaining thinking on stream end', () => {
  const parser = new ThinkingParser();
  parser.feed('<thinking>never closed');

  const result = parser.finalize();
  assert.equal(result.thinkingContent, 'never closed');
  assert.equal(result.isLastThinkingChunk, true);
});

test('ThinkingParser: leading whitespace before tag is stripped', () => {
  const parser = new ThinkingParser();
  parser.feed('  \n<thinking>');
  const result = parser.feed('reasoning</thinking>answer');
  assert.equal(result.regularContent, 'answer');
});

test('ThinkingParser: initial buffer limit transitions to streaming', () => {
  const parser = new ThinkingParser({ initialBufferSize: 10 });
  parser.feed('z'.repeat(11));
  assert.equal(parser.state, ParserState.STREAMING);
});

test('ThinkingParser: supports multiple open tags', () => {
  const parser = new ThinkingParser({ openTags: ['<reasoning>', '<thought>'] });
  parser.feed('<reasoning>deep');
  const result = parser.feed('</reasoning>out');
  assert.equal(result.regularContent, 'out');
});