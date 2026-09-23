'use strict';

/**
 * Core streaming logic for parsing Kiro API responses.
 *
 * Shared logic used by both OpenAI and Anthropic streaming:
 * - KiroEvent unified event objects
 * - Kiro SSE stream parsing
 * - Full response collection
 * - First token timeout handling and retry
 *
 * Mirrors `kiro/streaming_core.py`.
 */

const { Logger } = require('../logger');
const { AwsEventStreamParser, parseBracketToolCalls, deduplicateToolCalls } = require('../parsers');
const { ThinkingParser } = require('../thinkingParser');
const { classifyNetworkError } = require('../errors');
const {
  FIRST_TOKEN_TIMEOUT,
  FIRST_TOKEN_MAX_RETRIES,
  STREAMING_READ_TIMEOUT,
  STREAM_KEEPALIVE_INTERVAL,
  FAKE_REASONING_ENABLED,
  FAKE_REASONING_HANDLING,
} = require('../config');

const logger = new Logger();

// Distinguishes "the idle timer won the race" from a real iterator result,
// which can legitimately be any value including undefined.
const KEEPALIVE_TICK = Symbol('keepalive-tick');

class FirstTokenTimeoutError extends Error {
  constructor(timeout) {
    super(`No response within ${timeout} seconds`);
    this.name = 'FirstTokenTimeoutError';
  }
}

class ReadTimeoutError extends Error {
  constructor(timeout) {
    super(`No data received within ${timeout} seconds`);
    this.name = 'ReadTimeoutError';
  }
}

/**
 * The upstream answered 200 but closed the body without a single event.
 *
 * Returning normally here would hand the client a successful-but-empty
 * response, which is indistinguishable from "the model had nothing to say".
 * It is raised instead so the retry loop gets a chance and, if every attempt
 * ends the same way, the client is told what actually happened.
 */
class EmptyUpstreamStreamError extends Error {
  constructor() {
    super('Kiro API closed the response without sending any data');
    this.name = 'EmptyUpstreamStreamError';
  }
}

/**
 * Creates a KiroEvent object.
 *
 * @param {object} options - Event fields
 * @returns {object} KiroEvent
 */
function makeKiroEvent({
  type,
  content = null,
  thinkingContent = null,
  toolUse = null,
  usage = null,
  contextUsagePercentage = null,
  isFirstThinkingChunk = false,
  isLastThinkingChunk = false,
}) {
  return {
    type,
    content,
    thinkingContent,
    toolUse,
    usage,
    contextUsagePercentage,
    isFirstThinkingChunk,
    isLastThinkingChunk,
  };
}

/**
 * Races a promise against a timeout.
 *
 * @param {Promise} promise - Promise to race
 * @param {number} ms - Timeout in milliseconds
 * @param {Error} timeoutError - Error to reject with on timeout
 * @returns {Promise<any>} Result of the promise
 */
function raceWithTimeout(promise, ms, timeoutError) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Iterates an async iterator with a per-chunk read timeout.
 *
 * @param {AsyncIterator} iterator - Iterator over body chunks
 * @param {number} readTimeout - Per-chunk read timeout (seconds)
 * @returns {AsyncGenerator<string, void, void>} Decoded text chunks
 */
async function* iterateIteratorWithTimeouts(iterator, readTimeout) {
  const decoder = new TextDecoder();

  while (true) {
    let next;
    try {
      next = await raceWithTimeout(
        iterator.next(),
        readTimeout * 1000,
        new ReadTimeoutError(readTimeout)
      );
    } catch (err) {
      if (err instanceof ReadTimeoutError) {
        logger.warning(`[ReadTimeout] No data from Kiro API within ${readTimeout}s`);
        throw err;
      }
      throw err;
    }

    if (next.done) break;
    yield decoder.decode(next.value, { stream: true });
  }

  // Flush any remaining decoded bytes
  const tail = decoder.decode();
  if (tail) {
    yield tail;
  }
}

/**
 * Parses the Kiro SSE stream and yields unified events.
 *
 * @param {object} response - HTTP response with the data stream
 * @param {object} [options] - Parse options
 * @param {number} [options.firstTokenTimeout=FIRST_TOKEN_TIMEOUT] - First token timeout (seconds)
 * @param {boolean} [options.enableThinkingParser=true] - Enable thinking block parsing
 * @returns {AsyncGenerator<object, void, void>} KiroEvent objects
 * @throws {FirstTokenTimeoutError} If the first token is not received in time
 */
