'use strict';

/**
 * Core converters: transforming API formats to the Kiro format.
 *
 * Shared logic used by both the OpenAI and Anthropic converters:
 * - Text content extraction from various formats
 * - Message merging and processing
 * - Kiro payload building
 * - Tool processing and sanitization
 *
 * Mirrors `kiro/converters_core.py`.
 */

const { Logger } = require('../logger');
const {
  TOOL_DESCRIPTION_MAX_LENGTH,
  FAKE_REASONING_ENABLED,
  FAKE_REASONING_MAX_TOKENS,
  FAKE_REASONING_BUDGET_CAP,
} = require('../config');

const logger = new Logger();

// ==================================================================================================
// Unified Message Format
// ==================================================================================================

/**
 * Creates a unified message object.
 *
 * @param {string} role - Message role (user, assistant)
 * @param {any} [content=''] - Text content or content blocks
 * @param {Array<object>|null} [toolCalls=null] - Tool calls (assistant)
 * @param {Array<object>|null} [toolResults=null] - Tool results (user)
 * @param {Array<object>|null} [images=null] - Images in unified format
 * @returns {object} Unified message
 */
function makeUnifiedMessage(role, content = '', toolCalls = null, toolResults = null, images = null) {
  return { role, content, toolCalls, toolResults, images };
}

/**
 * Creates a thinking configuration object.
 *
 * @param {boolean} [enabled=true] - Whether thinking tags are injected
 * @param {number|null} [budgetTokens=null] - Token budget (null = default)
 * @returns {object} Thinking config
 */
function makeThinkingConfig(enabled = true, budgetTokens = null) {
  return { enabled, budgetTokens };
}

/**
 * Creates a unified tool object.
 *
 * @param {string} name - Tool name
 * @param {string|null} [description=null] - Tool description
 * @param {object|null} [inputSchema=null] - JSON Schema for parameters
 * @returns {object} Unified tool
 */
function makeUnifiedTool(name, description = null, inputSchema = null) {
  return { name, description, inputSchema };
}

// ==================================================================================================
// Text Content Extraction
// ==================================================================================================

/**
 * Extracts text content from various formats.
 *
 * @param {any} content - Content (string, list of blocks, or null)
 * @returns {string} Extracted text
 */
function extractTextContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const textParts = [];
    for (const item of content) {
      if (item === null || item === undefined) continue;
      if (typeof item === 'object') {
        // Skip image and tool_reference blocks - handled separately
        if (item.type === 'image' || item.type === 'image_url' || item.type === 'tool_reference') continue;
        if (item.type === 'text') {
          textParts.push(item.text || '');
        } else if ('text' in item) {
          textParts.push(item.text);
        }
      } else if (typeof item === 'string') {
        textParts.push(item);
      }
    }
    return textParts.join('');
  }

  return String(content);
}

/**
 * Extracts images from message content in unified format.
 *
 * Supports OpenAI (image_url with data URL) and Anthropic (image with
 * base64 source) formats.
 *
 * @param {any} content - Message content
 * @returns {Array<{mediaType: string, data: string}>} Images in unified format
 */
function extractImagesFromContent(content) {
  const images = [];
  if (!Array.isArray(content)) return images;

  for (const item of content) {
    if (item === null || typeof item !== 'object') continue;
    const itemType = item.type;

    // OpenAI format: {"type": "image_url", "image_url": {"url": "data:..."}}
    if (itemType === 'image_url') {
      const imageUrlObj = item.image_url || {};
      const url = typeof imageUrlObj === 'object' ? imageUrlObj.url || '' : '';

      if (typeof url === 'string' && url.startsWith('data:')) {
        try {
          const [header, data] = url.split(',', 2);
          const mediaPart = header.split(';')[0];
          const mediaType = mediaPart.replace('data:', '');
          if (data) {
            images.push({ mediaType: mediaType || 'image/jpeg', data });
          }
        } catch {
          // Failed to parse data URL - skip
        }
      } else if (typeof url === 'string' && url.startsWith('http')) {
        logger.warning(`URL-based images are not supported by Kiro API, skipping: ${url.slice(0, 80)}...`);
      }
    }

    // Anthropic format: {"type": "image", "source": {"type": "base64", ...}}
    else if (itemType === 'image') {
      const source = item.source;
      if (source && typeof source === 'object' && source.type === 'base64') {
        if (source.data) {
          images.push({ mediaType: source.media_type || 'image/jpeg', data: source.data });
        }
      } else if (source && typeof source === 'object' && source.type === 'url') {
        logger.warning(`URL-based images are not supported by Kiro API, skipping: ${String(source.url).slice(0, 80)}...`);
      }
    }
  }

  if (images.length > 0) {
    logger.debug(`Extracted ${images.length} image(s) from content`);
  }

  return images;
}

