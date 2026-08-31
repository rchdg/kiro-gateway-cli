'use strict';

/**
 * Express server with OpenAI- and Anthropic-compatible API routes.
 *
 * Endpoints:
 * - GET /, /health: health checks
 * - GET /v1/models: model list
 * - POST /v1/chat/completions: OpenAI chat completions (streaming + non-streaming)
 * - POST /v1/messages: Anthropic messages (streaming + non-streaming)
 * - POST /v1/messages/count_tokens: Anthropic token estimation
 *
 * Mirrors `main.py`, `kiro/routes_openai.py`, and `kiro/routes_anthropic.py`.
 */

const express = require('express');
const { Logger } = require('./logger');
const { ApiError, ErrorType, classifyError, parseKiroError } = require('./errors');
const { KiroHttpClient } = require('./httpClient');
const { buildKiroPayloadOpenAI } = require('./converters/openai');
const { anthropicToKiro } = require('./converters/anthropic');
const {
  streamWithFirstTokenRetryOpenAI,
  collectStreamResponse,
} = require('./streaming/openai');
const {
  streamWithFirstTokenRetryAnthropic,
  collectAnthropicResponse,
} = require('./streaming/anthropic');
const { estimateRequestTokens } = require('./tokenizer');
const { generateConversationId } = require('./utils');
const {
  PROXY_API_KEY,
  PROFILE_ARN,
  APP_VERSION,
  APP_TITLE,
  APP_DESCRIPTION,
} = require('./config');

const logger = new Logger();

// ==================================================================================================
// Small HTTP helpers
// ==================================================================================================

/**
 * Reads the full text of a response body safely (bounded).
 *
 * @param {object} body - undici body stream
 * @returns {Promise<string>} Body text
 */
async function readBodyTextSafe(body) {
  try {
    let text = '';
    for await (const chunk of body) {
      text += Buffer.from(chunk).toString('utf8');
      if (text.length > 1024 * 1024) break;
    }
    return text;
  } catch {
    return '';
  }
}

/**
 * Sends an error in OpenAI format.
 *
 * @param {object} res - Express response
 * @param {number} status - HTTP status code
 * @param {string} message - Error message
 */
function sendOpenAIError(res, status, message) {
  return res.status(status).json({
    error: {
      message,
      type: 'kiro_api_error',
      code: status,
    },
  });
}

/**
 * Sends an error in Anthropic format.
 *
 * @param {object} res - Express response
 * @param {number} status - HTTP status code
 * @param {string} message - Error message
 * @param {string} [errorType='api_error'] - Anthropic error type
 */
function sendAnthropicError(res, status, message, errorType = 'api_error') {
  return res.status(status).json({
    type: 'error',
    error: {
      type: errorType,
      message,
    },
  });
}

/**
 * Wraps an async route handler, converting thrown errors into 500s.
 *
 * @param {Function} handler - Async route handler
 * @returns {Function} Express middleware
 */
function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      logger.error(`Internal server error: ${err.message}`);
      if (req.path === '/v1/messages') {
        sendAnthropicError(res, 500, `Internal Server Error: ${err.message}`);
      } else {
        sendOpenAIError(res, 500, `Internal Server Error: ${err.message}`);
      }
    });
  };
}

// ==================================================================================================
// Server factory
// ==================================================================================================

/**
 * Creates the Express application.
 *
 * @param {object} options - Server options
 * @param {AccountManager} options.accountManager - Account manager
 * @param {boolean} [options.accountSystem=false] - Account system mode
 * @returns {object} Express app
 */