async function* parseKiroStream(response, { firstTokenTimeout = FIRST_TOKEN_TIMEOUT, enableThinkingParser = true } = {}) {
  const parser = new AwsEventStreamParser();

  let thinkingParser = null;
  if (FAKE_REASONING_ENABLED && enableThinkingParser) {
    thinkingParser = new ThinkingParser({ handlingMode: FAKE_REASONING_HANDLING });
    logger.debug(`Thinking parser initialized with mode: ${FAKE_REASONING_HANDLING}`);
  }

  try {
    // Wait for the first chunk with the first-token timeout
    const iterator = response.body[Symbol.asyncIterator]();
    let firstChunk;
    try {
      logger.debug(`Waiting for first token (timeout=${firstTokenTimeout}s)...`);
      const first = await raceWithTimeout(
        iterator.next(),
        firstTokenTimeout * 1000,
        new FirstTokenTimeoutError(firstTokenTimeout)
      );
      if (first.done) {
        logger.warning('[EmptyStream] Kiro API closed the response without sending any data');
        throw new EmptyUpstreamStreamError();
      }
      firstChunk = new TextDecoder().decode(first.value);
      logger.debug('First token received');
    } catch (err) {
      if (err instanceof FirstTokenTimeoutError) {
        logger.warning(`[FirstTokenTimeout] Model did not respond within ${firstTokenTimeout}s`);
        throw err;
      }
      throw err;
    }

    // Process the first chunk
    for (const event of processChunk(parser, firstChunk, thinkingParser)) {
      yield event;
    }

    // Continue reading remaining chunks with the read timeout
    for await (const chunk of iterateIteratorWithTimeouts(
      iterator,
      STREAMING_READ_TIMEOUT
    )) {
      for (const event of processChunk(parser, chunk, thinkingParser)) {
        yield event;
      }
    }

  // Finalize the thinking parser and yield any remaining content
    if (thinkingParser) {
      const finalResult = thinkingParser.finalize();

      if (finalResult.thinkingContent) {
        const processedThinking = thinkingParser.processForOutput(
          finalResult.thinkingContent,
          finalResult.isFirstThinkingChunk,
          finalResult.isLastThinkingChunk
        );
        if (processedThinking) {
          yield makeKiroEvent({
            type: 'thinking',
            thinkingContent: processedThinking,
            isFirstThinkingChunk: finalResult.isFirstThinkingChunk,
            isLastThinkingChunk: finalResult.isLastThinkingChunk,
          });
        }
      }

      if (finalResult.regularContent) {
        yield makeKiroEvent({ type: 'content', content: finalResult.regularContent });
      }
    }

    // Yield tool calls collected by the parser
    const allToolCalls = parser.getToolCalls();
    for (const tc of allToolCalls) {
      yield makeKiroEvent({ type: 'tool_use', toolUse: tc });
    }
  } finally {
    // Always cancel the upstream body when the stream ends or the
    // consumer aborts (client disconnect, first-token retry, etc.)
    if (response.body && typeof response.body.cancel === 'function') {
      try {
        await response.body.cancel();
      } catch {
        // Already cancelled or closed
      }
    }
  }
}

/**
 * Processes a single chunk from the Kiro stream.
 *
 * @param {AwsEventStreamParser} parser - Event stream parser
 * @param {string} chunk - Decoded text chunk
 * @param {ThinkingParser|null} thinkingParser - Thinking parser or null
 * @returns {Array<object>} KiroEvent objects
 */
