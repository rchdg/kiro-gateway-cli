'use strict';

/**
 * Utility functions: machine fingerprint, Kiro request headers,
 * ID generation. Mirrors `kiro/utils.py`.
 */

const crypto = require('node:crypto');
const os = require('node:os');

/**
 * Generates a unique machine fingerprint based on hostname and username.
 *
 * Used for the User-Agent to identify a specific gateway installation.
 *
 * @returns {string} SHA256 hash of "{hostname}-{username}-kiro-gateway"
 */
function getMachineFingerprint() {
  try {
    const uniqueString = `${os.hostname()}-${os.userInfo().username}-kiro-gateway`;
    return crypto.createHash('sha256').update(uniqueString).digest('hex');
  } catch {
    return crypto.createHash('sha256').update('default-kiro-gateway').digest('hex');
  }
}

/**
 * Builds headers for Kiro API requests.
 *
 * @param {object} authManager - Auth manager exposing `fingerprint`
 * @param {string} token - Access token
 * @returns {object} Headers object for the upstream request
 */
function getKiroHeaders(authManager, token) {
  const fingerprint = authManager.fingerprint;
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/x-amz-json-1.0',
    'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
    'User-Agent': `aws-sdk-js/1.0.27 ua/2.1 os/win32#10.0.19044 lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.7.45-${fingerprint}`,
    'x-amz-user-agent': `aws-sdk-js/1.0.27 KiroIDE-0.7.45-${fingerprint}`,
    'x-amzn-codewhisperer-optout': 'true',
    'x-amzn-kiro-agent-mode': 'vibe',
    'amz-sdk-invocation-id': crypto.randomUUID(),
    'amz-sdk-request': 'attempt=1; max=3',
  };
}

/**
 * Generates a unique ID for chat completion.
 *
 * @returns {string} ID in "chatcmpl-{hex}" format
 */
function generateCompletionId() {
  return `chatcmpl-${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Generates a conversation ID.
 *
 * When `messages` is provided, generates a stable ID based on message
 * history (first 3 messages + last one); otherwise a random UUID.
 *
 * @param {Array<object>} [messages] - Messages in the conversation
 * @returns {string} Stable conversation ID or random UUID
 */
function generateConversationId(messages = null) {
  if (!messages || messages.length === 0) {
    return crypto.randomUUID();
  }

  const keyMessages =
    messages.length <= 3 ? messages : messages.slice(0, 3).concat(messages.slice(-1));

  const simplified = keyMessages.map((msg) => {
    let contentStr = '';
    const content = msg && msg.content;
    if (typeof content === 'string') {
      contentStr = content.slice(0, 100);
    } else if (Array.isArray(content)) {
      contentStr = JSON.stringify(content).slice(0, 100);
    } else {
      contentStr = String(content).slice(0, 100);
    }
    return { role: (msg && msg.role) || 'unknown', content: contentStr };
  });

  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(simplified))
    .digest('hex');
  return hash.slice(0, 16);
}

/**
 * Generates a unique ID for a tool call.
 *
 * @returns {string} ID in "call_{hex8}" format
 */
function generateToolCallId() {
  return `call_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Generates a unique message ID in Anthropic format.
 *
 * @returns {string} ID in "msg_{hex24}" format
 */
function generateMessageId() {
  return `msg_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Generates a placeholder signature for thinking content blocks.
 *
 * @returns {string} Placeholder signature string
 */
function generateThinkingSignature() {
  return `sig_${crypto.randomBytes(16).toString('hex')}`;
}

module.exports = {
  getMachineFingerprint,
  getKiroHeaders,
  generateCompletionId,
  generateConversationId,
  generateToolCallId,
  generateMessageId,
  generateThinkingSignature,
};