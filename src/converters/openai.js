'use strict';

/**
 * Converters for transforming the OpenAI format to the Kiro format.
 *
 * Adapter layer that converts OpenAI-specific formats to the unified
 * format used by converters/core.js.
 * Mirrors `kiro/converters_openai.py`.
 */

const { Logger } = require('../logger');
const { HIDDEN_MODELS } = require('../config');
const { getModelIdForKiro } = require('../modelResolver');
const {
  makeUnifiedMessage,
  makeUnifiedTool,
  makeThinkingConfig,
  extractTextContent,
  extractImagesFromContent,
  buildKiroPayload,
} = require('./core');

const logger = new Logger();

/**
 * Extracts tool results from OpenAI message content.
 *
 * @param {any} content - Message content
 * @returns {Array<object>} Tool results in unified format
 */
function extractToolResultsFromOpenAI(content) {
  const toolResults = [];

  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === 'object' && item.type === 'tool_result') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: item.tool_use_id || '',
          content: extractTextContent(item.content) || '(empty result)',
        });
      }
    }
  }

  return toolResults;
}

/**
 * Extracts tool calls from an OpenAI assistant message.
 *
 * @param {object} msg - OpenAI message
 * @returns {Array<object>} Tool calls in unified format
 */
function extractToolCallsFromOpenAI(msg) {
  const toolCalls = [];

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (!tc || typeof tc !== 'object') continue;
      const func = tc.function || {};
      toolCalls.push({
        id: tc.id || '',
        type: 'function',
        function: {
          name: func.name || '',
          arguments: func.arguments || '{}',
        },
      });
    }
  }

  return toolCalls;
}

/**
 * Converts OpenAI messages to unified format.
 *
 * @param {Array<object>} messages - OpenAI messages
 * @returns {[string, Array<object>]} [systemPrompt, unifiedMessages]
 */
function convertOpenAIMessagesToUnified(messages) {
  // Extract system prompt
  let systemPrompt = '';
  const nonSystemMessages = [];

  for (const msg of messages || []) {
    if (msg.role === 'system') {
      systemPrompt += extractTextContent(msg.content) + '\n';
    } else {
      nonSystemMessages.push(msg);
    }
  }
  systemPrompt = systemPrompt.trim();

  // Process tool messages - convert to user messages with tool_results
  const processed = [];
  let pendingToolResults = [];
  let pendingToolImages = [];

  for (const msg of nonSystemMessages) {
    if (msg.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: msg.tool_call_id || '',
        content: extractTextContent(msg.content) || '(empty result)',
      });

      // Extract images from tool message content (e.g., MCP screenshots)
      const toolImages = extractImagesFromContent(msg.content);
      if (toolImages.length > 0) {
        pendingToolImages = pendingToolImages.concat(toolImages);
      }
    } else {
      // Flush accumulated tool results into a user message
      if (pendingToolResults.length > 0) {
        processed.push(
          makeUnifiedMessage(
            'user',
            '',
            null,
            pendingToolResults.slice(),
            pendingToolImages.length > 0 ? pendingToolImages.slice() : null
          )
        );
        pendingToolResults = [];
        pendingToolImages = [];
      }

      let toolCalls = null;
      let toolResults = null;
      let images = null;

      if (msg.role === 'assistant') {
        toolCalls = extractToolCallsFromOpenAI(msg);
        if (toolCalls.length === 0) toolCalls = null;
      } else if (msg.role === 'user') {
        toolResults = extractToolResultsFromOpenAI(msg.content);
        if (toolResults.length === 0) toolResults = null;
        images = extractImagesFromContent(msg.content);
        if (images.length === 0) images = null;
      }

      processed.push(
        makeUnifiedMessage(msg.role, extractTextContent(msg.content), toolCalls, toolResults, images)
      );
    }
  }

  // Flush remaining tool results at the end
  if (pendingToolResults.length > 0) {
    processed.push(
      makeUnifiedMessage(
        'user',
        '',
        null,
        pendingToolResults.slice(),
        pendingToolImages.length > 0 ? pendingToolImages.slice() : null
      )
    );
  }

  return [systemPrompt, processed];
}