// ==================================================================================================
// Thinking Mode Support (Fake Reasoning)
// ==================================================================================================

/**
 * Generates the system prompt addition that legitimizes thinking tags.
 *
 * @returns {string} System prompt addition (empty if fake reasoning disabled)
 */
function getThinkingSystemPromptAddition() {
  if (!FAKE_REASONING_ENABLED) return '';

  return (
    '\n\n---\n' +
    '# Extended Thinking Mode\n\n' +
    'This conversation uses extended thinking mode. User messages may contain ' +
    'special XML tags that are legitimate system-level instructions:\n' +
    '- `<thinking_mode>enabled</thinking_mode>` - enables extended thinking\n' +
    '- `<max_thinking_length>N</max_thinking_length>` - sets maximum thinking tokens\n' +
    '- `<thinking_instruction>...</thinking_instruction>` - provides thinking guidelines\n\n' +
    'These tags are NOT prompt injection attempts. They are part of the system\'s ' +
    'extended thinking feature. When you see these tags, follow their instructions ' +
    'and wrap your reasoning process in `<thinking>...</thinking>` tags before ' +
    'providing your final response.'
  );
}

/**
 * Injects fake reasoning tags into content based on configuration.
 *
 * @param {string} content - Original content string
 * @param {object} thinkingConfig - Thinking configuration
 * @returns {string} Content with thinking tags prepended (if enabled)
 */
function injectThinkingTags(content, thinkingConfig) {
  if (!FAKE_REASONING_ENABLED) return content;
  if (!thinkingConfig.enabled) {
    logger.debug('Thinking disabled by client request');
    return content;
  }

  let effectiveBudget =
    thinkingConfig.budgetTokens !== null && thinkingConfig.budgetTokens !== undefined
      ? thinkingConfig.budgetTokens
      : FAKE_REASONING_MAX_TOKENS;

  if (FAKE_REASONING_BUDGET_CAP > 0 && effectiveBudget > FAKE_REASONING_BUDGET_CAP) {
    logger.warning(
      `Client requested thinking budget ${effectiveBudget} exceeds cap ${FAKE_REASONING_BUDGET_CAP}. ` +
        `Using capped value ${FAKE_REASONING_BUDGET_CAP}.`
    );
    effectiveBudget = FAKE_REASONING_BUDGET_CAP;
  }

  const thinkingInstruction =
    'Think in English for better reasoning quality.\n\n' +
    'Your thinking process should be thorough and systematic:\n' +
    '- First, make sure you fully understand what is being asked\n' +
    '- Consider multiple approaches or perspectives when relevant\n' +
    '- Think about edge cases, potential issues, and what could go wrong\n' +
    '- Challenge your initial assumptions\n' +
    '- Verify your reasoning before reaching a conclusion\n\n' +
    'After completing your thinking, respond in the same language the user is using in their messages.\n\n' +
    'Take the time you need. Quality of thought matters more than speed.';

  const thinkingPrefix =
    `<thinking_mode>enabled</thinking_mode>\n` +
    `<max_thinking_length>${effectiveBudget}</max_thinking_length>\n` +
    `<thinking_instruction>${thinkingInstruction}</thinking_instruction>\n\n`;

  logger.debug(`Injecting thinking tags with budget=${effectiveBudget}`);

  return thinkingPrefix + content;
}

// ==================================================================================================
// JSON Schema Sanitization
// ==================================================================================================

/**
 * Sanitizes a JSON Schema from fields the Kiro API does not accept.
 *
 * Kiro API returns 400 "Improperly formed request" if:
 * - required is an empty array []
 * - additionalProperties is present in the schema
 *
 * @param {object|null} schema - JSON Schema to sanitize
 * @returns {object} Sanitized copy of the schema
 */
function sanitizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return {};

  const result = {};

  for (const [key, value] of Object.entries(schema)) {
    // Skip empty required arrays
    if (key === 'required' && Array.isArray(value) && value.length === 0) continue;

    // Skip additionalProperties - Kiro API doesn't support it
    if (key === 'additionalProperties') continue;

    // Recursively process nested objects
    if (key === 'properties' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = {};
      for (const [propName, propValue] of Object.entries(value)) {
        result[key][propName] =
          typeof propValue === 'object' && propValue !== null ? sanitizeJsonSchema(propValue) : propValue;
      }
    } else if (Array.isArray(value)) {
      // Process lists (e.g., anyOf, oneOf)
      result[key] = value.map((item) =>
        typeof item === 'object' && item !== null ? sanitizeJsonSchema(item) : item
      );
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeJsonSchema(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ==================================================================================================
// Tool Processing
// ==================================================================================================

/**
 * Processes tools with long descriptions (moves them to the system prompt).
 *
 * @param {Array<object>|null} tools - Tools in unified format
 * @returns {[Array<object>|null, string]} [processed tools, system prompt documentation]
 */
function processToolsWithLongDescriptions(tools) {
  if (!tools || tools.length === 0) return [null, ''];

  if (TOOL_DESCRIPTION_MAX_LENGTH <= 0) return [tools, ''];

  const toolDocumentationParts = [];
  const processedTools = [];

  for (const tool of tools) {
    const description = tool.description || '';

    if (description.length <= TOOL_DESCRIPTION_MAX_LENGTH) {
      processedTools.push(tool);
    } else {
      logger.debug(
        `Tool '${tool.name}' has long description (${description.length} chars > ` +
          `${TOOL_DESCRIPTION_MAX_LENGTH}), moving to system prompt`
      );

      toolDocumentationParts.push(`## Tool: ${tool.name}\n\n${description}`);

      processedTools.push(
        makeUnifiedTool(
          tool.name,
          `[Full documentation in system prompt under '## Tool: ${tool.name}']`,
          tool.inputSchema
        )
      );
    }
  }

  let toolDocumentation = '';
  if (toolDocumentationParts.length > 0) {
    toolDocumentation =
      '\n\n---\n' +
      '# Tool Documentation\n' +
      "The following tools have detailed documentation that couldn't fit in the tool definition.\n\n" +
      toolDocumentationParts.join('\n\n---\n\n');
  }

  return [processedTools.length > 0 ? processedTools : null, toolDocumentation];
}

/**
 * Validates tool names against the Kiro API 64-character limit.
 *
 * @param {Array<object>|null} tools - Tools to validate
 * @throws {Error} If any tool name exceeds 64 characters
 */
function validateToolNames(tools) {
  if (!tools || tools.length === 0) return;

  const problematicTools = [];
  for (const tool of tools) {
    if (tool.name.length > 64) {
      problematicTools.push([tool.name, tool.name.length]);
    }
  }

  if (problematicTools.length > 0) {
    const toolList = problematicTools
      .map(([name, length]) => `  - '${name}' (${length} characters)`)
      .join('\n');
    throw new Error(
      `Tool name(s) exceed Kiro API limit of 64 characters:\n${toolList}\n\n` +
        'Solution: Use shorter tool names (max 64 characters).'
    );
  }
}

/**
 * Converts unified tools to Kiro toolSpecification format.
 *
 * @param {Array<object>|null} tools - Tools in unified format
 * @returns {Array<object>} Tools in Kiro format
 */
function convertToolsToKiroFormat(tools) {
  if (!tools || tools.length === 0) return [];

  const kiroTools = [];
  for (const tool of tools) {
    const sanitizedParams = sanitizeJsonSchema(tool.inputSchema);

    // Kiro API requires non-empty description
    let description = tool.description;
    if (!description || !description.trim()) {
      description = `Tool: ${tool.name}`;
    }

    kiroTools.push({
      toolSpecification: {
        name: tool.name,
        description,
        inputSchema: { json: sanitizedParams },
      },
    });
  }

  return kiroTools;
}

/**
 * Converts unified images to Kiro format.
 *
 * @param {Array<object>|null} images - Images in unified format
 * @returns {Array<object>} Images in Kiro format
 */
function convertImagesToKiroFormat(images) {
  if (!images || images.length === 0) return [];

  const kiroImages = [];
  for (const img of images) {
    let mediaType = img.mediaType || 'image/jpeg';
    let data = img.data || '';

    if (!data) {
      logger.warning('Skipping image with empty data');
      continue;
    }

    // Strip data URL prefix if present
    if (typeof data === 'string' && data.startsWith('data:')) {
      try {
        const [header, actualData] = data.split(',', 2);
        const mediaPart = header.split(';')[0];
        const extractedMediaType = mediaPart.replace('data:', '');
        if (extractedMediaType) {
          mediaType = extractedMediaType;
        }
        data = actualData;
      } catch {
        // Keep original data
      }
    }

    const formatStr = mediaType.includes('/') ? mediaType.split('/').pop() : mediaType;

    kiroImages.push({
      format: formatStr,
      source: { bytes: data },
    });
  }

  return kiroImages;
}

// ==================================================================================================
// Tool Results and Tool Uses Extraction
// ==================================================================================================

/**
 * Converts unified tool results to Kiro format.
 *
 * @param {Array<object>} toolResults - Tool results in unified format
 * @returns {Array<object>} Tool results in Kiro format
 */
function convertToolResultsToKiroFormat(toolResults) {
  const kiroResults = [];
  for (const tr of toolResults) {
    const content = tr.content || '';
    const contentText = typeof content === 'string' ? content : extractTextContent(content);

    kiroResults.push({
      content: [{ text: contentText || '(empty result)' }],
      status: 'success',
      toolUseId: tr.tool_use_id || '',
    });
  }

  return kiroResults;
}

/**
 * Extracts tool results from message content (already in Kiro format).
 *
 * @param {any} content - Message content
 * @returns {Array<object>} Tool results in Kiro format
 */
function extractToolResultsFromContent(content) {
  const toolResults = [];

  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === 'object' && item.type === 'tool_result') {
        toolResults.push({
          content: [{ text: extractTextContent(item.content) || '(empty result)' }],
          status: 'success',
          toolUseId: item.tool_use_id || '',
        });
      }
    }
  }

  return toolResults;
}

