'use strict';

/**
 * Thinking block parser for streaming responses (finite state machine).
 *
 * Detects thinking tags ONLY at the start of the response, implements
 * "cautious" buffering to avoid splitting tags across network chunks,
 * and treats all content after the closing tag as regular content.
 *
 * Mirrors `kiro/thinking_parser.py`.
 */

const {
  FAKE_REASONING_HANDLING,
  FAKE_REASONING_OPEN_TAGS,
  FAKE_REASONING_INITIAL_BUFFER_SIZE,
} = require('./config');

const ParserState = Object.freeze({
  PRE_CONTENT: 0,
  IN_THINKING: 1,
  STREAMING: 2,
});

/**
 * Result of processing a content chunk through the parser.
 *
 * @returns {object} Fresh result object
 */
function emptyResult() {
  return {
    thinkingContent: null,
    regularContent: null,
    isFirstThinkingChunk: false,
    isLastThinkingChunk: false,
    stateChanged: false,
  };
}

class ThinkingParser {
  /**
   * Finite state machine parser for thinking blocks.
   *
   * @param {object} [options] - Parser options
   * @param {string} [options.handlingMode] - How to handle thinking blocks
   * @param {string[]} [options.openTags] - Opening tags to detect
   * @param {number} [options.initialBufferSize] - Max chars to buffer for tag detection
   */
  constructor({
    handlingMode = FAKE_REASONING_HANDLING,
    openTags = FAKE_REASONING_OPEN_TAGS,
    initialBufferSize = FAKE_REASONING_INITIAL_BUFFER_SIZE,
  } = {}) {
    this.handlingMode = handlingMode;
    this.openTags = openTags;
    this.initialBufferSize = initialBufferSize;

    // Buffer enough to not split a closing tag across chunks
    this.maxTagLength = Math.max(...openTags.map((t) => t.length)) * 2;

    // State
    this.state = ParserState.PRE_CONTENT;
    this.initialBuffer = '';
    this.thinkingBuffer = '';
    this.openTag = null;
    this.closeTag = null;
    this.isFirstThinkingChunk = true;
    this._thinkingBlockFound = false;
  }

  /**
   * Processes a chunk of content through the parser.
   *
   * @param {string} content - New content from the stream
   * @returns {object} ThinkingParseResult
   */
  feed(content) {
    const result = emptyResult();

    if (!content) return result;

    if (this.state === ParserState.PRE_CONTENT) {
      this._handlePreContent(content, result);
    }

    if (this.state === ParserState.IN_THINKING && !result.stateChanged) {
      this._handleInThinking(content, result);
    }

    if (this.state === ParserState.STREAMING && !result.stateChanged) {
      result.regularContent = content;
    }

    return result;
  }

  /**
   * Handles content in the PRE_CONTENT state (buffering for tag detection).
   *
   * @param {string} content - New content
   * @param {object} result - Result object to fill
   */
  _handlePreContent(content, result) {
    this.initialBuffer += content;

    const stripped = this.initialBuffer.trimStart();

    // Check if the buffer starts with any opening tag
    for (const tag of this.openTags) {
      if (stripped.startsWith(tag)) {
        this.state = ParserState.IN_THINKING;
        this.openTag = tag;
        // <thinking> -> </thinking>
        this.closeTag = `</${tag.slice(1)}`;
        this._thinkingBlockFound = true;
        result.stateChanged = true;

        // Content after the tag goes to the thinking buffer
        const contentAfterTag = stripped.slice(tag.length);
        this.thinkingBuffer = contentAfterTag;
        this.initialBuffer = '';

        this._processThinkingBuffer(result);
        return;
      }
    }

    // Check if we might still be receiving the tag
    for (const tag of this.openTags) {
      if (tag.startsWith(stripped) && stripped.length < tag.length) {
        return; // Keep buffering
      }
    }

    // No tag found and the buffer is too long or doesn't match any tag prefix
    if (this.initialBuffer.length > this.initialBufferSize || !this._couldBeTagPrefix(stripped)) {
      this.state = ParserState.STREAMING;
      result.stateChanged = true;
      result.regularContent = this.initialBuffer;
      this.initialBuffer = '';
    }
  }

  /**
   * Checks if text could be the start of any opening tag.
   *
   * @param {string} text - Text to check
   * @returns {boolean} True if it could be a tag prefix
   */
  _couldBeTagPrefix(text) {
    if (!text) return true;
    return this.openTags.some((tag) => tag.startsWith(text));
  }