function processChunk(parser, chunk, thinkingParser) {
  const events = [];
  const parsed = parser.feed(chunk);

  for (const event of parsed) {
    if (event.type === 'content') {
      const content = event.data;

      if (thinkingParser) {
        const parseResult = thinkingParser.feed(content);

        if (parseResult.thinkingContent) {
          const processedThinking = thinkingParser.processForOutput(
            parseResult.thinkingContent,
            parseResult.isFirstThinkingChunk,
            parseResult.isLastThinkingChunk
          );
          if (processedThinking) {
            events.push(
              makeKiroEvent({
                type: 'thinking',
                thinkingContent: processedThinking,
                isFirstThinkingChunk: parseResult.isFirstThinkingChunk,
                isLastThinkingChunk: parseResult.isLastThinkingChunk,
              })
            );
          }
        }

        if (parseResult.regularContent) {
          events.push(makeKiroEvent({ type: 'content', content: parseResult.regularContent }));
        }
      } else {
        events.push(makeKiroEvent({ type: 'content', content }));
      }
    } else if (event.type === 'usage') {
      events.push(makeKiroEvent({ type: 'usage', usage: event.data }));
    } else if (event.type === 'context_usage') {
      events.push(makeKiroEvent({ type: 'context_usage', contextUsagePercentage: event.data }));
    }
  }

  return events;
}

// ==================================================================================================
// Full Response Collection
// ==================================================================================================

/**
 * Collects the full response from a Kiro stream.
 *
 * @param {object} response - HTTP response with the stream
 * @param {object} [options] - Collection options
 * @returns {Promise<object>} StreamResult with accumulated data
 */
async function collectStreamToResult(response, options = {}) {
  const result = {
    content: '',
    thinkingContent: '',
    toolCalls: [],
    usage: null,
    contextUsagePercentage: null,
  };
  let fullContentForBracketTools = '';

  for await (const event of parseKiroStream(response, options)) {
    if (event.type === 'content' && event.content) {
      result.content += event.content;
      fullContentForBracketTools += event.content;
    } else if (event.type === 'thinking' && event.thinkingContent) {
      result.thinkingContent += event.thinkingContent;
      fullContentForBracketTools += event.thinkingContent;
    } else if (event.type === 'tool_use' && event.toolUse) {
      result.toolCalls.push(event.toolUse);
    } else if (event.type === 'usage' && event.usage) {
      result.usage = event.usage;
    } else if (event.type === 'context_usage' && event.contextUsagePercentage !== null) {
      result.contextUsagePercentage = event.contextUsagePercentage;
    }
  }

  // Check for bracket-style tool calls in the full content
  const bracketToolCalls = parseBracketToolCalls(fullContentForBracketTools);
  if (bracketToolCalls.length > 0) {
    result.toolCalls = deduplicateToolCalls(result.toolCalls.concat(bracketToolCalls));
  }

  return result;
}

// ==================================================================================================
// Token Counting Utilities
// ==================================================================================================

/**
 * Calculates token counts from Kiro's context usage percentage.
 *
 * @param {number|null} contextUsagePercentage - Context usage percentage
 * @param {number} completionTokens - Completion token count
 * @param {object} modelCache - Model cache for max input tokens
 * @param {string} model - Model name
 * @returns {[number, number, string, string]} [promptTokens, totalTokens, promptSource, totalSource]
 */
function calculateTokensFromContextUsage(contextUsagePercentage, completionTokens, modelCache, model) {
  if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
    const maxInputTokens = modelCache.getMaxInputTokens(model);
    const totalTokens = Math.floor((contextUsagePercentage / 100) * maxInputTokens);
    const promptTokens = Math.max(0, totalTokens - completionTokens);
    return [promptTokens, totalTokens, 'subtraction', 'API Kiro'];
  }

  return [0, completionTokens, 'unknown', 'tiktoken'];
}

// ==================================================================================================
// First Token Retry Logic
// ==================================================================================================

/**
 * Generic streaming with automatic retry on first token timeout.
 *
 * @param {object} options - Retry options
 * @param {Function} options.makeRequest - Function creating a new HTTP request
 * @param {Function} options.streamProcessor - Function processing the response (async generator)
 * @param {object|null} [options.initialResponse] - Pre-validated response to reuse for attempt 1
 * @param {number} [options.maxRetries=FIRST_TOKEN_MAX_RETRIES] - Maximum attempts
 * @param {number} [options.firstTokenTimeout=FIRST_TOKEN_TIMEOUT] - First token timeout (seconds)
 * @param {Function|null} [options.onHttpError] - Creates an exception for HTTP errors
 * @param {Function|null} [options.onAllRetriesFailed] - Creates an exception when all retries fail
 * @returns {AsyncGenerator<string, void, void>} SSE strings from the stream processor
 */