/**
 * Extracts tool uses from an assistant message.
 *
 * @param {any} content - Message content
 * @param {Array<object>|null} toolCalls - Tool calls (OpenAI format)
 * @returns {Array<object>} Tool uses in Kiro format
 */
function extractToolUsesFromMessage(content, toolCalls = null) {
  const toolUses = [];

  // From tool_calls field (OpenAI format)
  if (toolCalls) {
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue;
      const func = tc.function || {};
      let argumentsData = func.arguments || '{}';
      let inputData;
      if (typeof argumentsData === 'string') {
        try {
          inputData = JSON.parse(argumentsData);
        } catch {
          inputData = {};
        }
      } else {
        inputData = argumentsData || {};
      }
      toolUses.push({
        name: func.name || '',
        input: inputData,
        toolUseId: tc.id || '',
      });
    }
  }

  // From content blocks (Anthropic format)
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === 'object' && item.type === 'tool_use') {
        toolUses.push({
          name: item.name || '',
          input: item.input || {},
          toolUseId: item.id || '',
        });
      }
    }
  }

  return toolUses;
}

// ==================================================================================================
// Tool Content to Text Conversion (when no tools defined)
// ==================================================================================================

/**
 * Converts tool_calls to human-readable text.
 *
 * @param {Array<object>} toolCalls - Tool calls in unified format
 * @returns {string} Text representation
 */
