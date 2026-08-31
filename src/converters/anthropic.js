'use strict';

/**
 * Converters for transforming the Anthropic Messages API format to the Kiro format.
 *
 * Adapter layer that converts Anthropic-specific formats to the unified
 * format used by converters/core.js.
 * Mirrors `kiro/converters_anthropic.py`.
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
 * Extracts text content from Anthropic message content.
 *
 * @param {any} content - Anthropic message content (string or blocks)
 * @returns {string} Extracted text
 */
function convertAnthropicContentToText(content) {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const textParts = [];
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'text') {
        textParts.push(block.text || '');
      }
    }
    return textParts.join('');
  }

  return content ? String(content) : '';
}

/**
 * Extracts the system prompt text from the Anthropic system field.
 *
 * @param {any} system - System prompt (string or list of blocks)
 * @returns {string} Extracted system prompt
 */
function extractSystemPrompt(system) {
  if (system === null || system === undefined) return '';

  if (typeof system === 'string') return system;

  if (Array.isArray(system)) {
    const textParts = [];
    for (const block of system) {
      if (block && typeof block === 'object' && block.type === 'text') {
        textParts.push(block.text || '');
      }
    }
    return textParts.join('\n');
  }

  return String(system);
}

/**
 * Extracts tool results from Anthropic message content.
 *
 * @param {any} content - Anthropic message content
 * @returns {Array<object>} Tool results in unified format
 */
function extractToolResultsFromAnthropicContent(content) {
  const toolResults = [];

  if (!Array.isArray(content)) return toolResults;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'tool_result' && block.tool_use_id) {
      let resultContent = block.content;
      if (Array.isArray(resultContent)) {
        resultContent = extractTextContent(resultContent);
      } else if (typeof resultContent !== 'string') {
        resultContent = resultContent ? String(resultContent) : '';
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: resultContent || '(empty result)',
      });
    }
  }

  return toolResults;
}

/**
 * Extracts images from tool_result content blocks.
 *
 * @param {any} content - Anthropic message content
 * @returns {Array<object>} Images in unified format
 */
function extractImagesFromToolResults(content) {
  const images = [];

  if (!Array.isArray(content)) return images;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const toolResultImages = extractImagesFromContent(block.content);
      images.push(...toolResultImages);
    }
  }

  return images;
}

/**
 * Extracts tool uses from an Anthropic assistant message.
 *
 * @param {any} content - Anthropic message content
 * @returns {Array<object>} Tool calls in unified format
 */
function extractToolUsesFromAnthropicContent(content) {
  const toolCalls = [];

  if (!Array.isArray(content)) return toolCalls;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: block.input,
        },
      });
    }
  }

  return toolCalls;
}

/**
 * Converts Anthropic messages to unified format.
 *
 * @param {Array<object>} messages - Anthropic messages
 * @returns {Array<object>} Messages in unified format
 */
function convertAnthropicMessages(messages) {
  const unifiedMessages = [];

  for (const msg of messages || []) {
    const role = msg.role;
    const content = msg.content;

    const textContent = convertAnthropicContentToText(content);

    let toolCalls = null;
    let toolResults = null;
    let images = null;

    if (role === 'assistant') {
      toolCalls = extractToolUsesFromAnthropicContent(content);
      if (toolCalls.length === 0) toolCalls = null;
    } else if (role === 'user') {
      toolResults = extractToolResultsFromAnthropicContent(content);
      if (toolResults.length === 0) toolResults = null;

      images = extractImagesFromContent(content);
      const toolResultImages = extractImagesFromToolResults(content);
      if (toolResultImages.length > 0) {
        images = (images || []).concat(toolResultImages);
      }
      if (images && images.length === 0) images = null;
    }

    unifiedMessages.push(makeUnifiedMessage(role, textContent, toolCalls, toolResults, images));
  }

  return unifiedMessages;
}

/**
 * Converts Anthropic tools to unified format.
 *
 * @param {Array<object>|null} tools - Anthropic tools
 * @returns {Array<object>|null} Unified tools or null
 */
function convertAnthropicTools(tools) {
  if (!tools || tools.length === 0) return null;

  const unifiedTools = [];
  for (const tool of tools) {
    unifiedTools.push(makeUnifiedTool(tool.name, tool.description, tool.input_schema));
  }

  return unifiedTools.length > 0 ? unifiedTools : null;
}

/**
 * Extracts the thinking configuration from an Anthropic request.
 *
 * @param {object} request - Anthropic messages request
 * @returns {object} ThinkingConfig
 */
function extractThinkingConfigFromAnthropic(request) {
  if (!request.thinking || typeof request.thinking !== 'object') {
    return makeThinkingConfig(true, null);
  }

  const thinkingType = request.thinking.type;

  if (thinkingType === 'disabled') {
    return makeThinkingConfig(false, null);
  }

  if (thinkingType === 'enabled') {
    const budget = request.thinking.budget_tokens;
    return makeThinkingConfig(true, budget || null);
  }

  return makeThinkingConfig(true, null);
}

/**
 * Converts an Anthropic Messages API request to a Kiro payload.
 *
 * @param {object} request - Request in Anthropic MessagesRequest format
 * @param {string} conversationId - Unique conversation ID
 * @param {string} profileArn - AWS CodeWhisperer profile ARN
 * @returns {object} Payload for the Kiro API
 * @throws {Error} If there are no messages to send
 */
function anthropicToKiro(request, conversationId, profileArn) {
  const unifiedMessages = convertAnthropicMessages(request.messages || []);
  const unifiedTools = convertAnthropicTools(request.tools);
  const systemPrompt = extractSystemPrompt(request.system);
  const modelId = getModelIdForKiro(request.model, HIDDEN_MODELS);
  const thinkingConfig = extractThinkingConfigFromAnthropic(request);

  logger.debug(
    `Converting Anthropic request: model=${request.model} -> ${modelId}, ` +
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
  convertAnthropicContentToText,
  extractSystemPrompt,
  extractToolResultsFromAnthropicContent,
  extractImagesFromToolResults,
  extractToolUsesFromAnthropicContent,
  convertAnthropicMessages,
  convertAnthropicTools,
  extractThinkingConfigFromAnthropic,
  anthropicToKiro,
};