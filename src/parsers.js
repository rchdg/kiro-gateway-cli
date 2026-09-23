'use strict';

/**
 * Parser for the AWS Event Stream format used by the Kiro API.
 *
 * AWS returns events with JSON fragments delimited by `:message-type...event`.
 * This parser scans the accumulated text buffer for known JSON event patterns
 * and extracts complete JSON objects.
 *
 * Also contains bracket-style tool call parsing and deduplication.
 * Mirrors `kiro/parsers.py`.
 */

const { generateToolCallId } = require('./utils');

/**
 * Finds the position of the closing brace considering nesting and strings.
 *
 * @param {string} text - Text to search
 * @param {number} startPos - Position of the opening brace '{'
 * @returns {number} Position of the closing brace, or -1 if not found
 */
function findMatchingBrace(text, startPos) {
  if (startPos >= text.length || text[startPos] !== '{') return -1;

  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startPos; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        braceCount += 1;
      } else if (char === '}') {
        braceCount -= 1;
        if (braceCount === 0) {
          return i;
        }
      }
    }
  }

  return -1;
}

/**
 * Parses tool calls in "[Called func_name with args: {...}]" format.
 *
 * Some models return tool calls in text format instead of structured JSON.
 *
 * @param {string} responseText - Model response text
 * @returns {Array<object>} Tool calls in OpenAI format
 */