async function* streamWithFirstTokenRetry({
  makeRequest,
  streamProcessor,
  initialResponse = null,
  maxRetries = FIRST_TOKEN_MAX_RETRIES,
  firstTokenTimeout = FIRST_TOKEN_TIMEOUT,
  onHttpError = null,
  onAllRetriesFailed = null,
}) {
  let lastError = null;
  // Set once any chunk has been handed to the consumer: past that point a
  // mid-stream failure can no longer be retried transparently.
  let yielded = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let response = null;
    try {
      if (attempt > 0) {
        logger.warning(`Retry attempt ${attempt + 1}/${maxRetries} after first token timeout`);
      }

      // On the first attempt, reuse the initial response if provided
      if (attempt === 0 && initialResponse) {
        response = initialResponse;
        logger.debug('Reusing initial response for first attempt');
      } else {
        response = await makeRequest();
      }

      if (response.statusCode !== 200) {
        // Error from the API - read the body and raise
        let errorText = 'Unknown error';
        try {
          errorText = await readBodyText(response.body);
        } catch {
          // Body already consumed
        }
        try {
          await cancelBody(response.body);
        } catch {
          // Already cancelled
        }

        logger.error(`Error from Kiro API: ${response.statusCode} - ${errorText}`);

        if (onHttpError) {
          const httpError = onHttpError(response.statusCode, errorText);
          httpError.isUpstreamHttpError = true;
          throw httpError;
        }
        const fallbackError = new Error(`Upstream API error (${response.statusCode}): ${errorText}`);
        fallbackError.isUpstreamHttpError = true;
        throw fallbackError;
      }

      // Stream with the first token timeout handled by the processor.
      // Anything handed to the consumer may already be written to the
      // client, so only errors before the first chunk are retryable.
      for await (const chunk of streamProcessor(response)) {
        yielded = true;
        yield chunk;
      }

      // Successfully completed
      return;
    } catch (err) {
      const cancelCurrentResponse = async () => {
        if (response) {
          try {
            await cancelBody(response.body);
          } catch {
            // Already cancelled
          }
        }
      };

      // AbortError - client disconnected, propagate immediately
      if (err && (err.name === 'AbortError' || (err.cause && err.cause.code === 'UND_ERR_ABORTED'))) {
        await cancelCurrentResponse();
        throw err;
      }

      if (err instanceof FirstTokenTimeoutError) {
        lastError = err;
        logger.warning(
          `[FirstTokenTimeout] Attempt ${attempt + 1}/${maxRetries} failed - ` +
            `model did not respond within ${firstTokenTimeout}s`
        );

        await cancelCurrentResponse();
        continue;
      }

      if (err instanceof EmptyUpstreamStreamError) {
        lastError = err;
        logger.warning(
          `[EmptyStream] Attempt ${attempt + 1}/${maxRetries} failed - ` +
            'upstream closed the response without sending any data'
        );

        await cancelCurrentResponse();
        continue;
      }

      // Upstream HTTP errors are deterministic for this request - no retry
      if (err.isUpstreamHttpError) {
        await cancelCurrentResponse();
        throw err;
      }

      // Retryable network errors (connection resets, proxy blips, ...) are
      // safe to retry with a fresh connection as long as nothing was sent
      // to the client yet.
      if (!yielded) {
        const errorInfo = classifyNetworkError(err);
        if (errorInfo.isRetryable) {
          lastError = err;
          logger.warning(
            `${errorInfo.userMessage} before any data was sent - ` +
              `retrying (attempt ${attempt + 1}/${maxRetries})`
          );
          await cancelCurrentResponse();
          continue;
        }
      }

      // Other errors - no retry, propagate
      logger.error(`Unexpected error during streaming: ${err.message}`);
      await cancelCurrentResponse();
      throw err;
    }
  }

  // All attempts exhausted. `lastError` is what actually kept failing, which is
  // often not a first token timeout at all (connection resets and empty upstream
  // streams land here too), so it is what the client gets told about.
  const lastReason = describeAttemptFailure(lastError, firstTokenTimeout);
  logger.error(`[StreamFailed] All ${maxRetries} attempts exhausted - ${lastReason}`);

  if (onAllRetriesFailed) {
    throw onAllRetriesFailed(maxRetries, firstTokenTimeout, lastError);
  }
  throw new Error(`Upstream request failed after ${maxRetries} attempts: ${lastReason}`);
}

