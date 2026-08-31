'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  enhanceKiroError,
  parseKiroError,
  classifyError,
  ErrorType,
  classifyNetworkError,
  ErrorCategory,
} = require('../src/errors');

// ==================================================================================================
// enhanceKiroError
// ==================================================================================================

test('enhanceKiroError: context limit exceeded', () => {
  const info = enhanceKiroError({ message: 'Input is too long.', reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD' });
  assert.equal(info.reason, 'CONTENT_LENGTH_EXCEEDS_THRESHOLD');
  assert.equal(info.userMessage, 'Model context limit reached. Conversation size exceeds model capacity.');
  assert.equal(info.originalMessage, 'Input is too long.');
});

test('enhanceKiroError: monthly request count', () => {
  const info = enhanceKiroError({ message: 'Quota', reason: 'MONTHLY_REQUEST_COUNT' });
  assert.equal(info.userMessage, 'Monthly request limit exceeded. Account has reached its monthly quota.');
});

test('enhanceKiroError: invalid model id', () => {
  const info = enhanceKiroError({ message: 'Bad model', reason: 'INVALID_MODEL_ID' });
  assert.equal(info.userMessage, 'Invalid model ID or insufficient subscription level to use it.');
});

test('enhanceKiroError: improperly formed request with unknown reason', () => {
  const info = enhanceKiroError({ message: 'Improperly formed request.', reason: null });
  assert.ok(info.userMessage.includes('Kiro API rejected the request'));
});

test('enhanceKiroError: unknown reason is appended', () => {
  const info = enhanceKiroError({ message: 'Something failed', reason: 'MYSTERY_REASON' });
  assert.equal(info.userMessage, 'Something failed (reason: MYSTERY_REASON)');
});

test('enhanceKiroError: missing message defaults', () => {
  const info = enhanceKiroError({});
  assert.equal(info.originalMessage, 'Unknown error');
  assert.equal(info.userMessage, 'Unknown error');
});

test('parseKiroError: non-JSON body returned as-is', () => {
  const result = parseKiroError('<html>error</html>');
  assert.equal(result.reason, null);
  assert.equal(result.userMessage, '<html>error</html>');
});

// ==================================================================================================
// classifyError
// ==================================================================================================

test('classifyError: recoverable errors', () => {
  assert.equal(classifyError(402, null), ErrorType.RECOVERABLE);
  assert.equal(classifyError(403, null), ErrorType.RECOVERABLE);
  assert.equal(classifyError(429, null), ErrorType.RECOVERABLE);
  assert.equal(classifyError(400, 'INVALID_MODEL_ID'), ErrorType.RECOVERABLE);
});

test('classifyError: fatal errors', () => {
  assert.equal(classifyError(400, null), ErrorType.FATAL);
  assert.equal(classifyError(400, 'CONTENT_LENGTH_EXCEEDS_THRESHOLD'), ErrorType.FATAL);
  assert.equal(classifyError(422, null), ErrorType.FATAL);
  assert.equal(classifyError(500, null), ErrorType.FATAL);
  assert.equal(classifyError(503, null), ErrorType.FATAL);
});

// ==================================================================================================
// classifyNetworkError
// ==================================================================================================

function makeError(name, message, code) {
  const err = new Error(message);
  err.name = name;
  if (code) err.code = code;
  return err;
}

test('classifyNetworkError: DNS resolution', () => {
  const info = classifyNetworkError(makeError('Error', 'fetch failed', 'ENOTFOUND'));
  assert.equal(info.category, ErrorCategory.DNS_RESOLUTION);
  assert.ok(info.userMessage.includes('DNS'));
  assert.equal(info.suggestedHttpCode, 502);
  assert.equal(info.isRetryable, true);
});

test('classifyNetworkError: connection refused', () => {
  const info = classifyNetworkError(makeError('Error', 'fetch failed', 'ECONNREFUSED'));
  assert.equal(info.category, ErrorCategory.CONNECTION_REFUSED);
  assert.equal(info.isRetryable, false);
});

test('classifyNetworkError: timeout', () => {
  const info = classifyNetworkError(makeError('TimeoutError', 'timeout'));
  assert.equal(info.category, ErrorCategory.TIMEOUT_READ);
  assert.equal(info.suggestedHttpCode, 504);
});

test('classifyNetworkError: connection reset', () => {
  const info = classifyNetworkError(makeError('Error', 'fetch failed', 'ECONNRESET'));
  assert.equal(info.category, ErrorCategory.CONNECTION_RESET);
});

test('classifyNetworkError: undici wrapped errors use cause', () => {
  const cause = makeError('Error', 'getaddrinfo ENOTFOUND api.kiro.dev', 'ENOTFOUND');
  const wrapped = new TypeError('fetch failed');
  wrapped.cause = cause;

  const info = classifyNetworkError(wrapped);
  assert.equal(info.category, ErrorCategory.DNS_RESOLUTION);
});

test('classifyNetworkError: unknown errors', () => {
  const info = classifyNetworkError(makeError('RandomError', 'weird thing'));
  assert.equal(info.category, ErrorCategory.UNKNOWN);
});