function createServer({ accountManager, accountSystem = false }) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '25mb' }));

  // ==================================================================================================
  // Authentication
  // ==================================================================================================

  /**
   * Verifies the API key for OpenAI endpoints (Authorization: Bearer).
   *
   * When PROXY_API_KEY is not configured, authentication is disabled and
   * all requests pass through.
   *
   * @param {object} req - Express request
   * @param {object} res - Express response
   * @param {Function} next - Next middleware
   */
  function verifyOpenAIKey(req, res, next) {
    if (!PROXY_API_KEY) return next();
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${PROXY_API_KEY}`) {
      logger.warning('Access attempt with invalid API key (OpenAI endpoint)');
      return sendOpenAIError(res, 401, 'Invalid or missing API Key');
    }
    next();
  }

  /**
   * Verifies the API key for Anthropic endpoints (x-api-key or Bearer).
   *
   * When PROXY_API_KEY is not configured, authentication is disabled and
   * all requests pass through.
   *
   * @param {object} req - Express request
   * @param {object} res - Express response
   * @param {Function} next - Next middleware
   */
  function verifyAnthropicKey(req, res, next) {
    if (!PROXY_API_KEY) return next();
    const xApiKey = req.headers['x-api-key'];
    const authorization = req.headers.authorization || '';

    if (xApiKey === PROXY_API_KEY || authorization === `Bearer ${PROXY_API_KEY}`) {
      return next();
    }

    logger.warning('Access attempt with invalid API key (Anthropic endpoint)');
    return sendAnthropicError(
      res,
      401,
      'Invalid or missing API key. Use x-api-key header or Authorization: Bearer.',
      'authentication_error'
    );
  }

  // ==================================================================================================
  // Health checks
  // ==================================================================================================

  app.get('/', (req, res) => {
    res.json({
      status: 'ok',
      message: 'Kiro Gateway is running',
      version: APP_VERSION,
    });
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: APP_VERSION,
    });
  });

  // ==================================================================================================
  // Models list
  // ==================================================================================================

  app.get('/v1/models', verifyOpenAIKey, (req, res) => {
    logger.info('Request to /v1/models');

    let availableModelIds;
    if (accountSystem) {
      availableModelIds = accountManager.getAllAvailableModels();
    } else {
      const account = accountManager.getFirstAccount();
      availableModelIds = account.modelResolver.getAvailableModels();
    }

    res.json({
      object: 'list',
      data: availableModelIds.map((modelId) => ({
        id: modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'anthropic',
        description: 'Claude model via Kiro API',
      })),
    });
  });

  // ==================================================================================================
  // OpenAI chat completions
  // ==================================================================================================

  app.post('/v1/chat/completions', verifyOpenAIKey, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const model = body.model;
    const stream = Boolean(body.stream);

    logger.info(`Request to /v1/chat/completions (model=${model}, stream=${stream})`);

    // Basic validation
    if (!model) {
      return sendOpenAIError(res, 400, 'The model parameter is required.');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return sendOpenAIError(res, 400, 'The messages parameter must be a non-empty array.');
    }

    // Abort upstream requests when the client disconnects
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        ac.abort();
      }
    });

    const allAccountIds = accountManager.accountIds;
    const MAX_ATTEMPTS = allAccountIds.length * 2;
    const triedAccounts = new Set();
    let lastErrorMessage = null;
    let lastErrorStatus = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const account = await accountManager.getNextAccount(model, triedAccounts);

      if (!account) {
        if (allAccountIds.length === 1) {
          return sendOpenAIError(res, lastErrorStatus || 503, lastErrorMessage || 'Account unavailable');
        }
        const detail =
          'No available accounts for this model.' +
          (lastErrorMessage ? ` Error from last account: ${lastErrorMessage}` : '');
        return sendOpenAIError(res, 503, detail);
      }

      triedAccounts.add(account.id);
      const authManager = account.authManager;
      const modelCache = account.modelCache;

      const conversationId = generateConversationId();
      const profileArnForPayload = authManager.profileArn || PROFILE_ARN || '';

      // Build the Kiro payload
      let kiroPayload;
      try {
        kiroPayload = buildKiroPayloadOpenAI(body, conversationId, profileArnForPayload);
      } catch (err) {
        return sendOpenAIError(res, 400, err.message);
      }

      const url = `${authManager.apiHost}/generateAssistantResponse`;
      const httpClient = new KiroHttpClient(authManager);

      let response;
      try {
        response = await httpClient.requestWithRetry('POST', url, {
          json: kiroPayload,
          stream: true,
          signal: ac.signal,
        });
      } catch (err) {
        if (err instanceof ApiError) {
          // Network error - report and try the next account
          await accountManager.reportFailure(
            account.id, model, ErrorType.RECOVERABLE, err.statusCode, null
          );
          lastErrorMessage = err.message;
          lastErrorStatus = err.statusCode;
          if (allAccountIds.length === 1) break;
          logger.warning(`Network error on account ${account.id}, trying next account`);
          continue;
        }
        // Client disconnected - stop silently
        if (err.name === 'AbortError' || ac.signal.aborted) {
          return;
        }
        throw err;
      }

      if (response.statusCode === 200) {
        // SUCCESS - report and stream/collect the response
        await accountManager.reportSuccess(account.id, model);

        const messagesForTokenizer = body.messages;
        const toolsForTokenizer = body.tools || null;

        if (stream) {
          logger.info(`HTTP 200 - POST /v1/chat/completions (streaming) - started`);
          return streamOpenAIResponse(res, ac, {
            makeRequest: () =>
              httpClient.requestWithRetry('POST', url, {
                json: kiroPayload,
                stream: true,
                signal: ac.signal,
              }),
            initialResponse: response,
            model,
            modelCache,
            requestMessages: messagesForTokenizer,
            requestTools: toolsForTokenizer,
          });
        }

        // Non-streaming mode
        try {
          const openaiResponse = await collectStreamResponse(response, {
            model,
            modelCache,
            requestMessages: messagesForTokenizer,
            requestTools: toolsForTokenizer,
          });
          logger.info(`HTTP 200 - POST /v1/chat/completions (non-streaming) - completed`);
          return res.json(openaiResponse);
        } catch (err) {
          logger.error(`Error collecting non-streaming response: ${err.message}`);
          throw err;
        }
      }

      // ERROR from the Kiro API - classify and decide
      const errorText = await readBodyTextSafe(response.body);
      const { reason, userMessage } = parseKiroError(errorText);
      lastErrorMessage = userMessage;
      lastErrorStatus = response.statusCode;

      const errorType = classifyError(response.statusCode, reason);
      await accountManager.reportFailure(account.id, model, errorType, response.statusCode, reason);

      if (errorType === ErrorType.FATAL) {
        // FATAL - return to the client immediately
        logger.warning(`HTTP ${response.statusCode} - POST /v1/chat/completions - ${userMessage.slice(0, 100)}`);
        return sendOpenAIError(res, response.statusCode, userMessage);
      }

      // RECOVERABLE - try the next account
      if (allAccountIds.length === 1) break;
    }

    // All attempts exhausted
    if (allAccountIds.length === 1) {
      return sendOpenAIError(res, lastErrorStatus || 502, lastErrorMessage || 'Request failed');
    }
    const detail =
      'All accounts failed after full circle.' +
      (lastErrorMessage ? ` Error from last account: ${lastErrorMessage}` : '');
    return sendOpenAIError(res, 503, detail);
  }));

  // ==================================================================================================
  // Anthropic messages
  // ==================================================================================================

  app.post('/v1/messages', verifyAnthropicKey, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const model = body.model;
    const stream = Boolean(body.stream);

    logger.info(`Request to /v1/messages (model=${model}, stream=${stream})`);

    // Basic validation
    if (!model) {
      return sendAnthropicError(res, 400, 'The model parameter is required.', 'invalid_request_error');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return sendAnthropicError(
        res, 400, 'The messages parameter must be a non-empty array.', 'invalid_request_error'
      );
    }

    // Abort upstream requests when the client disconnects
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        ac.abort();
      }
    });

    const allAccountIds = accountManager.accountIds;
    const MAX_ATTEMPTS = allAccountIds.length * 2;
    const triedAccounts = new Set();
    let lastErrorMessage = null;
    let lastErrorStatus = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const account = await accountManager.getNextAccount(model, triedAccounts);

      if (!account) {
        if (allAccountIds.length === 1) {
          return sendAnthropicError(res, lastErrorStatus || 503, lastErrorMessage || 'Account unavailable');
        }
        const detail =
          'No available accounts for this model.' +
          (lastErrorMessage ? ` Error from last account: ${lastErrorMessage}` : '');
        return sendAnthropicError(res, 503, detail);
      }

      triedAccounts.add(account.id);
      const authManager = account.authManager;
      const modelCache = account.modelCache;

      const conversationId = generateConversationId();
      const profileArnForPayload = authManager.profileArn || PROFILE_ARN || '';

      // Build the Kiro payload
      let kiroPayload;
      try {
        kiroPayload = anthropicToKiro(body, conversationId, profileArnForPayload);
      } catch (err) {
        logger.error(`Conversion error: ${err.message}`);
        return sendAnthropicError(res, 400, err.message, 'invalid_request_error');
      }

      const url = `${authManager.apiHost}/generateAssistantResponse`;
      const httpClient = new KiroHttpClient(authManager);

      // Prepare data for token counting
      const messagesForTokenizer = body.messages;
      const toolsForTokenizer = body.tools || null;
      const systemForTokenizer = body.system || null;

      let response;
      try {
        response = await httpClient.requestWithRetry('POST', url, {
          json: kiroPayload,
          stream: true,
          signal: ac.signal,
        });
      } catch (err) {
        if (err instanceof ApiError) {
          await accountManager.reportFailure(
            account.id, model, ErrorType.RECOVERABLE, err.statusCode, null
          );
          lastErrorMessage = err.message;
          lastErrorStatus = err.statusCode;
          if (allAccountIds.length === 1) break;
          logger.warning(`Network error on account ${account.id}, trying next account`);
          continue;
        }
        if (err.name === 'AbortError' || ac.signal.aborted) {
          return;
        }
        throw err;
      }

      if (response.statusCode === 200) {
        // SUCCESS - report and stream/collect the response
        await accountManager.reportSuccess(account.id, model);

        if (stream) {
          logger.info(`HTTP 200 - POST /v1/messages (streaming) - started`);
          return streamAnthropicResponse(res, ac, {
            makeRequest: () =>
              httpClient.requestWithRetry('POST', url, {
                json: kiroPayload,
                stream: true,
                signal: ac.signal,
              }),
            initialResponse: response,
            model,
            modelCache,
            requestMessages: messagesForTokenizer,
            requestTools: toolsForTokenizer,
            requestSystem: systemForTokenizer,
          });
        }

        // Non-streaming mode
        const anthropicResponse = await collectAnthropicResponse(response, {
          model,
          modelCache,
          requestMessages: messagesForTokenizer,
          requestTools: toolsForTokenizer,
          requestSystem: systemForTokenizer,
        });
        logger.info(`HTTP 200 - POST /v1/messages (non-streaming) - completed`);
        return res.json(anthropicResponse);
      }

      // ERROR from the Kiro API - classify and decide
      const errorText = await readBodyTextSafe(response.body);
      const { reason, userMessage } = parseKiroError(errorText);
      lastErrorMessage = userMessage;
      lastErrorStatus = response.statusCode;

      const errorType = classifyError(response.statusCode, reason);
      await accountManager.reportFailure(account.id, model, errorType, response.statusCode, reason);

      if (errorType === ErrorType.FATAL) {
        logger.warning(`HTTP ${response.statusCode} - POST /v1/messages - ${userMessage.slice(0, 100)}`);
        return sendAnthropicError(res, response.statusCode, userMessage);
      }

      // RECOVERABLE - try the next account
      if (allAccountIds.length === 1) break;
    }

    // All attempts exhausted
    if (allAccountIds.length === 1) {
      return sendAnthropicError(res, lastErrorStatus || 502, lastErrorMessage || 'Request failed');
    }
    const detail =
      'All accounts failed after full circle.' +
      (lastErrorMessage ? ` Error from last account: ${lastErrorMessage}` : '');
    return sendAnthropicError(res, 503, detail);
  }));

  // ==================================================================================================
  // Anthropic count tokens
  // ==================================================================================================

  app.post('/v1/messages/count_tokens', verifyAnthropicKey, asyncHandler(async (req, res) => {
    const body = req.body || {};
    logger.info(
      `Request to /v1/messages/count_tokens (model=${body.model}, messages=${Array.isArray(body.messages) ? body.messages.length : 0})`
    );

    const requestTokenStats = estimateRequestTokens({
      messages: body.messages || [],
      tools: body.tools || null,
      systemPrompt: body.system || null,
      applyClaudeCorrection: true, // Critical for Claude models
    });

    const inputTokens = requestTokenStats.totalTokens;
    logger.info(`Token count estimate: ${inputTokens} tokens`);

    return res.json({ input_tokens: inputTokens });
  }));

  // ==================================================================================================
  // JSON parse error handler
  // ==================================================================================================

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      if (req.path === '/v1/messages') {
        return sendAnthropicError(res, 400, 'Invalid JSON in request body.', 'invalid_request_error');
      }
      return sendOpenAIError(res, 400, 'Invalid JSON in request body.');
    }
    if (err && err.type === 'entity.too.large') {
      const message = 'Request body too large. Maximum payload size is 25MB.';
      if (req.path === '/v1/messages') {
        return sendAnthropicError(res, 413, message, 'invalid_request_error');
      }
      return sendOpenAIError(res, 413, message);
    }
    logger.error(`Unhandled error: ${err && err.message}`);
    return sendOpenAIError(res, 500, 'Internal server error');
  });

  return app;
}

// ==================================================================================================
// Streaming response helpers
// ==================================================================================================

/**
 * Streams an OpenAI-formatted response to the client.
 *
 * @param {object} res - Express response
 * @param {AbortController} ac - Abort controller for client disconnects
 * @param {object} options - Streaming options for streamWithFirstTokenRetryOpenAI
 * @returns {Promise<void>}
 */
async function streamOpenAIResponse(res, ac, options) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  let streamingError = null;
  let clientDisconnected = false;

  try {
    for await (const chunk of streamWithFirstTokenRetryOpenAI(options)) {
      if (res.writableEnded || res.destroyed || ac.signal.aborted) {
        clientDisconnected = true;
        break;
      }
      res.write(chunk);
    }
  } catch (err) {
    if (ac.signal.aborted || err.name === 'AbortError') {
      clientDisconnected = true;
    } else {
      streamingError = err;
      logger.error(`HTTP 500 - POST /v1/chat/completions (streaming) - ${err.message.slice(0, 100)}`);
      // Try to send [DONE] so the client doesn't hang
      try {
        res.write('data: [DONE]\n\n');
      } catch {
        // Client already disconnected
      }
    }
  } finally {
    if (streamingError) {
      // Already logged above
    } else if (clientDisconnected) {
      logger.info('HTTP 200 - POST /v1/chat/completions (streaming) - client disconnected');
    } else {
      logger.info('HTTP 200 - POST /v1/chat/completions (streaming) - completed');
    }
    try {
      res.end();
    } catch {
      // Already closed
    }
  }
}

/**
 * Streams an Anthropic-formatted response to the client.
 *
 * @param {object} res - Express response
 * @param {AbortController} ac - Abort controller for client disconnects
 * @param {object} options - Streaming options for streamWithFirstTokenRetryAnthropic
 * @returns {Promise<void>}
 */
async function streamAnthropicResponse(res, ac, options) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  let streamingError = null;
  let clientDisconnected = false;

  try {
    for await (const chunk of streamWithFirstTokenRetryAnthropic(options)) {
      if (res.writableEnded || res.destroyed || ac.signal.aborted) {
        clientDisconnected = true;
        break;
      }
      res.write(chunk);
    }
  } catch (err) {
    if (ac.signal.aborted || err.name === 'AbortError') {
      clientDisconnected = true;
    } else {
      streamingError = err;
      logger.error(`HTTP 500 - POST /v1/messages (streaming) - ${err.message.slice(0, 100)}`);
      // Send an error event to the client, then end the stream gracefully
      try {
        const errorEvent = `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: err.message },
        })}\n\n`;
        res.write(errorEvent);
      } catch {
        // Client already disconnected
      }
    }
  } finally {
    if (streamingError) {
      // Already logged above
    } else if (clientDisconnected) {
      logger.info('HTTP 200 - POST /v1/messages (streaming) - client disconnected');
    } else {
      logger.info('HTTP 200 - POST /v1/messages (streaming) - completed');
    }
    try {
      res.end();
    } catch {
      // Already closed
    }
  }
}

module.exports = { createServer };