/**
 * One-line explanation of why a single attempt failed, for logs and for the
 * message handed to the API client.
 *
 * @param {Error|null} error - The failure of the last attempt
 * @param {number} firstTokenTimeout - First token timeout in seconds
 * @returns {string} Human-readable reason
 */
function describeAttemptFailure(error, firstTokenTimeout) {
  if (error instanceof FirstTokenTimeoutError) {
    return `model did not respond within ${firstTokenTimeout}s per attempt`;
  }
  if (error instanceof EmptyUpstreamStreamError) {
    return 'Kiro API closed the response without sending any data';
  }
  if (error) {
    const info = classifyNetworkError(error);
    return `${info.userMessage} (${info.technicalDetails})`;
  }
  return 'no successful attempt and no error recorded';
}

/**
 * Forwards a chunk generator, injecting a keepalive chunk whenever the source
 * stays silent for longer than `intervalSeconds`.
 *
 * The gateway has two unavoidable silent stretches: waiting for the upstream
 * first token (up to FIRST_TOKEN_TIMEOUT per attempt, retried), and buffering
 * a tool call, whose argument fragments yield no output event until the
 * upstream stream ends. Both look identical to a dead connection from the
 * client side, and clients act on that: min-agent aborts after 90s of silence,
 * which truncates the response mid-body. Keepalive bytes keep the body alive
 * without altering the event sequence - SSE comments and Anthropic `ping`
 * events are both ignored by conforming parsers.
 *
 * @param {AsyncIterable<string>} source - Upstream chunk generator
 * @param {object} options - Keepalive options
 * @param {string} options.keepaliveChunk - Chunk emitted while the source is silent
 * @param {number} [options.intervalSeconds=STREAM_KEEPALIVE_INTERVAL] - Silence
 *   threshold in seconds; 0 or less disables keepalive entirely
 * @returns {AsyncGenerator<string, void, void>} Source chunks plus keepalives
 */
async function* withKeepalive(source, {
  keepaliveChunk,
  intervalSeconds = STREAM_KEEPALIVE_INTERVAL,
} = {}) {
  if (!keepaliveChunk || !(intervalSeconds > 0)) {
    yield* source;
    return;
  }

  const iterator = source[Symbol.asyncIterator]();
  const intervalMs = intervalSeconds * 1000;

  // A single pending next() must survive across keepalive ticks: calling
  // next() again before the previous one settles would drop chunks.
  let pending = null;
  try {
    while (true) {
      if (!pending) pending = iterator.next();

      let timer;
      const idle = new Promise((resolve) => {
        timer = setTimeout(() => resolve(KEEPALIVE_TICK), intervalMs);
      });

      let settled;
      try {
        settled = await Promise.race([pending, idle]);
      } finally {
        clearTimeout(timer);
      }

      if (settled === KEEPALIVE_TICK) {
        yield keepaliveChunk;
        continue;
      }

      pending = null;
      if (settled.done) return;
      yield settled.value;
    }
  } finally {
    // Swallow the abandoned next() so an aborted upstream cannot surface as an
    // unhandled rejection after the consumer walked away.
    if (pending) pending.catch(() => {});
    if (typeof iterator.return === 'function') {
      try {
        await iterator.return();
      } catch {
        // Generator already finished
      }
    }
  }
}

/**
 * Reads the full text of a response body.
 *
 * @param {object} body - undici body stream
 * @returns {Promise<string>} Body text
 */
async function readBodyText(body) {
  let text = '';
  for await (const chunk of body) {
    text += Buffer.from(chunk).toString('utf8');
    if (text.length > 1024 * 1024) break;
  }
  return text;
}

/**
 * Cancels a response body stream.
 *
 * @param {object} body - undici body stream
 */
async function cancelBody(body) {
  try {
    if (body && typeof body.cancel === 'function') {
      await body.cancel();
    }
  } catch {
    // Already cancelled or closed
  }
}

module.exports = {
  FirstTokenTimeoutError,
  ReadTimeoutError,
  EmptyUpstreamStreamError,
  makeKiroEvent,
  parseKiroStream,
  processChunk,
  collectStreamToResult,
  calculateTokensFromContextUsage,
  streamWithFirstTokenRetry,
  describeAttemptFailure,
  withKeepalive,
  readBodyText,
  cancelBody,
};