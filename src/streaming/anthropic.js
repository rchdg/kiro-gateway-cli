'use strict';

/**
 * Streaming logic for converting the Kiro stream to the Anthropic
 * Messages API format.
 *
 * Formats Kiro events into Anthropic SSE events:
 * - event: message_start
 * - event: content_block_start
 * - event: content_block_delta
 * - event: content_block_stop
 * - event: message_delta
 * - event: message_stop
 *
 * Mirrors `kiro/streaming_anthropic.py`.
 */

const { Logger } = require('../logger');
const { generateMessageId, generateThinkingSignature } = require('../utils');
const { parseBracketToolCalls, deduplicateToolCalls } = require('../parsers');
const { FAKE_REASONING_HANDLING } = require('../config');
const { countTokens, estimateRequestTokens } = require('../tokenizer');
const {
  parseKiroStream,
  collectStreamToResult,
  calculateTokensFromContextUsage,
  streamWithFirstTokenRetry,
} = require('./core');

const logger = new Logger();

/**
 * Formats data as an Anthropic SSE event.
 *
 * @param {string} eventType - Event type (message_start, content_block_delta, etc.)
 * @param {object} data - Event data
 * @returns {string} Formatted SSE string
 */
function formatSSEEvent(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Extracts cache token fields from upstream usage.
 *
 * @param {object|null} usage - Usage data from the Kiro stream
 * @returns {object} Cache fields that are present
 */
function extractCacheUsageFields(usage) {
  if (!usage || typeof usage !== 'object') return {};

  const extracted = {};
  const keyMap = {
    cache_read_input_tokens: 'cache_read_input_tokens',
    cacheReadInputTokens: 'cache_read_input_tokens',
    cache_creation_input_tokens: 'cache_creation_input_tokens',
    cacheCreationInputTokens: 'cache_creation_input_tokens',
  };

  for (const [sourceKey, targetKey] of Object.entries(keyMap)) {
    const value = usage[sourceKey];
    if (typeof value === 'number') {
      extracted[targetKey] = Math.floor(value);
    }
  }

  return extracted;
}

/**
 * Generator converting the Kiro stream to the Anthropic SSE format.
 *
 * @param {object} response - HTTP response with the stream
 * @param {object} options - Streaming options
 * @param {string} options.model - Model name
 * @param {object} options.modelCache - Model cache
 * @param {number} [options.firstTokenTimeout] - First token timeout (seconds)
 * @param {Array<object>|null} [options.requestMessages] - Original request messages
 * @param {Array<object>|null} [options.requestTools] - Original request tools
 * @param {any} [options.requestSystem] - Original system prompt
 * @returns {AsyncGenerator<string, void, void>} Anthropic SSE strings
 */
async function* streamKiroToAnthropic(response, {
  model,
  modelCache,
  firstTokenTimeout,
  requestMessages = null,
  requestTools = null,
  requestSystem = null,
}) {
  const messageId = generateMessageId();
  let inputTokens = 0;
  let outputTokens = 0;
  let fullContent = '';
  let fullThinkingContent = '';

  // Anthropic requires input_tokens in message_start, but Kiro provides
  // accurate context_usage only at the end. Use fallback estimation.
  if (requestMessages || requestTools || requestSystem) {
    const stats = estimateRequestTokens({
      messages: requestMessages || [],
      tools: requestTools,
      systemPrompt: requestSystem,
      applyClaudeCorrection: false,
    });
    inputTokens = stats.totalTokens;
  }

  // Track content blocks - thinking block is index 0, text block is index 1
  let currentBlockIndex = 0;
  let thinkingBlockStarted = false;
  let thinkingBlockIndex = null;
  let textBlockStarted = false;
  let textBlockIndex = null;
  const toolBlocks = [];

  const thinkingSignature = generateThinkingSignature();

  let contextUsagePercentage = null;
  const upstreamCacheUsage = {};

  try {
    // Send message_start event
    yield formatSSEEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
        },
      },
    });

    for await (const event of parseKiroStream(response, { firstTokenTimeout })) {
      if (event.type === 'content') {
        const content = event.content || '';
        fullContent += content;

        // Close the thinking block if open
        if (thinkingBlockStarted && thinkingBlockIndex !== null) {
          yield formatSSEEvent('content_block_stop', {
            type: 'content_block_stop',
            index: thinkingBlockIndex,
          });
          thinkingBlockStarted = false;
          currentBlockIndex += 1;
        }

        // Start the text block if not started
        if (!textBlockStarted) {
          textBlockIndex = currentBlockIndex;
          yield formatSSEEvent('content_block_start', {
            type: 'content_block_start',
            index: textBlockIndex,
            content_block: { type: 'text', text: '' },
          });
          textBlockStarted = true;
        }

        if (content) {
          yield formatSSEEvent('content_block_delta', {
            type: 'content_block_delta',
            index: textBlockIndex,
            delta: { type: 'text_delta', text: content },
          });
        }
      } else if (event.type === 'thinking') {
        const thinkingContent = event.thinkingContent || '';
        fullThinkingContent += thinkingContent;

        if (FAKE_REASONING_HANDLING === 'as_reasoning_content') {
          // Native Anthropic thinking content blocks
          if (!thinkingBlockStarted) {
            thinkingBlockIndex = currentBlockIndex;
            yield formatSSEEvent('content_block_start', {
              type: 'content_block_start',
              index: thinkingBlockIndex,
              content_block: {
                type: 'thinking',
                thinking: '',
                signature: thinkingSignature,
              },
            });
            thinkingBlockStarted = true;
          }

          if (thinkingContent) {
            yield formatSSEEvent('content_block_delta', {
              type: 'content_block_delta',
              index: thinkingBlockIndex,
              delta: { type: 'thinking_delta', thinking: thinkingContent },
            });
          }
        }
        // Other handling modes ("strip" skips thinking; "pass"/"strip_tags"
        // are only meaningful for the OpenAI surface)
      } else if (event.type === 'tool_use' && event.toolUse) {
        // Close the thinking block if open
        if (thinkingBlockStarted && thinkingBlockIndex !== null) {
          yield formatSSEEvent('content_block_stop', {
            type: 'content_block_stop',
            index: thinkingBlockIndex,
          });
          thinkingBlockStarted = false;
          currentBlockIndex += 1;
        }

        // Close the text block if open
        if (textBlockStarted && textBlockIndex !== null) {
          yield formatSSEEvent('content_block_stop', {
            type: 'content_block_stop',
            index: textBlockIndex,
          });
          textBlockStarted = false;
          currentBlockIndex += 1;
        }

        const tool = event.toolUse;
        const toolId = tool.id || `toolu_${cryptoRandomHex(12)}`;
        const toolName = (tool.function && tool.function.name) || tool.name || '';
        let toolInput = (tool.function && tool.function.arguments) || tool.input || {};

        // Parse arguments if string
        if (typeof toolInput === 'string') {
          try {
            toolInput = JSON.parse(toolInput);
          } catch {
            toolInput = {};
          }
        }

        // Send tool_use block
        yield formatSSEEvent('content_block_start', {
          type: 'content_block_start',
          index: currentBlockIndex,
          content_block: {
            type: 'tool_use',
            id: toolId,
            name: toolName,
            input: {},
          },
        });

        yield formatSSEEvent('content_block_delta', {
          type: 'content_block_delta',
          index: currentBlockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(toolInput),
          },
        });

        yield formatSSEEvent('content_block_stop', {
          type: 'content_block_stop',
          index: currentBlockIndex,
        });

        toolBlocks.push({ id: toolId, name: toolName, input: toolInput });
        currentBlockIndex += 1;
      } else if (event.type === 'context_usage' && event.contextUsagePercentage !== null) {
        contextUsagePercentage = event.contextUsagePercentage;
      } else if (event.type === 'usage' && event.usage) {
        Object.assign(upstreamCacheUsage, extractCacheUsageFields(event.usage));
      }
    }

    // Track completion signals for truncation detection
    const streamCompletedNormally = contextUsagePercentage !== null;

    // Check bracket-style tool calls in the full content
    const bracketToolCalls = parseBracketToolCalls(fullContent);
    if (bracketToolCalls.length > 0) {
      // Close open blocks
      if (thinkingBlockStarted && thinkingBlockIndex !== null) {
        yield formatSSEEvent('content_block_stop', {
          type: 'content_block_stop',
          index: thinkingBlockIndex,
        });
        thinkingBlockStarted = false;
        currentBlockIndex += 1;
      }

      if (textBlockStarted && textBlockIndex !== null) {
        yield formatSSEEvent('content_block_stop', {
          type: 'content_block_stop',
          index: textBlockIndex,
        });
        textBlockStarted = false;
        currentBlockIndex += 1;
      }

      for (const tc of deduplicateToolCalls(bracketToolCalls)) {
        const toolId = tc.id || `toolu_${cryptoRandomHex(12)}`;
        const toolName = (tc.function && tc.function.name) || '';
        let toolInput = (tc.function && tc.function.arguments) || {};

        if (typeof toolInput === 'string') {
          try {
            toolInput = JSON.parse(toolInput);
          } catch {
            toolInput = {};
          }
        }

        yield formatSSEEvent('content_block_start', {
          type: 'content_block_start',
          index: currentBlockIndex,
          content_block: {
            type: 'tool_use',
            id: toolId,
            name: toolName,
            input: {},
          },
        });

        yield formatSSEEvent('content_block_delta', {
          type: 'content_block_delta',
          index: currentBlockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(toolInput),
          },
        });

        yield formatSSEEvent('content_block_stop', {
          type: 'content_block_stop',
          index: currentBlockIndex,
        });

        toolBlocks.push({ id: toolId, name: toolName, input: toolInput });
        currentBlockIndex += 1;
      }
    }

    // Close the thinking block if still open
    if (thinkingBlockStarted && thinkingBlockIndex !== null) {
      yield formatSSEEvent('content_block_stop', {
        type: 'content_block_stop',
        index: thinkingBlockIndex,
      });
      currentBlockIndex += 1;
    }

    // Close the text block if still open
    if (textBlockStarted && textBlockIndex !== null) {
      yield formatSSEEvent('content_block_stop', {
        type: 'content_block_stop',
        index: textBlockIndex,
      });
    }

    // Detect content truncation (missing completion signals)
    const contentWasTruncated =
      !streamCompletedNormally && fullContent.length > 0 && toolBlocks.length === 0;

    if (contentWasTruncated) {
      logger.error(
        `Content truncated by Kiro API: stream ended without completion signals, ` +
          `length=${fullContent.length} chars.`
      );
    }

    // Calculate output tokens
    outputTokens = countTokens(fullContent + fullThinkingContent);

    // Calculate input tokens from context usage if available
    if (contextUsagePercentage !== null) {
      const [promptTokens, , promptSource] = calculateTokensFromContextUsage(
        contextUsagePercentage,
        outputTokens,
        modelCache,
        model
      );
      // Only override the fallback when upstream context usage is available
      if (promptSource !== 'unknown') {
        inputTokens = promptTokens;
      }
    }

    // Determine the stop reason (truncation has the highest priority)
    let stopReason;
    if (contentWasTruncated) {
      stopReason = 'max_tokens';
    } else if (toolBlocks.length > 0) {
      stopReason = 'tool_use';
    } else {
      stopReason = 'end_turn';
    }

    // Send message_delta with the stop reason and usage
    const usagePayload = { output_tokens: outputTokens };
    Object.assign(usagePayload, upstreamCacheUsage);

    yield formatSSEEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: usagePayload,
    });

    // Send message_stop
    yield formatSSEEvent('message_stop', {
      type: 'message_stop',
    });

    logger.debug(
      `[Anthropic Streaming] Completed: input_tokens=${inputTokens}, output_tokens=${outputTokens}, ` +
        `tool_blocks=${toolBlocks.length}, stop_reason=${stopReason}`
    );
  } catch (err) {
    throw err;
  }
}