function parseBracketToolCalls(responseText) {
  if (!responseText || !responseText.includes('[Called')) {
    return [];
  }

  const toolCalls = [];
  const pattern = /\[Called\s+(\w+)\s+with\s+args:\s*/gi;

  let match;
  while ((match = pattern.exec(responseText)) !== null) {
    const funcName = match[1];
    const argsStart = pattern.lastIndex;

    const jsonStart = responseText.indexOf('{', argsStart);
    if (jsonStart === -1) continue;

    const jsonEnd = findMatchingBrace(responseText, jsonStart);
    if (jsonEnd === -1) continue;

    const jsonStr = responseText.slice(jsonStart, jsonEnd + 1);

    try {
      const args = JSON.parse(jsonStr);
      toolCalls.push({
        id: generateToolCallId(),
        type: 'function',
        function: {
          name: funcName,
          arguments: JSON.stringify(args),
        },
      });
    } catch {
      // Failed to parse arguments - skip this call
    }
  }

  return toolCalls;
}

/**
 * Removes duplicate tool calls.
 *
 * Deduplication criteria:
 * 1. By id - keep the one with more (non-empty) arguments
 * 2. By name+arguments - remove complete duplicates
 *
 * @param {Array<object>} toolCalls - List of tool calls
 * @returns {Array<object>} Unique tool calls
 */
function deduplicateToolCalls(toolCalls) {
  // First deduplicate by id - keep tool call with non-empty arguments
  const byId = new Map();
  for (const tc of toolCalls) {
    const tcId = tc && tc.id;
    if (!tcId) continue; // Without id - deduplicated by name+args later

    const existing = byId.get(tcId);
    if (!existing) {
      byId.set(tcId, tc);
    } else {
      const existingArgs = ((existing.function || {}).arguments) || '{}';
      const currentArgs = ((tc.function || {}).arguments) || '{}';
      if (currentArgs !== '{}' && (existingArgs === '{}' || currentArgs.length > existingArgs.length)) {
        byId.set(tcId, tc);
      }
    }
  }

  const resultWithId = Array.from(byId.values());
  const resultWithoutId = toolCalls.filter((tc) => !tc || !tc.id);

  // Deduplicate by name+arguments for all
  const seen = new Set();
  const unique = [];

  for (const tc of resultWithId.concat(resultWithoutId)) {
    const func = (tc && tc.function) || {};
    const funcName = func.name || '';
    const funcArgs = func.arguments || '{}';
    const key = `${funcName}-${funcArgs}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(tc);
    }
  }

  return unique;
}

class AwsEventStreamParser {
  /**
   * Parser for the AWS Event Stream format.
   *
   * Supported event types:
   * - content: text content of the response
   * - tool_start: start of a tool call (name, toolUseId)
   * - tool_input: continuation of input for a tool call
   * - tool_stop: end of a tool call
   * - usage: credit consumption information
   * - context_usage: context usage percentage
   */
  constructor() {
    this.buffer = '';
    this.lastContent = null; // For deduplicating repeating content
    this.currentToolCall = null;
    this.toolCalls = [];
  }

  // Patterns for finding JSON events
  static EVENT_PATTERNS = [
    ['{"content":', 'content'],
    ['{"name":', 'tool_start'],
    ['{"input":', 'tool_input'],
    ['{"stop":', 'tool_stop'],
    ['{"followupPrompt":', 'followup'],
    ['{"usage":', 'usage'],
    ['{"contextUsagePercentage":', 'context_usage'],
    // metadataEvent: Kiro aborts the turn here (e.g. stopReason CONTENT_FILTERED
    // with a REASONING_EXTRACTION refusal). Without this the turn silently
    // looks like a short but successful answer.
    ['{"stopDetails":', 'stop_details'],
    ['{"stopReason":', 'stop_details'],
  ];

  /**
   * Adds a chunk to the buffer and returns parsed events.
   *
   * @param {string} chunk - Decoded text chunk from the stream
   * @returns {Array<{type: string, data: any}>} Parsed events
   */
  feed(chunk) {
    this.buffer += chunk;

    const events = [];

    while (true) {
      // Find the nearest pattern
      let earliestPos = -1;
      let earliestType = null;

      for (const [pattern, eventType] of AwsEventStreamParser.EVENT_PATTERNS) {
        const pos = this.buffer.indexOf(pattern);
        if (pos !== -1 && (earliestPos === -1 || pos < earliestPos)) {
          earliestPos = pos;
          earliestType = eventType;
        }
      }

      if (earliestPos === -1) break;

      // Find JSON end
      const jsonEnd = findMatchingBrace(this.buffer, earliestPos);
      if (jsonEnd === -1) break; // JSON not complete, wait for more data

      const jsonStr = this.buffer.slice(earliestPos, jsonEnd + 1);
      this.buffer = this.buffer.slice(jsonEnd + 1);

      try {
        const data = JSON.parse(jsonStr);
        const event = this._processEvent(data, earliestType);
        if (event) {
          events.push(event);
        }
      } catch {
        // Malformed JSON - skip this fragment
      }
    }

    return events;
  }

  /**
   * Processes a parsed event.
   *
   * @param {object} data - Parsed JSON
   * @param {string} eventType - Event type
   * @returns {{type: string, data: any}|null} Processed event or null
   */
  _processEvent(data, eventType) {
    switch (eventType) {
      case 'content':
        return this._processContentEvent(data);
      case 'tool_start':
        return this._processToolStartEvent(data);
      case 'tool_input':
        return this._processToolInputEvent(data);
      case 'tool_stop':
        return this._processToolStopEvent(data);
      case 'usage':
        return { type: 'usage', data: data.usage || 0 };
      case 'context_usage':
        return { type: 'context_usage', data: data.contextUsagePercentage || 0 };
      case 'stop_details':
        return this._processStopDetailsEvent(data);
      default:
        return null;
    }
  }

  /**
   * Processes a metadataEvent carrying stop details.
   *
   * Kiro ends a turn early with `stopReason` (e.g. `CONTENT_FILTERED`) and an
   * optional `stopDetails.refusal`. Only abnormal stops produce an event; a
   * plain `stopReason: "END_TURN"` is not worth reporting.
   *
   * @param {object} data - Event data
   * @returns {{type: string, data: object}|null} Refusal event or null
   */
  _processStopDetailsEvent(data) {
    const stopReason = typeof data.stopReason === 'string' ? data.stopReason : null;
    const refusal = (data.stopDetails && data.stopDetails.refusal) || null;

    if (!refusal && (!stopReason || stopReason === 'END_TURN')) return null;

    return {
      type: 'refusal',
      data: {
        stopReason,
        category: (refusal && refusal.category) || null,
        explanation: (refusal && refusal.explanation) || null,
      },
    };
  }

  /**
   * Processes a content event.
   *
   * @param {object} data - Event data
   * @returns {{type: string, data: string}|null} Content event or null
   */
  _processContentEvent(data) {
    const content = data.content || '';

    // Skip followupPrompt
    if (data.followupPrompt) return null;

    // Deduplicate repeating content
    if (content === this.lastContent) return null;

    this.lastContent = content;

    return { type: 'content', data: content };
  }

  /**
   * Processes a tool call start event.
   *
   * @param {object} data - Event data
   * @returns {null} Tool start produces no immediate output event
   */
  _processToolStartEvent(data) {
    // Finalize previous tool call if exists
    if (this.currentToolCall) {
      this._finalizeToolCall();
    }

    const inputData = data.input;
    let inputStr;
    if (typeof inputData === 'object' && inputData !== null) {
      if (Object.keys(inputData).length > 0) {
        inputStr = JSON.stringify(inputData);
      } else {
        inputStr = ''; // Empty dict {}: fragments will follow
      }
    } else {
      inputStr = inputData ? String(inputData) : '';
    }

    this.currentToolCall = {
      id: data.toolUseId || generateToolCallId(),
      type: 'function',
      function: {
        name: data.name || '',
        arguments: inputStr,
      },
    };

    if (data.stop) {
      this._finalizeToolCall();
    }

    return null;
  }

  /**
   * Processes an input continuation event for a tool call.
   *
   * @param {object} data - Event data
   * @returns {null} Tool input produces no immediate output event
   */
  _processToolInputEvent(data) {
    if (this.currentToolCall) {
      const inputData = data.input;
      let inputStr;
      if (typeof inputData === 'object' && inputData !== null) {
        if (Object.keys(inputData).length > 0) {
          inputStr = JSON.stringify(inputData);
        } else {
          inputStr = '';
        }
      } else {
        inputStr = inputData ? String(inputData) : '';
      }
      this.currentToolCall.function.arguments += inputStr;
    }
    return null;
  }

  /**
   * Processes a tool call end event.
   *
   * @param {object} data - Event data
   * @returns {null} Tool stop produces no immediate output event
   */
  _processToolStopEvent(data) {
    if (this.currentToolCall && data.stop) {
      this._finalizeToolCall();
    }
    return null;
  }

  /**
   * Finalizes the current tool call and adds it to the list.
   */
  _finalizeToolCall() {
    if (!this.currentToolCall) return;

    let args = this.currentToolCall.function.arguments;
    const toolName = this.currentToolCall.function.name || 'unknown';

    if (typeof args === 'string') {
      if (args.trim()) {
        try {
          const parsed = JSON.parse(args);
          this.currentToolCall.function.arguments = JSON.stringify(parsed);
        } catch {
          // Truncated or malformed arguments - replace with empty object
          this.currentToolCall.function.arguments = '{}';
        }
      } else {
        // Empty string - normal for duplicate tool calls from Kiro
        this.currentToolCall.function.arguments = '{}';
      }
    } else if (typeof args === 'object' && args !== null) {
      this.currentToolCall.function.arguments = JSON.stringify(args);
    } else {
      this.currentToolCall.function.arguments = '{}';
    }

    this.toolCalls.push(this.currentToolCall);
    this.currentToolCall = null;
  }

  /**
   * Returns all collected tool calls (finalizing the current one).
   *
   * @returns {Array<object>} Unique tool calls
   */
  getToolCalls() {
    if (this.currentToolCall) {
      this._finalizeToolCall();
    }
    return deduplicateToolCalls(this.toolCalls);
  }

  /**
   * Resets the parser state.
   */
  reset() {
    this.buffer = '';
    this.lastContent = null;
    this.currentToolCall = null;
    this.toolCalls = [];
  }
}

module.exports = {
  findMatchingBrace,
  parseBracketToolCalls,
  deduplicateToolCalls,
  AwsEventStreamParser,
};