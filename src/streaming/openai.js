'use strict';

/**
 * Streaming logic for converting the Kiro stream to the OpenAI format.
 *
 * Parses the AWS SSE stream and converts events to OpenAI
 * chat.completion.chunk objects.
 * Mirrors `kiro/streaming_openai.py`.
 */

const { Logger } = require('../logger');
const { parseBracketToolCalls, deduplicateToolCalls } = require('../parsers');
const { generateCompletionId } = require('../utils');
const { FAKE_REASONING_HANDLING } = require('../config');
const { countTokens, countMessageTokens, countToolsTokens } = require('../tokenizer');
const {
  parseKiroStream,
  calculateTokensFromContextUsage,
  streamWithFirstTokenRetry,
  describeAttemptFailure,
} = require('./core');

const logger = new Logger();

/**
 * Formats an OpenAI SSE chunk.
 *
 * @param {object} chunk - Chunk object
 * @returns {string} "data: {...}\n\n" string
 */
function formatOpenAISSE(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Internal generator converting the Kiro stream to the OpenAI format.
 *
 * @param {object} response - HTTP response with the data stream
 * @param {object} options - Streaming options
 * @param {string} options.model - Model name
 * @param {object} options.modelCache - Model cache
 * @param {number} [options.firstTokenTimeout] - First token timeout (seconds)
 * @param {Array<object>|null} [options.requestMessages] - Original request messages (token counting)
 * @param {Array<object>|null} [options.requestTools] - Original request tools (token counting)
 * @returns {AsyncGenerator<string, void, void>} OpenAI SSE chunks
 * @throws {FirstTokenTimeoutError} If the first token is not received in time
 */
async function* streamKiroToOpenAIInternal(response, {
  model,
  modelCache,
  firstTokenTimeout,
  requestMessages = null,
  requestTools = null,
}) {
  const completionId = generateCompletionId();
  const createdTime = Math.floor(Date.now() / 1000);
  let firstChunk = true;

  let meteringData = null;
  let contextUsagePercentage = null;
  let fullContent = '';
  let fullThinkingContent = '';
  let toolCallsFromStream = [];

  try {
    for await (const event of parseKiroStream(response, { firstTokenTimeout })) {
      if (event.type === 'content' && event.content) {
        fullContent += event.content;

        const delta = { content: event.content };
        if (firstChunk) {
          delta.role = 'assistant';
          firstChunk = false;
        }

        yield formatOpenAISSE({
          id: completionId,
          object: 'chat.completion.chunk',
          created: createdTime,
          model,
          choices: [{ index: 0, delta, finish_reason: null }],
        });
      } else if (event.type === 'thinking' && event.thinkingContent) {
        fullThinkingContent += event.thinkingContent;

        const delta =
          FAKE_REASONING_HANDLING === 'as_reasoning_content'
            ? { reasoning_content: event.thinkingContent }
            : { content: event.thinkingContent };

        if (firstChunk) {
          delta.role = 'assistant';
          firstChunk = false;
        }

        yield formatOpenAISSE({
          id: completionId,
          object: 'chat.completion.chunk',
          created: createdTime,
          model,
          choices: [{ index: 0, delta, finish_reason: null }],
        });
      } else if (event.type === 'tool_use' && event.toolUse) {
        toolCallsFromStream.push(event.toolUse);
      } else if (event.type === 'usage' && event.usage) {
        meteringData = event.usage;
      } else if (event.type === 'context_usage' && event.contextUsagePercentage !== null) {
        contextUsagePercentage = event.contextUsagePercentage;
      }
    }

    // Completion signals for truncation detection
    const receivedUsage = meteringData !== null;
    const receivedContextUsage = contextUsagePercentage !== null;
    const streamCompletedNormally = receivedUsage || receivedContextUsage;

    // Check bracket-style tool calls in the full content
    const bracketToolCalls = parseBracketToolCalls(fullContent);
    const allToolCalls = deduplicateToolCalls(toolCallsFromStream.concat(bracketToolCalls));

    const contentWasTruncated =
      !streamCompletedNormally && fullContent.length > 0 && allToolCalls.length === 0;

    if (contentWasTruncated) {
      logger.error(
        `Content truncated by Kiro API: stream ended without completion signals, ` +
          `length=${fullContent.length} chars.`
      );
    }

    // Determine finish_reason (truncation has the highest priority)
    let finishReason;
    if (contentWasTruncated) {
      finishReason = 'length';
    } else if (allToolCalls.length > 0) {
      finishReason = 'tool_calls';
    } else {
      finishReason = 'stop';
    }

    // Count completion tokens
    const completionTokens = countTokens(fullContent + fullThinkingContent);

    // Calculate prompt/total tokens from context usage
    let [promptTokens, totalTokens, promptSource, totalSource] = calculateTokensFromContextUsage(
      contextUsagePercentage,
      completionTokens,
      modelCache,
      model
    );

    // Fallback: count prompt tokens from the original messages
    if (promptSource === 'unknown' && requestMessages) {
      promptTokens = countMessageTokens(requestMessages, false);
      if (requestTools) {
        promptTokens += countToolsTokens(requestTools, false);
      }
      totalTokens = promptTokens + completionTokens;
      promptSource = 'tiktoken';
      totalSource = 'tiktoken';
    }

    // Send tool calls if present
    if (allToolCalls.length > 0) {
      logger.debug(`Processing ${allToolCalls.length} tool calls for streaming response`);

      const indexedToolCalls = allToolCalls.map((tc, idx) => {
        const func = tc.function || {};
        return {
          index: idx,
          id: tc.id,
          type: tc.type || 'function',
          function: {
            name: func.name || '',
            arguments: func.arguments || '{}',
          },
        };
      });

      yield formatOpenAISSE({
        id: completionId,
        object: 'chat.completion.chunk',
        created: createdTime,
        model,
        choices: [
          {
            index: 0,
            delta: { tool_calls: indexedToolCalls },
            finish_reason: null,
          },
        ],
      });
    }

    // Final chunk with usage
    const finalChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created: createdTime,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    };

    if (meteringData) {
      finalChunk.usage.credits_used = meteringData;
    }

    logger.debug(
      `[Usage] ${model}: prompt_tokens=${promptTokens} (${promptSource}), ` +
        `completion_tokens=${completionTokens} (tokenizer), total_tokens=${totalTokens} (${totalSource})`
    );

    yield formatOpenAISSE(finalChunk);
    yield 'data: [DONE]\n\n';
  } catch (err) {
    throw err;
  }
}