/**
 * Collects the full response from a stream (non-streaming mode).
 *
 * @param {object} response - HTTP response with the stream
 * @param {object} options - Collection options
 * @returns {Promise<object>} Full response in Anthropic Messages format
 */
async function collectAnthropicResponse(response, { model, modelCache, requestMessages = null, requestTools = null, requestSystem = null }) {
  const messageId = generateMessageId();

  // Non-streaming uses the same estimation as streaming
  let inputTokens = 0;
  if (requestMessages || requestTools || requestSystem) {
    const stats = estimateRequestTokens({
      messages: requestMessages || [],
      tools: requestTools,
      systemPrompt: requestSystem,
      applyClaudeCorrection: false,
    });
    inputTokens = stats.totalTokens;
  }

  // Collect the stream result
  const result = await collectStreamToResult(response);
  const upstreamCacheUsage = extractCacheUsageFields(result.usage);

  // Build content blocks
  const contentBlocks = [];

  // Thinking block FIRST if there's thinking content
  if (result.thinkingContent && FAKE_REASONING_HANDLING === 'as_reasoning_content') {
    contentBlocks.push({
      type: 'thinking',
      thinking: result.thinkingContent,
      signature: generateThinkingSignature(),
    });
  }

  if (result.content) {
    contentBlocks.push({
      type: 'text',
      text: result.content,
    });
  }

  // Add tool use blocks
  for (const tc of result.toolCalls) {
    const toolId = tc.id || `toolu_${cryptoRandomHex(12)}`;
    const toolName = (tc.function && tc.function.name) || tc.name || '';
    let toolInput = (tc.function && tc.function.arguments) || tc.input || {};

    if (typeof toolInput === 'string') {
      try {
        toolInput = JSON.parse(toolInput);
      } catch {
        toolInput = {};
      }
    }

    contentBlocks.push({
      type: 'tool_use',
      id: toolId,
      name: toolName,
      input: toolInput,
    });
  }

  // Calculate output tokens
  const outputTokens = countTokens(result.content + result.thinkingContent);

  // Calculate input tokens from context usage if available
  if (result.contextUsagePercentage !== null) {
    const [promptTokens, , promptSource] = calculateTokensFromContextUsage(
      result.contextUsagePercentage,
      outputTokens,
      modelCache,
      model
    );
    if (promptSource !== 'unknown') {
      inputTokens = promptTokens;
    }
  }

  // Detect content truncation
  const streamCompletedNormally = result.contextUsagePercentage !== null;
  const contentWasTruncated =
    !streamCompletedNormally && result.content.length > 0 && result.toolCalls.length === 0;

  if (contentWasTruncated) {
    logger.error(
      `Content truncated by Kiro API (non-streaming): stream ended without completion signals, ` +
        `length=${result.content.length} chars.`
    );
  }

  // Determine the stop reason
  let stopReason;
  if (contentWasTruncated) {
    stopReason = 'max_tokens';
  } else if (result.toolCalls.length > 0) {
    stopReason = 'tool_use';
  } else {
    stopReason = 'end_turn';
  }

  const usagePayload = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
  Object.assign(usagePayload, upstreamCacheUsage);

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usagePayload,
  };
}