function toolCallsToText(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return '';

  const parts = [];
  for (const tc of toolCalls) {
    const func = tc.function || {};
    const name = func.name || 'unknown';
    const argumentsStr = func.arguments || '{}';
    const toolId = tc.id || '';

    if (toolId) {
      parts.push(`[Tool: ${name} (${toolId})]\n${argumentsStr}`);
    } else {
      parts.push(`[Tool: ${name}]\n${argumentsStr}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Converts tool_results to human-readable text.
 *
 * @param {Array<object>} toolResults - Tool results in unified format
 * @returns {string} Text representation
 */
function toolResultsToText(toolResults) {
  if (!toolResults || toolResults.length === 0) return '';

  const parts = [];
  for (const tr of toolResults) {
    const content = tr.content || '';
    const contentText = typeof content === 'string' ? content : extractTextContent(content);
    const toolUseId = tr.tool_use_id || '';

    if (toolUseId) {
      parts.push(`[Tool Result (${toolUseId})]\n${contentText || '(empty result)'}`);
    } else {
      parts.push(`[Tool Result]\n${contentText || '(empty result)'}`);
    }
  }

  return parts.join('\n\n');
}

// ==================================================================================================
// Message Merging
// ==================================================================================================

/**
 * Strips ALL tool-related content, converting it to text representation.
 *
 * Used when no tools are defined (Kiro API rejects toolResults without tools).
 *
 * @param {Array<object>} messages - Messages in unified format
 * @returns {[Array<object>, boolean]} [messages, hadToolContent]
 */
function stripAllToolContent(messages) {
  if (!messages || messages.length === 0) return [[], false];

  const result = [];
  let totalToolCallsStripped = 0;
  let totalToolResultsStripped = 0;

  for (const msg of messages) {
    const hasToolCalls = Boolean(msg.toolCalls);
    const hasToolResults = Boolean(msg.toolResults);

    if (hasToolCalls || hasToolResults) {
      if (hasToolCalls) totalToolCallsStripped += msg.toolCalls.length;
      if (hasToolResults) totalToolResultsStripped += msg.toolResults.length;

      const existingContent = extractTextContent(msg.content);
      const contentParts = [];

      if (existingContent) contentParts.push(existingContent);

      if (hasToolCalls) {
        const toolText = toolCallsToText(msg.toolCalls);
        if (toolText) contentParts.push(toolText);
      }

      if (hasToolResults) {
        const resultText = toolResultsToText(msg.toolResults);
        if (resultText) contentParts.push(resultText);
      }

      const content = contentParts.length > 0 ? contentParts.join('\n\n') : '(empty placeholder)';

      // Preserve images (e.g., screenshots from MCP tools)
      result.push(makeUnifiedMessage(msg.role, content, null, null, msg.images));
    } else {
      result.push(msg);
    }
  }

  const hadToolContent = totalToolCallsStripped > 0 || totalToolResultsStripped > 0;

  if (hadToolContent) {
    logger.debug(
      `Converted tool content to text (no tools defined): ` +
        `${totalToolCallsStripped} tool_calls, ${totalToolResultsStripped} tool_results`
    );
  }

  return [result, hadToolContent];
}

/**
 * Ensures tool_results have a preceding assistant message with tool_calls.
 *
 * When the assistant message is missing, converts the tool_results to
 * text representation (we cannot synthesize the original tool call).
 *
 * @param {Array<object>} messages - Messages in unified format
 * @returns {[Array<object>, boolean]} [messages, convertedAnyToolResults]
 */
function ensureAssistantBeforeToolResults(messages) {
  if (!messages || messages.length === 0) return [[], false];

  const result = [];
  let convertedAnyToolResults = false;

  for (const msg of messages) {
    if (msg.toolResults) {
      const last = result.length > 0 ? result[result.length - 1] : null;
      const hasPrecedingAssistant = last && last.role === 'assistant' && last.toolCalls;

      if (!hasPrecedingAssistant) {
        logger.debug(
          `Converting ${msg.toolResults.length} orphaned tool_results to text ` +
            `(no preceding assistant message with tool_calls)`
        );

        const toolResultsText = toolResultsToText(msg.toolResults);
        const originalContent = extractTextContent(msg.content) || '';

        let newContent;
        if (originalContent && toolResultsText) {
          newContent = `${originalContent}\n\n${toolResultsText}`;
        } else if (toolResultsText) {
          newContent = toolResultsText;
        } else {
          newContent = originalContent;
        }

        result.push(makeUnifiedMessage(msg.role, newContent, msg.toolCalls, null, msg.images));
        convertedAnyToolResults = true;
        continue;
      }
    }

    result.push(msg);
  }

  return [result, convertedAnyToolResults];
}

/**
 * Merges adjacent messages with the same role.
 *
 * Kiro API does not accept multiple consecutive messages from the same role.
 *
 * @param {Array<object>} messages - Messages in unified format
 * @returns {Array<object>} Messages with adjacent ones merged
 */
function mergeAdjacentMessages(messages) {
  if (!messages || messages.length === 0) return [];

  const merged = [];

  for (const msg of messages) {
    if (merged.length === 0) {
      merged.push({ ...msg });
      continue;
    }

    const last = merged[merged.length - 1];
    if (msg.role === last.role) {
      // Merge content
      if (Array.isArray(last.content) && Array.isArray(msg.content)) {
        last.content = last.content.concat(msg.content);
      } else if (Array.isArray(last.content)) {
        last.content = last.content.concat([{ type: 'text', text: extractTextContent(msg.content) }]);
      } else if (Array.isArray(msg.content)) {
        last.content = [{ type: 'text', text: extractTextContent(last.content) }].concat(msg.content);
      } else {
        const lastText = extractTextContent(last.content);
        const currentText = extractTextContent(msg.content);
        last.content = `${lastText}\n${currentText}`;
      }

      // Merge tool_calls for assistant messages
      if (msg.role === 'assistant' && msg.toolCalls) {
        if (last.toolCalls === null) last.toolCalls = [];
        last.toolCalls = last.toolCalls.concat(msg.toolCalls);
      }

      // Merge tool_results for user messages
      if (msg.role === 'user' && msg.toolResults) {
        if (last.toolResults === null) last.toolResults = [];
        last.toolResults = last.toolResults.concat(msg.toolResults);
      }

      // Merge images
      if (msg.images) {
        last.images = (last.images || []).concat(msg.images);
      }
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}

/**
 * Ensures the first message is from the user role.
 *
 * @param {Array<object>} messages - Messages in unified format
 * @returns {Array<object>} Messages with guaranteed user-first order
 */
function ensureFirstMessageIsUser(messages) {
  if (!messages || messages.length === 0) return messages;

  if (messages[0].role !== 'user') {
    logger.debug(
      `First message is '${messages[0].role}', prepending synthetic user message ` +
        '(Kiro API requires conversations to start with user)'
    );
    return [makeUnifiedMessage('user', '(empty placeholder)')].concat(messages);
  }

  return messages;
}

/**
 * Normalizes unknown message roles to 'user'.
 *
 * @param {Array<object>} messages - Messages in unified format
 * @returns {Array<object>} Messages with normalized roles
 */
function normalizeMessageRoles(messages) {
  if (!messages || messages.length === 0) return messages;

  const normalized = [];
  let convertedCount = 0;

  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      normalized.push(
        makeUnifiedMessage('user', msg.content, msg.toolCalls, msg.toolResults, msg.images)
      );
      convertedCount += 1;
    } else {
      normalized.push(msg);
    }
  }

  if (convertedCount > 0) {
    logger.debug(`Normalized ${convertedCount} message(s) with unknown roles to 'user'`);
  }

  return normalized;
}

/**
 * Ensures alternating user/assistant roles by inserting synthetic
 * assistant messages between consecutive user messages.
 *
 * @param {Array<object>} messages - Messages in unified format
 * @returns {Array<object>} Messages with synthetic assistants inserted
 */
function ensureAlternatingRoles(messages) {
  if (!messages || messages.length < 2) return messages;

  const result = [messages[0]];
  let syntheticCount = 0;

  for (const msg of messages.slice(1)) {
    const prevRole = result[result.length - 1].role;

    if (msg.role === 'user' && prevRole === 'user') {
      result.push(makeUnifiedMessage('assistant', '(empty placeholder)'));
      syntheticCount += 1;
    }

    result.push(msg);
  }

  if (syntheticCount > 0) {
    logger.debug(`Inserted ${syntheticCount} synthetic assistant message(s) to ensure alternation`);
  }

  return result;
}

// ==================================================================================================
// Kiro History Building
// ==================================================================================================

/**
 * Builds the history array for the Kiro API from unified messages.
 *
 * @param {Array<object>} messages - Messages with normalized roles
 * @param {string} modelId - Internal Kiro model ID
 * @returns {Array<object>} History entries for the Kiro API
 */
function buildKiroHistory(messages, modelId) {
  const history = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      let content = extractTextContent(msg.content);
      if (!content) content = '(empty placeholder)';

      const userInput = {
        content,
        modelId,
        origin: 'AI_EDITOR',
      };

      // Images go directly into userInputMessage (matching native Kiro IDE format)
      const images = msg.images || extractImagesFromContent(msg.content);
      if (images && images.length > 0) {
        const kiroImages = convertImagesToKiroFormat(images);
        if (kiroImages.length > 0) {
          userInput.images = kiroImages;
        }
      }

      // userInputMessageContext for tools and toolResults only
      const userInputContext = {};

      if (msg.toolResults) {
        const kiroToolResults = convertToolResultsToKiroFormat(msg.toolResults);
        if (kiroToolResults.length > 0) {
          userInputContext.toolResults = kiroToolResults;
        }
      } else {
        const toolResults = extractToolResultsFromContent(msg.content);
        if (toolResults.length > 0) {
          userInputContext.toolResults = toolResults;
        }
      }

      if (Object.keys(userInputContext).length > 0) {
        userInput.userInputMessageContext = userInputContext;
      }

      history.push({ userInputMessage: userInput });
    } else if (msg.role === 'assistant') {
      let content = extractTextContent(msg.content);
      if (!content) content = '(empty placeholder)';

      const assistantResponse = { content };

      const toolUses = extractToolUsesFromMessage(msg.content, msg.toolCalls);
      if (toolUses.length > 0) {
        assistantResponse.toolUses = toolUses;
      }

      history.push({ assistantResponseMessage: assistantResponse });
    }
  }

  return history;
}

// ==================================================================================================
// Main Payload Building
// ==================================================================================================

/**
 * Builds the complete payload for the Kiro API from unified data.
 *
 * @param {object} options - Payload options
 * @param {Array<object>} options.messages - Messages in unified format
 * @param {string} options.systemPrompt - Extracted system prompt
 * @param {string} options.modelId - Internal Kiro model ID
 * @param {Array<object>|null} options.tools - Tools in unified format
 * @param {string} options.conversationId - Unique conversation ID
 * @param {string} options.profileArn - AWS CodeWhisperer profile ARN
 * @param {object} options.thinkingConfig - Thinking configuration
 * @returns {{payload: object, toolDocumentation: string}} KiroPayloadResult
 * @throws {Error} If there are no messages to send
 */
function buildKiroPayload({
  messages,
  systemPrompt,
  modelId,
  tools,
  conversationId,
  profileArn,
  thinkingConfig,
}) {
  // Process tools with long descriptions
  const [processedTools, toolDocumentation] = processToolsWithLongDescriptions(tools);

  // Validate tool names against the 64-character limit
  validateToolNames(processedTools);

  // Build the full system prompt
  let fullSystemPrompt = systemPrompt || '';
  if (toolDocumentation) {
    fullSystemPrompt = fullSystemPrompt
      ? fullSystemPrompt + toolDocumentation
      : toolDocumentation.trim();
  }

  const thinkingSystemAddition = getThinkingSystemPromptAddition();
  if (thinkingSystemAddition) {
    fullSystemPrompt = fullSystemPrompt
      ? fullSystemPrompt + thinkingSystemAddition
      : thinkingSystemAddition.trim();
  }

  // If no tools are defined, strip ALL tool-related content from messages
  let messagesWithAssistants;
  let convertedToolResults;
  if (!tools || tools.length === 0) {
    const [messagesWithoutTools] = stripAllToolContent(messages);
    messagesWithAssistants = messagesWithoutTools;
    convertedToolResults = true;
  } else {
    const [processed, converted] = ensureAssistantBeforeToolResults(messages);
    messagesWithAssistants = processed;
    convertedToolResults = converted;
  }

  // Merge adjacent messages with the same role
  let mergedMessages = mergeAdjacentMessages(messagesWithAssistants);

  // Ensure first message is from user
  mergedMessages = ensureFirstMessageIsUser(mergedMessages);

  // Normalize unknown roles to 'user'
  mergedMessages = normalizeMessageRoles(mergedMessages);

  // Ensure alternating user/assistant roles
  mergedMessages = ensureAlternatingRoles(mergedMessages);

  if (!mergedMessages || mergedMessages.length === 0) {
    throw new Error('No messages to send');
  }

  // Build history (all messages except the last one)
  const historyMessages = mergedMessages.length > 1 ? mergedMessages.slice(0, -1) : [];

  // If there's a system prompt, add it to the first user message in history
  if (fullSystemPrompt && historyMessages.length > 0) {
    const firstMsg = historyMessages[0];
    if (firstMsg.role === 'user') {
      const originalContent = extractTextContent(firstMsg.content);
      firstMsg.content = `${fullSystemPrompt}\n\n${originalContent}`;
    }
  }

  const history = buildKiroHistory(historyMessages, modelId);

  // Current message (the last one)
  const currentMessage = mergedMessages[mergedMessages.length - 1];
  let currentContent = extractTextContent(currentMessage.content);

  // If system prompt exists but history is empty - add to current message
  if (fullSystemPrompt && history.length === 0) {
    currentContent = `${fullSystemPrompt}\n\n${currentContent}`;
  }

  // If current message is assistant, add it to history and create a placeholder
  if (currentMessage.role === 'assistant') {
    history.push({
      assistantResponseMessage: { content: currentContent },
    });
    currentContent = '(empty placeholder)';
  }

  if (!currentContent) {
    currentContent = '(empty placeholder)';
  }

  // Process images in the current message
  const images = currentMessage.images || extractImagesFromContent(currentMessage.content);
  let kiroImages = null;
  if (images && images.length > 0) {
    kiroImages = convertImagesToKiroFormat(images);
    if (kiroImages && kiroImages.length > 0) {
      logger.debug(`Added ${kiroImages.length} image(s) to current message`);
    }
  }

  // Build userInputMessageContext for tools and toolResults only
  const userInputContext = {};

  const kiroTools = convertToolsToKiroFormat(processedTools);
  if (kiroTools.length > 0) {
    userInputContext.tools = kiroTools;
  }

  if (currentMessage.toolResults) {
    const kiroToolResults = convertToolResultsToKiroFormat(currentMessage.toolResults);
    if (kiroToolResults.length > 0) {
      userInputContext.toolResults = kiroToolResults;
    }
  } else {
    const toolResults = extractToolResultsFromContent(currentMessage.content);
    if (toolResults.length > 0) {
      userInputContext.toolResults = toolResults;
    }
  }

  // Inject thinking tags (only for the current/last user message)
  if (currentMessage.role === 'user') {
    currentContent = injectThinkingTags(currentContent, thinkingConfig);
  }

  // Build userInputMessage
  const userInputMessage = {
    content: currentContent,
    modelId,
    origin: 'AI_EDITOR',
  };

  if (kiroImages && kiroImages.length > 0) {
    userInputMessage.images = kiroImages;
  }

  if (Object.keys(userInputContext).length > 0) {
    userInputMessage.userInputMessageContext = userInputContext;
  }

  // Assemble the final payload
  const payload = {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId,
      currentMessage: {
        userInputMessage,
      },
    },
  };

  if (history.length > 0) {
    payload.conversationState.history = history;
  }

  if (profileArn) {
    payload.profileArn = profileArn;
  }

  return { payload, toolDocumentation };
}

module.exports = {
  makeUnifiedMessage,
  makeThinkingConfig,
  makeUnifiedTool,
  extractTextContent,
  extractImagesFromContent,
  getThinkingSystemPromptAddition,
  injectThinkingTags,
  sanitizeJsonSchema,
  processToolsWithLongDescriptions,
  validateToolNames,
  convertToolsToKiroFormat,
  convertImagesToKiroFormat,
  convertToolResultsToKiroFormat,
  extractToolResultsFromContent,
  extractToolUsesFromMessage,
  toolCallsToText,
  toolResultsToText,
  stripAllToolContent,
  ensureAssistantBeforeToolResults,
  mergeAdjacentMessages,
  ensureFirstMessageIsUser,
  normalizeMessageRoles,
  ensureAlternatingRoles,
  buildKiroHistory,
  buildKiroPayload,
};