/**
 * Generator converting the Kiro stream to the OpenAI format (no retry).
 *
 * @param {object} response - HTTP response
 * @param {object} options - Streaming options
 * @returns {AsyncGenerator<string, void, void>} OpenAI SSE chunks
 */
async function* streamKiroToOpenAI(response, options) {
  yield* streamKiroToOpenAIInternal(response, options);
}

/**
 * Streaming with automatic retry on first token timeout.
 *
 * @param {object} options - Retry options
 * @param {Function} options.makeRequest - Function creating a new HTTP request
 * @param {object} options.initialResponse - Pre-validated response for attempt 1
 * @param {string} options.model - Model name
 * @param {object} options.modelCache - Model cache
 * @param {number} [options.maxRetries] - Maximum attempts
 * @param {number} [options.firstTokenTimeout] - First token timeout (seconds)
 * @param {Array<object>|null} [options.requestMessages] - Original request messages
 * @param {Array<object>|null} [options.requestTools] - Original request tools
 * @returns {AsyncGenerator<string, void, void>} OpenAI SSE chunks
 */
async function* streamWithFirstTokenRetryOpenAI({
  makeRequest,
  initialResponse,
  model,
  modelCache,
  maxRetries,
  firstTokenTimeout,
  requestMessages = null,
  requestTools = null,
}) {
  function createHttpError(statusCode, errorText) {
    const err = new Error(`Upstream API error: ${errorText}`);
    err.statusCode = statusCode;
    return err;
  }

  function createTimeoutError(retries, timeout, lastError) {
    const reason = describeAttemptFailure(lastError, timeout);
    const err = new Error(`Upstream request failed after ${retries} attempts: ${reason}`);
    err.statusCode = lastError && lastError.name === 'FirstTokenTimeoutError' ? 504 : 502;
    return err;
  }

  async function* streamProcessor(response) {
    yield* streamKiroToOpenAIInternal(response, {
      model,
      modelCache,
      firstTokenTimeout,
      requestMessages,
      requestTools,
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
 * Collects the full response from a stream (non-streaming mode).
 *
 * @param {object} response - HTTP response with the stream
 * @param {object} options - Collection options
 * @returns {Promise<object>} Full response in OpenAI chat.completion format
 */
async function collectStreamResponse(response, { model, modelCache, requestMessages = null, requestTools = null }) {
  let fullContent = '';
  let fullReasoningContent = '';
  let finalUsage = null;
  const toolCalls = [];
  let finishReason = 'stop';
  const completionId = generateCompletionId();

  for await (const chunkStr of streamKiroToOpenAI(response, {
    model,
    modelCache,
    requestMessages,
    requestTools,
  })) {
    if (!chunkStr.startsWith('data:')) continue;

    const dataStr = chunkStr.slice('data:'.length).trim();
    if (!dataStr || dataStr === '[DONE]') continue;

    try {
      const chunkData = JSON.parse(dataStr);
      const delta = ((chunkData.choices || [{}])[0] || {}).delta || {};
      if (delta.content) fullContent += delta.content;
      if (delta.reasoning_content) fullReasoningContent += delta.reasoning_content;
      if (delta.tool_calls) toolCalls.push(...delta.tool_calls);

      const finishReasonFromChunk = ((chunkData.choices || [{}])[0] || {}).finish_reason;
      if (finishReasonFromChunk) finishReason = finishReasonFromChunk;

      if (chunkData.usage) finalUsage = chunkData.usage;
    } catch {
      // Skip malformed chunks
    }
  }

  // Form the final response
  const message = { role: 'assistant', content: fullContent };
  if (fullReasoningContent) {
    message.reasoning_content = fullReasoningContent;
  }
  if (toolCalls.length > 0) {
    // Remove the index field (only required for streaming chunks)
    message.tool_calls = toolCalls.map((tc) => {
      const func = tc.function || {};
      return {
        id: tc.id,
        type: tc.type || 'function',
        function: {
          name: func.name || '',
          arguments: func.arguments || '{}',
        },
      };
    });
  }

  const usage = finalUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  return {
    id: completionId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

module.exports = {
  streamKiroToOpenAIInternal,
  streamKiroToOpenAI,
  streamWithFirstTokenRetryOpenAI,
  collectStreamResponse,
};