/**
 * Streaming with automatic retry on first token timeout (Anthropic).
 *
 * @param {object} options - Retry options
 * @returns {AsyncGenerator<string, void, void>} Anthropic SSE strings
 */
async function* streamWithFirstTokenRetryAnthropic({
  makeRequest,
  model,
  modelCache,
  initialResponse,
  maxRetries,
  firstTokenTimeout,
  requestMessages = null,
  requestTools = null,
  requestSystem = null,
}) {
  function createHttpError(statusCode, errorText) {
    const err = new Error(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Upstream API error: ${errorText}`,
        },
      })
    );
    err.statusCode = statusCode;
    return err;
  }

  function createTimeoutError(retries, timeout) {
    const err = new Error(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'timeout_error',
          message: `Model did not respond within ${timeout}s after ${retries} attempts. Please try again.`,
        },
      })
    );
    err.statusCode = 504;
    return err;
  }

  async function* streamProcessor(response) {
    yield* streamKiroToAnthropic(response, {
      model,
      modelCache,
      firstTokenTimeout,
      requestMessages,
      requestTools,
      requestSystem,
    });
  }

  yield* streamWithFirstTokenRetry({
    makeRequest,
    streamProcessor,
    initialResponse,
    maxRetries,
    firstTokenTimeout,
    onHttpError: createHttpError,
    onAllRetriesFailed: createTimeoutError,
  });
}

/**
 * Generates a random hex string.
 *
 * @param {number} byteLength - Number of bytes
 * @returns {string} Hex string
 */
function cryptoRandomHex(byteLength) {
  const crypto = require('node:crypto');
  return crypto.randomBytes(byteLength).toString('hex');
}

module.exports = {
  formatSSEEvent,
  extractCacheUsageFields,
  streamKiroToAnthropic,
  collectAnthropicResponse,
  streamWithFirstTokenRetryAnthropic,
};