  /**
   * Handles content in the IN_THINKING state (looking for the closing tag).
   *
   * @param {string} content - New content
   * @param {object} result - Result object to fill
   */
  _handleInThinking(content, result) {
    this.thinkingBuffer += content;
    this._processThinkingBuffer(result);
  }

  /**
   * Processes the thinking buffer, looking for the closing tag.
   *
   * Implements "cautious" sending - keeps the last maxTagLength chars
   * buffered to avoid splitting the closing tag across chunks.
   *
   * @param {object} result - Result object to fill
   */
  _processThinkingBuffer(result) {
    if (!this.closeTag) return;

    const closeTagIdx = this.thinkingBuffer.indexOf(this.closeTag);
    if (closeTagIdx !== -1) {
      // Found the closing tag!
      const thinkingContent = this.thinkingBuffer.slice(0, closeTagIdx);
      const afterTag = this.thinkingBuffer.slice(closeTagIdx + this.closeTag.length);

      if (thinkingContent) {
        result.thinkingContent = thinkingContent;
        result.isFirstThinkingChunk = this.isFirstThinkingChunk;
        this.isFirstThinkingChunk = false;
      }

      result.isLastThinkingChunk = true;

      // Transition to STREAMING
      this.state = ParserState.STREAMING;
      result.stateChanged = true;
      this.thinkingBuffer = '';

      // Content after the closing tag is regular content
      // Strip leading whitespace/newlines that often follow the closing tag
      if (afterTag) {
        const strippedAfter = afterTag.trimStart();
        if (strippedAfter) {
          result.regularContent = strippedAfter;
        }
      }
      return;
    }

    // No closing tag yet - use "cautious" sending
    if (this.thinkingBuffer.length > this.maxTagLength) {
      const sendPart = this.thinkingBuffer.slice(0, -this.maxTagLength);
      this.thinkingBuffer = this.thinkingBuffer.slice(-this.maxTagLength);

      result.thinkingContent = sendPart;
      result.isFirstThinkingChunk = this.isFirstThinkingChunk;
      this.isFirstThinkingChunk = false;
    }
  }

  /**
   * Finalizes parsing when the stream ends (flushes buffered content).
   *
   * @returns {object} ThinkingParseResult with any remaining content
   */
  finalize() {
    const result = emptyResult();

    if (this.thinkingBuffer) {
      if (this.state === ParserState.IN_THINKING) {
        result.thinkingContent = this.thinkingBuffer;
        result.isFirstThinkingChunk = this.isFirstThinkingChunk;
        result.isLastThinkingChunk = true;
      } else {
        result.regularContent = this.thinkingBuffer;
      }
      this.thinkingBuffer = '';
    }

    if (this.initialBuffer) {
      result.regularContent = (result.regularContent || '') + this.initialBuffer;
      this.initialBuffer = '';
    }

    return result;
  }

  /**
   * Resets the parser to its initial state.
   */
  reset() {
    this.state = ParserState.PRE_CONTENT;
    this.initialBuffer = '';
    this.thinkingBuffer = '';
    this.openTag = null;
    this.closeTag = null;
    this.isFirstThinkingChunk = true;
    this._thinkingBlockFound = false;
  }

  /** @returns {boolean} True if a thinking block was detected */
  get foundThinkingBlock() {
    return this._thinkingBlockFound;
  }

  /**
   * Processes thinking content according to the handling mode.
   *
   * @param {string|null} thinkingContent - Raw thinking content
   * @param {boolean} isFirst - True for the first thinking chunk
   * @param {boolean} isLast - True for the last thinking chunk
   * @returns {string|null} Processed content or null (for "remove" mode)
   */
  processForOutput(thinkingContent, isFirst, isLast) {
    if (!thinkingContent) return null;

    if (this.handlingMode === 'remove') {
      return null;
    }

    if (this.handlingMode === 'pass') {
      const prefix = isFirst && this.openTag ? this.openTag : '';
      const suffix = isLast && this.closeTag ? this.closeTag : '';
      return `${prefix}${thinkingContent}${suffix}`;
    }

    if (this.handlingMode === 'strip_tags') {
      return thinkingContent;
    }

    // "as_reasoning_content" - return as-is, caller puts it in reasoning_content
    return thinkingContent;
  }
}

module.exports = { ParserState, ThinkingParser };