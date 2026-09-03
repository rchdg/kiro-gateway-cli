'use strict';

/**
 * Error handling: Kiro API error enhancement, account error
 * classification, and network error classification.
 *
 * Mirrors `kiro/kiro_errors.py`, `kiro/account_errors.py`, and
 * `kiro/network_errors.py` of the Python implementation.
 */

const { Logger } = require('./logger');

const logger = new Logger();

/**
 * HTTP error raised inside the gateway. `statusCode` maps to the
 * response status returned to the API client.
 */
class ApiError extends Error {
  /**
   * @param {number} statusCode - HTTP status code for the client
   * @param {string} message - User-friendly error message
   * @param {number} [suggestedHttpCode] - Optional override of statusCode
   */
  constructor(statusCode, message, suggestedHttpCode) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = suggestedHttpCode || statusCode;
  }
}

// ==================================================================================================
// Kiro API Error Enhancement
// ==================================================================================================

/**
 * Enhances a Kiro API error with a user-friendly message.
 *
 * @param {object} errorJson - Parsed JSON from the Kiro error response
 * @returns {{reason: string, userMessage: string, originalMessage: string}}
 */
function enhanceKiroError(errorJson) {
  const originalMessage = errorJson && errorJson.message != null ? errorJson.message : 'Unknown error';
  const reason = errorJson && errorJson.reason != null ? errorJson.reason : 'UNKNOWN';

  let userMessage;
  if (reason === 'CONTENT_LENGTH_EXCEEDS_THRESHOLD') {
    userMessage = 'Model context limit reached. Conversation size exceeds model capacity.';
  } else if (reason === 'MONTHLY_REQUEST_COUNT') {
    userMessage = 'Monthly request limit exceeded. Account has reached its monthly quota.';
  } else if (reason === 'INVALID_MODEL_ID') {
    userMessage = 'Invalid model ID or insufficient subscription level to use it.';
  } else if (originalMessage === 'Improperly formed request.' && ['UNKNOWN', 'null'].includes(reason)) {
    userMessage =
      'Kiro API rejected the request. If the problem persists, check the request structure or open an issue with debug logs.';
  } else if (reason !== 'UNKNOWN') {
    userMessage = `${originalMessage} (reason: ${reason})`;
  } else {
    userMessage = originalMessage;
  }

  return { reason, userMessage, originalMessage };
}

/**
 * Tries to parse an error body and enhance it. Returns raw text
 * when the body is not JSON.
 *
 * @param {string} errorText - Raw error body text
 * @returns {{reason: string|null, userMessage: string}}
 */
function parseKiroError(errorText) {
  try {
    const errorJson = JSON.parse(errorText);
    const info = enhanceKiroError(errorJson);
    return { reason: info.reason, userMessage: info.userMessage };
  } catch {
    return { reason: null, userMessage: errorText };
  }
}

// ==================================================================================================
// Account Error Classification
// ==================================================================================================

const ErrorType = Object.freeze({
  FATAL: 'fatal',
  RECOVERABLE: 'recoverable',
});

/**
 * Classifies a Kiro API error for failover decisions.
 *
 * @param {number} statusCode - HTTP status code from Kiro API
 * @param {string|null} reason - Error reason from Kiro API (may be null)
 * @returns {string} ErrorType.FATAL or ErrorType.RECOVERABLE
 */
function classifyError(statusCode, reason) {
  if (statusCode === 402 || statusCode === 403 || statusCode === 429) {
    return ErrorType.RECOVERABLE;
  }

  if (statusCode === 400) {
    if (reason === 'INVALID_MODEL_ID') return ErrorType.RECOVERABLE;
    // CONTENT_LENGTH_EXCEEDS_THRESHOLD and generic bad requests are FATAL
    return ErrorType.FATAL;
  }

  if (statusCode === 422) {
    return ErrorType.FATAL;
  }

  if (statusCode >= 500 && statusCode < 600) {
    return ErrorType.FATAL;
  }

  return ErrorType.FATAL;
}

// ==================================================================================================
// Network Error Classification
// ==================================================================================================

const ErrorCategory = Object.freeze({
  DNS_RESOLUTION: 'dns_resolution',
  CONNECTION_REFUSED: 'connection_refused',
  CONNECTION_RESET: 'connection_reset',
  NETWORK_UNREACHABLE: 'network_unreachable',
  TIMEOUT_CONNECT: 'timeout_connect',
  TIMEOUT_READ: 'timeout_read',
  SSL_ERROR: 'ssl_error',
  PROXY_ERROR: 'proxy_error',
  TOO_MANY_REDIRECTS: 'too_many_redirects',
  UNKNOWN: 'unknown',
});

