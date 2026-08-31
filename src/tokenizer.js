'use strict';

/**
 * Token counting utilities.
 *
 * The Python implementation uses tiktoken (cl100k_base). This Node port
 * uses a character-based approximation with the same Claude correction
 * factor, mirroring the Python fallback estimation path. This is an
 * approximate count only — the exact Claude tokenizer is not public.
 */

const CLAUDE_CORRECTION_FACTOR = 1.15;

/**
 * Counts tokens in a text string.
 *
 * @param {string} text - Text to count
 * @param {boolean} [applyClaudeCorrection=true] - Apply Claude correction factor
 * @returns {number} Approximate token count
 */
function countTokens(text, applyClaudeCorrection = true) {
  if (!text) return 0;
  const baseEstimate = Math.floor(text.length / 4) + 1;
  if (applyClaudeCorrection) {
    return Math.floor(baseEstimate * CLAUDE_CORRECTION_FACTOR);
  }
  return baseEstimate;
}

/**
 * Counts tokens in a content block (string or list of blocks).
 *
 * @param {any} content - Message content (string or content blocks)
 * @param {boolean} applyClaudeCorrection - Apply Claude correction factor
 * @returns {number} Approximate token count
 */
function countContentTokens(content, applyClaudeCorrection) {
  if (typeof content === 'string') {
    return countTokens(content, applyClaudeCorrection);
  }
  if (Array.isArray(content)) {
    let total = 0;
    for (const item of content) {
      if (!item || typeof item !== 'object') {
        total += countTokens(String(item), applyClaudeCorrection);
        continue;
      }
      const itemType = item.type;
      if (itemType === 'text') {
        total += countTokens(item.text || '', applyClaudeCorrection);
      } else if (itemType === 'image_url' || itemType === 'image') {
        total += 100; // Fixed cost for images
      } else if (itemType === 'tool_use') {
        total += countTokens(item.id || '', applyClaudeCorrection);
        total += countTokens(item.name || '', applyClaudeCorrection);
        total += countTokens(JSON.stringify(item.input || {}), applyClaudeCorrection);
      } else if (itemType === 'tool_result') {
        total += countTokens(item.tool_use_id || '', applyClaudeCorrection);
        const resultContent = item.content;
        if (typeof resultContent === 'string') {
          total += countTokens(resultContent, applyClaudeCorrection);
        } else if (Array.isArray(resultContent)) {
          for (const block of resultContent) {
            if (block && block.type === 'text') {
              total += countTokens(block.text || '', applyClaudeCorrection);
            } else if (block && (block.type === 'image_url' || block.type === 'image')) {
              total += 100;
            } else {
              total += countTokens(JSON.stringify(block), applyClaudeCorrection);
            }
          }
        } else if (resultContent != null) {
          total += countTokens(String(resultContent), applyClaudeCorrection);
        }
      } else {
        total += countTokens(JSON.stringify(item), applyClaudeCorrection);
      }
    }
    return total;
  }
  return 0;
}

/**
 * Counts tokens in a list of chat messages.
 *
 * @param {Array<object>} messages - Messages in OpenAI/Anthropic format
 * @param {boolean} [applyClaudeCorrection=true] - Apply Claude correction factor
 * @returns {number} Approximate token count
 */
function countMessageTokens(messages, applyClaudeCorrection = true) {
  if (!messages || messages.length === 0) return 0;

  let total = 0;

  for (const message of messages) {
    total += 4; // ~4 tokens of service information per message

    const role = (message && message.role) || '';
    total += countTokens(role, false);

    if (message && message.content) {
      total += countContentTokens(message.content, false);
    }

    if (message && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        total += 4;
        const func = (tc && tc.function) || {};
        total += countTokens(func.name || '', false);
        total += countTokens(func.arguments || '', false);
      }
    }

    if (message && message.tool_call_id) {
      total += countTokens(message.tool_call_id, false);
    }
  }

  total += 3; // Final service tokens

  if (applyClaudeCorrection) {
    return Math.floor(total * CLAUDE_CORRECTION_FACTOR);
  }
  return total;
}

/**
 * Counts tokens in tool definitions.
 *
 * @param {Array<object>|null} tools - Tools in OpenAI or Anthropic format
 * @param {boolean} [applyClaudeCorrection=true] - Apply Claude correction factor
 * @returns {number} Approximate token count
 */
function countToolsTokens(tools, applyClaudeCorrection = true) {
  if (!tools || tools.length === 0) return 0;

  let total = 0;

  for (const tool of tools) {
    total += 4; // Service tokens

    let payload = tool;
    if (tool && tool.type === 'function' && typeof tool.function === 'object' && tool.function !== null) {
      payload = tool.function;
    }

    total += countTokens((payload && payload.name) || '', false);
    total += countTokens((payload && payload.description) || '', false);

    let params = payload && payload.input_schema;
    if (params === undefined || params === null) {
      params = payload && payload.parameters;
    }
    if (params != null) {
      total += countTokens(JSON.stringify(params), false);
    }
  }

  if (applyClaudeCorrection) {
    return Math.floor(total * CLAUDE_CORRECTION_FACTOR);
  }
  return total;
}

/**
 * Counts tokens in a system prompt (string or Anthropic block list).
 *
 * @param {any} systemPrompt - System prompt (string or list of blocks)
 * @param {boolean} [applyClaudeCorrection=true] - Apply Claude correction factor
 * @returns {number} Approximate token count
 */
function countSystemTokens(systemPrompt, applyClaudeCorrection = true) {
  if (!systemPrompt) return 0;

  let total = 0;

  if (typeof systemPrompt === 'string') {
    total += countTokens(systemPrompt, false);
  } else if (Array.isArray(systemPrompt)) {
    for (const block of systemPrompt) {
      if (block && typeof block === 'object') {
        total += countTokens(block.text || '', false);
        if (block.cache_control != null) {
          total += countTokens(JSON.stringify(block.cache_control), false);
        }
      } else {
        total += countTokens(String(block), false);
      }
    }
  } else {
    total += countTokens(String(systemPrompt), false);
  }

  if (applyClaudeCorrection) {
    return Math.floor(total * CLAUDE_CORRECTION_FACTOR);
  }
  return total;
}

/**
 * Estimates total tokens in a request.
 *
 * @param {object} options - Estimation options
 * @param {Array<object>} options.messages - List of messages
 * @param {Array<object>|null} [options.tools] - List of tools
 * @param {any} [options.systemPrompt] - System prompt
 * @param {boolean} [options.applyClaudeCorrection=true] - Apply Claude correction factor
 * @returns {{messagesTokens: number, toolsTokens: number, systemTokens: number, totalTokens: number}}
 */
function estimateRequestTokens({ messages, tools = null, systemPrompt = null, applyClaudeCorrection = true }) {
  const messagesTokens = countMessageTokens(messages || [], applyClaudeCorrection);
  const toolsTokens = countToolsTokens(tools, applyClaudeCorrection);
  const systemTokens = countSystemTokens(systemPrompt, applyClaudeCorrection);

  return {
    messagesTokens,
    toolsTokens,
    systemTokens,
    totalTokens: messagesTokens + toolsTokens + systemTokens,
  };
}

module.exports = {
  CLAUDE_CORRECTION_FACTOR,
  countTokens,
  countMessageTokens,
  countToolsTokens,
  countSystemTokens,
  estimateRequestTokens,
};