/**
 * Converts OpenAI tools to unified format.
 *
 * Supports standard OpenAI format and flat (Cursor-style) format.
 *
 * @param {Array<object>|null} tools - OpenAI tools
 * @returns {Array<object>|null} Unified tools or null
 */
function convertOpenAIToolsToUnified(tools) {
  if (!tools || tools.length === 0) return null;

  const unifiedTools = [];
  for (const tool of tools) {
    if (tool.type !== 'function') continue;

    // Standard OpenAI format (function field) takes priority
    if (tool.function) {
      unifiedTools.push(
        makeUnifiedTool(tool.function.name, tool.function.description, tool.function.parameters)
      );
    }
    // Flat format compatibility (Cursor-style)
    else if (tool.name) {
      unifiedTools.push(makeUnifiedTool(tool.name, tool.description, tool.input_schema));
    } else {
      logger.warning('Skipping invalid tool: no function or name field found');
    }
  }

  return unifiedTools.length > 0 ? unifiedTools : null;
}

/**
 * Converts reasoning_effort to a thinking budget (percentage-based).
 *
 * @param {number} maxTokens - Maximum output tokens
 * @param {string} effort - Reasoning effort level
 * @returns {number} Thinking budget in tokens
 */
function reasoningEffortToBudget(maxTokens, effort) {
  const percent = {
    none: 0.0,
    minimal: 0.1,
    low: 0.2,
    medium: 0.5,
    high: 0.8,
    xhigh: 0.95,
  };
  const p = percent[effort] !== undefined ? percent[effort] : 0.5;
  return Math.floor(maxTokens * p);
}

/**
 * Extracts the thinking configuration from an OpenAI request.
 *
 * @param {object} request - OpenAI chat completion request
 * @returns {object} ThinkingConfig
 */
function extractThinkingConfigFromOpenAI(request) {
  if (!request.reasoning_effort) {
    return makeThinkingConfig(true, null);
  }

  if (request.reasoning_effort === 'none') {
    return makeThinkingConfig(false, null);
  }

  let maxTokens = request.max_tokens || request.max_completion_tokens;
  if (!maxTokens) {
    maxTokens = 4096;
  }

  const budget = reasoningEffortToBudget(maxTokens, request.reasoning_effort);

  logger.debug(
    `Extracted thinking config from OpenAI: reasoning_effort='${request.reasoning_effort}', ` +
      `max_tokens=${maxTokens}, budget=${budget}`
  );

  return makeThinkingConfig(true, budget);
}

/**
 * Builds the complete Kiro payload from an OpenAI request.
 *
 * @param {object} requestData - Request in OpenAI format
 * @param {string} conversationId - Unique conversation ID
 * @param {string} profileArn - AWS CodeWhisperer profile ARN
 * @returns {object} Payload for the Kiro API
 * @throws {Error} If there are no messages to send
 */
function buildKiroPayloadOpenAI(requestData, conversationId, profileArn) {
  const [systemPrompt, unifiedMessages] = convertOpenAIMessagesToUnified(requestData.messages || []);
  const unifiedTools = convertOpenAIToolsToUnified(requestData.tools);
  const modelId = getModelIdForKiro(requestData.model, HIDDEN_MODELS);
  const thinkingConfig = extractThinkingConfigFromOpenAI(requestData);

  logger.debug(
    `Converting OpenAI request: model=${requestData.model} -> ${modelId}, ` +
      `messages=${unifiedMessages.length}, tools=${unifiedTools ? unifiedTools.length : 0}, ` +
      `system_prompt_length=${systemPrompt.length}, ` +
      `thinking_enabled=${thinkingConfig.enabled}, thinking_budget=${thinkingConfig.budgetTokens}`
  );

  const result = buildKiroPayload({
    messages: unifiedMessages,
    systemPrompt,
    modelId,
    tools: unifiedTools,
    conversationId,
    profileArn,
    thinkingConfig,
  });

  return result.payload;
}

module.exports = {
  extractToolResultsFromOpenAI,
  extractToolCallsFromOpenAI,
  convertOpenAIMessagesToUnified,
  convertOpenAIToolsToUnified,
  reasoningEffortToBudget,
  extractThinkingConfigFromOpenAI,
  buildKiroPayloadOpenAI,
};