const CATEGORY_DETAILS = {
  [ErrorCategory.DNS_RESOLUTION]: {
    userMessage: 'DNS resolution failed. Could not resolve the Kiro API hostname.',
    steps: [
      'Check your internet connection and DNS settings',
      'Try flushing DNS cache (dns flush)',
      'If in a restricted network, configure VPN_PROXY_URL',
    ],
    retryable: true,
    httpCode: 502,
  },
  [ErrorCategory.CONNECTION_REFUSED]: {
    userMessage: 'Connection refused by the Kiro API server.',
    steps: [
      'Check if the API endpoint is reachable from your network',
      'If in a restricted network, configure VPN_PROXY_URL',
    ],
    retryable: false,
    httpCode: 502,
  },
  [ErrorCategory.CONNECTION_RESET]: {
    userMessage: 'Connection was reset by the server during request.',
    steps: ['Try again later', 'If in a restricted network, configure VPN_PROXY_URL'],
    retryable: true,
    httpCode: 502,
  },
  [ErrorCategory.NETWORK_UNREACHABLE]: {
    userMessage: 'Network is unreachable.',
    steps: ['Check your internet connection', 'If in a restricted network, configure VPN_PROXY_URL'],
    retryable: true,
    httpCode: 502,
  },
  [ErrorCategory.TIMEOUT_CONNECT]: {
    userMessage: 'Connection timeout. The Kiro API server did not respond.',
    steps: ['Try again later', 'If in a restricted network, configure VPN_PROXY_URL'],
    retryable: true,
    httpCode: 504,
  },
  [ErrorCategory.TIMEOUT_READ]: {
    userMessage: 'Server response timeout. The Kiro API did not respond in time.',
    steps: ['Try again later', 'If the problem persists, the service may be down'],
    retryable: true,
    httpCode: 504,
  },
  [ErrorCategory.SSL_ERROR]: {
    userMessage: 'SSL/TLS error while connecting to the Kiro API.',
    steps: ['Check system date and time settings', 'Check for intercepting proxies or firewalls'],
    retryable: false,
    httpCode: 502,
  },
  [ErrorCategory.PROXY_ERROR]: {
    userMessage: 'Proxy error while connecting to the Kiro API.',
    steps: ['Check VPN_PROXY_URL configuration', 'Verify the proxy server is running'],
    retryable: true,
    httpCode: 502,
  },
  [ErrorCategory.TOO_MANY_REDIRECTS]: {
    userMessage: 'Too many redirects while connecting to the Kiro API.',
    steps: ['Check network configuration', 'Try again later'],
    retryable: false,
    httpCode: 502,
  },
  [ErrorCategory.UNKNOWN]: {
    userMessage: 'Unknown network error while connecting to the Kiro API.',
    steps: ['Try again later', 'Check your internet connection'],
    retryable: true,
    httpCode: 502,
  },
};

/**
 * Classifies a network error (usually thrown by fetch/undici).
 *
 * @param {Error} error - The error that occurred
 * @returns {{category: string, userMessage: string, troubleshootingSteps: string[],
 *            technicalDetails: string, isRetryable: boolean, suggestedHttpCode: number}}
 */
function classifyNetworkError(error) {
  const errorType = error && error.name ? error.name : 'Error';
  const errorStr = error && error.message ? error.message : String(error);
  const technicalDetails = `${errorType}: ${errorStr}`;

  // Extract underlying cause (undici wraps errors in TypeError("fetch failed"))
  const cause = error && error.cause ? error.cause : error;
  const causeCode = (cause && cause.code) || '';
  const causeStr = (cause && cause.message) || errorStr;

  let category = ErrorCategory.UNKNOWN;

  if (errorType === 'TimeoutError' || errorType === 'ReadTimeoutError' || causeCode === 'ETIMEDOUT') {
    category = ErrorCategory.TIMEOUT_READ;
  } else if (errorType === 'ConnectTimeoutError' || causeCode === 'UND_ERR_CONNECT_TIMEOUT') {
    category = ErrorCategory.TIMEOUT_CONNECT;
  } else if (errorType === 'AbortError' || causeCode === 'UND_ERR_ABORTED') {
    category = ErrorCategory.UNKNOWN;
  } else if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN' || causeCode === 'DNS') {
    category = ErrorCategory.DNS_RESOLUTION;
  } else if (causeCode === 'ECONNREFUSED') {
    category = ErrorCategory.CONNECTION_REFUSED;
  } else if (causeCode === 'ECONNRESET' || causeCode === 'EPIPE') {
    category = ErrorCategory.CONNECTION_RESET;
  } else if (causeCode === 'ENETUNREACH' || causeCode === 'EHOSTUNREACH') {
    category = ErrorCategory.NETWORK_UNREACHABLE;
  } else if (causeCode === 'ERR_TLS_CERT_ALTNAME_INVALID' || causeCode.startsWith('CERT') || /SSL|TLS/i.test(causeStr)) {
    category = ErrorCategory.SSL_ERROR;
  } else if (/Invalid EOF state|does not match the HTTP\/1\.1 protocol|other side closed/i.test(causeStr)) {
    // Mid-stream connection break surfaced by the HTTP/1.1 parser, common
    // when a proxy drops the tunnel mid-response.
    category = ErrorCategory.CONNECTION_RESET;
  } else if (errorType === 'ProxyError' || /proxy/i.test(causeStr)) {
    category = ErrorCategory.PROXY_ERROR;
  }

  const details = CATEGORY_DETAILS[category];

  return {
    category,
    userMessage: details.userMessage,
    troubleshootingSteps: details.steps,
    technicalDetails,
    isRetryable: details.retryable,
    suggestedHttpCode: details.httpCode,
  };
}

module.exports = {
  ApiError,
  ErrorType,
  ErrorCategory,
  classifyError,
  classifyNetworkError,
  enhanceKiroError,
  parseKiroError,
};