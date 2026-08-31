'use strict';

/**
 * HTTP client for the Kiro API with retry logic support.
 *
 * Handles:
 * - 403: automatic token refresh and retry
 * - 429: exponential backoff
 * - 5xx: exponential backoff
 * - Network errors: exponential backoff
 *
 * Uses undici.request for full control over headers and streaming.
 * Mirrors `kiro/http_client.py`.
 */

const undici = require('undici');
const { SocksProxyAgent } = require('socks-proxy-agent');

const { Logger } = require('./logger');
const { ApiError, classifyNetworkError } = require('./errors');
const { getKiroHeaders } = require('./utils');
const {
  MAX_RETRIES,
  BASE_RETRY_DELAY,
  FIRST_TOKEN_MAX_RETRIES,
  STREAMING_READ_TIMEOUT,
  VPN_PROXY_URL,
} = require('./config');

const logger = new Logger();

let _proxyDispatcher = null;
let _proxyDispatcherUrl = null;

// Schemes supported by undici.ProxyAgent (HTTP CONNECT tunneling).
const HTTP_PROXY_SCHEMES = ['http:', 'https:'];

// SOCKS proxy schemes. socks5h/socks4a/socks perform DNS resolution on the
// proxy side (remote DNS), socks5/socks4 resolve hostnames locally.
const SOCKS_PROXY_SCHEMES = ['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'];

// Timeout for the SOCKS tunnel setup and for the TLS handshake performed
// after the tunnel is established. undici's connectTimeout does not apply to
// custom connectors, so without these a stalled proxy or handshake would
// hang the request forever.
const SOCKS_TUNNEL_TIMEOUT_MS = 10_000;

// Minimal stand-in for an http.ClientRequest. socks-proxy-agent calls
// req.emit('proxy', ...) after a successful connection and req.destroy() on
// cleanup, but never reads any request state, so a no-op object is enough.
const _socksFakeReq = {
  destroy() {},
  emit() {
    return true;
  },
};

/**
 * Builds the undici dispatcher for the given proxy URL.
 *
 * Supports HTTP/HTTPS proxies (via undici.ProxyAgent) and SOCKS proxies
 * (socks, socks4, socks4a, socks5, socks5h) via socks-proxy-agent wired into
 * an undici.Agent custom `connect` function.
 *
 * @param {string} proxyUrl - Normalized proxy URL (with scheme)
 * @returns {undici.ProxyAgent|undici.Agent|null} Dispatcher, or null on failure
 */
function buildProxyDispatcher(proxyUrl) {
  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch (err) {
    logger.error(`Invalid proxy URL '${proxyUrl}': ${err.message}`);
    return null;
  }

  if (SOCKS_PROXY_SCHEMES.includes(parsed.protocol)) {
    return createSocksDispatcher(proxyUrl);
  }

  if (HTTP_PROXY_SCHEMES.includes(parsed.protocol)) {
    try {
      const agent = new undici.ProxyAgent(proxyUrl);
      logger.info(`Proxy configured: ${proxyUrl}`);
      return agent;
    } catch (err) {
      logger.error(`Failed to create proxy agent: ${err.message}`);
      return null;
    }
  }

  logger.warning(
    `Unsupported proxy scheme '${parsed.protocol}' in '${proxyUrl}'. ` +
      'Only HTTP/HTTPS and SOCKS (socks5, socks5h, socks4a) proxies are supported. Ignoring proxy.'
  );
  return null;
}

/**
 * Resolves the destination port for a SOCKS connection.
 *
 * undici passes null for the port when the target URL does not specify one,
 * and the socks library rejects non-number ports, so fall back to the
 * protocol default.
 *
 * @param {string} protocol - Origin protocol ('http:' or 'https:')
 * @param {number|null} port - Port from undici (null when unspecified)
 * @returns {number} Destination port
 */
function resolveSocksPort(protocol, port) {
  return port || (protocol === 'https:' ? 443 : 80);
}

/**
 * Builds the connect function for a SOCKS tunnel that undici uses as its
 * custom connector.
 *
 * For HTTPS origins the function waits for the TLS handshake to settle
 * before handing the socket to undici. Handing it over immediately would let
 * handshake errors surface on the socket error listener after connect, where
 * undici asserts (and crashes the process) on ERR_TLS_CERT_ALTNAME_INVALID.
 * Delivering them through the callback lets undici fail the request cleanly.
 *
 * The servername is derived explicitly because undici passes
 * `servername: null` even for hostname origins, while socks-proxy-agent only
 * falls back to the destination host when servername is `undefined`. Without
 * it, TLS certificate verification runs against the socket default instead of
 * the real host and every HTTPS request through the proxy fails with
 * ERR_TLS_CERT_ALTNAME_INVALID.
 *
 * @param {SocksProxyAgent} socksAgent - SocksProxyAgent for the tunnel
 * @param {number} [tlsHandshakeTimeoutMs] - TLS handshake timeout in ms
 * @returns {Function} undici connect function (opts, callback)
 */
function buildSocksConnect(socksAgent, tlsHandshakeTimeoutMs = SOCKS_TUNNEL_TIMEOUT_MS) {
  return (opts, callback) => {
    const isTls = opts.protocol === 'https:';
    const host = opts.hostname || opts.host;

    socksAgent
      .connect(_socksFakeReq, {
        host,
        port: resolveSocksPort(opts.protocol, opts.port),
        secureEndpoint: isTls,
        servername: isTls ? opts.servername || host || undefined : undefined,
        localAddress: opts.localAddress,
      })
      .then((socket) => {
        if (!isTls) {
          callback(null, socket);
          return;
        }

        let settled = false;
        const onError = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.removeListener('error', onError);
          callback(err);
          socket.destroy();
        };
        const onSecure = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.removeListener('error', onError);
          callback(null, socket);
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          socket.removeListener('error', onError);
          const err = new Error(`TLS handshake timed out after ${tlsHandshakeTimeoutMs}ms`);
          err.code = 'UND_ERR_CONNECT_TIMEOUT';
          socket.destroy();
          callback(err);
        }, tlsHandshakeTimeoutMs);
        socket.once('secureConnect', onSecure);
        socket.on('error', onError);
      })
      .catch((err) => callback(err));
  };
}

/**
 * Builds an undici dispatcher that tunnels every connection through a SOCKS
 * proxy.
 *
 * socks-proxy-agent handles the SOCKS handshake (including proxy-side DNS
 * resolution for socks5h/socks4a/socks URLs) and upgrades the socket to TLS
 * when the destination uses HTTPS.
 *
 * @param {string} proxyUrl - SOCKS proxy URL (socks5://, socks5h://, ...)
 * @param {object} [options] - Options
 * @param {number} [options.tlsHandshakeTimeoutMs] - TLS handshake timeout in ms
 * @returns {undici.Agent} undici agent using the SOCKS tunnel
 */
function createSocksDispatcher(proxyUrl, { tlsHandshakeTimeoutMs } = {}) {
  const socksAgent = new SocksProxyAgent(proxyUrl, { timeout: SOCKS_TUNNEL_TIMEOUT_MS });
  const agent = new undici.Agent({
    connect: buildSocksConnect(socksAgent, tlsHandshakeTimeoutMs),
  });
  logger.info(`SOCKS proxy configured: ${proxyUrl}`);
  return agent;
}

/**
 * Returns the shared undici dispatcher for the configured proxy.
 *
 * The dispatcher is cached per proxy URL so it is created only once. The
 * optional argument allows tests to exercise different proxy URLs.
 *
 * @param {string} [proxyUrl] - Proxy URL (defaults to VPN_PROXY_URL)
 * @returns {undici.ProxyAgent|undici.Agent|null} Proxy dispatcher or null
 */
function getProxyDispatcher(proxyUrl = VPN_PROXY_URL) {
  if (!proxyUrl) return null;

  if (_proxyDispatcher !== null && _proxyDispatcherUrl === proxyUrl) {
    return _proxyDispatcher;
  }

  let normalizedUrl = proxyUrl;
  if (!normalizedUrl.includes('://')) {
    normalizedUrl = `http://${normalizedUrl}`;
  }

  _proxyDispatcher = buildProxyDispatcher(normalizedUrl);
  _proxyDispatcherUrl = proxyUrl;
  return _proxyDispatcher;
}

class KiroHttpClient {
  /**
   * HTTP client for the Kiro API with retry logic.
   *
   * @param {object} authManager - KiroAuthManager instance
   * @param {object} [options] - Client options
   * @param {Function} [options.sleep] - Sleep function (for testing)
   */
  constructor(authManager, { sleep: sleepFn = sleep } = {}) {
    this.authManager = authManager;
    this._sleep = sleepFn;
  }

  /**
   * Executes a request with retry logic.
   *
   * @param {string} method - HTTP method (GET, POST, etc.)
   * @param {string} url - Request URL
   * @param {object} [options] - Request options
   * @param {object|null} [options.json] - JSON body
   * @param {object|null} [options.params] - Query parameters
   * @param {boolean} [options.stream=false] - Keep the response body open for streaming
   * @param {AbortSignal|null} [options.signal] - Abort signal for client disconnects
   * @returns {Promise<object>} undici Response
   * @throws {ApiError} On failure after all attempts
   */
  async requestWithRetry(method, url, { json = null, params = null, stream = false, signal = null } = {}) {
    const maxRetries = stream ? FIRST_TOKEN_MAX_RETRIES : MAX_RETRIES;
    let lastErrorInfo = null;
    let lastResponse = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const token = await this.authManager.getAccessToken();
        const headers = getKiroHeaders(this.authManager, token);

        const requestOptions = {
          method,
          headers,
          maxRedirections: 5,
          signal: signal || undefined,
          dispatcher: getProxyDispatcher() || undefined,
          bodyTimeout: stream ? undefined : 300_000,
          headersTimeout: stream ? undefined : 300_000,
        };

        if (json !== null && json !== undefined) {
          requestOptions.body = JSON.stringify(json);
        }

        if (params && Object.keys(params).length > 0) {
          const query = new URLSearchParams(params).toString();
          url = `${url}${url.includes('?') ? '&' : '?'}${query}`;
        }

        if (stream) {
          // Prevent CLOSE_WAIT connection leaks
          headers.Connection = 'close';
        }

        logger.debug(`Sending request to Kiro API: ${method} ${url}`);
        const response = await undici.request(url, requestOptions);

        // Check status
        if (response.statusCode === 200) {
          return response;
        }

        // 403 - token expired, refresh and retry
        if (response.statusCode === 403) {
          logger.warning(`Received 403, refreshing token (attempt ${attempt + 1}/${maxRetries})`);
          await this.authManager.forceRefresh();
          await consumeBody(response.body);
          continue;
        }

        // 429 - rate limit, wait and retry
        if (response.statusCode === 429) {
          lastResponse = response;
          const delay = BASE_RETRY_DELAY * 2 ** attempt;
          logger.warning(`Received 429, waiting ${delay}s (attempt ${attempt + 1}/${maxRetries})`);
          await this._sleep(delay);
          continue;
        }

        // 5xx - server error, wait and retry
        if (response.statusCode >= 500 && response.statusCode < 600) {
          lastResponse = response;
          const delay = BASE_RETRY_DELAY * 2 ** attempt;
          logger.warning(`Received ${response.statusCode}, waiting ${delay}s (attempt ${attempt + 1}/${maxRetries})`);
          await this._sleep(delay);
          continue;
        }

        // Other errors - return as-is
        return response;
      } catch (err) {
        // AbortError - client disconnected, propagate immediately
        if (err && (err.name === 'AbortError' || (err.cause && err.cause.code === 'UND_ERR_ABORTED'))) {
          throw err;
        }

        const errorInfo = classifyNetworkError(err);
        lastErrorInfo = errorInfo;

        if (errorInfo.isRetryable && attempt < maxRetries - 1) {
          const delay = BASE_RETRY_DELAY * 2 ** attempt;
          logger.warning(`${errorInfo.userMessage} - waiting ${delay}s (attempt ${attempt + 1}/${maxRetries})`);
          await this._sleep(delay);
        } else {
          logger.error(`${errorInfo.userMessage} - no more retries (attempt ${attempt + 1}/${maxRetries})`);
          if (!errorInfo.isRetryable) {
            break; // Don't retry non-retryable errors
          }
        }
      }
    }

    // If we have a last response (429/5xx retries exhausted), return it
    if (lastResponse) {
      logger.warning(
        `Retries exhausted for HTTP ${lastResponse.statusCode}, returning response to caller for classification`
      );
      return lastResponse;
    }

    // All attempts exhausted - provide a detailed, user-friendly error
    if (lastErrorInfo) {
      let errorMessage = lastErrorInfo.userMessage;
      if (lastErrorInfo.troubleshootingSteps && lastErrorInfo.troubleshootingSteps.length > 0) {
        errorMessage += '\n\nTroubleshooting:\n';
        lastErrorInfo.troubleshootingSteps.forEach((step, i) => {
          errorMessage += `${i + 1}. ${step}\n`;
        });
      }
      errorMessage += `\nTechnical details: ${lastErrorInfo.technicalDetails}`;

      throw new ApiError(502, errorMessage.trim(), lastErrorInfo.suggestedHttpCode);
    }

    throw new ApiError(
      stream ? 504 : 502,
      `Request failed after ${maxRetries} attempts. Unknown error.`
    );
  }
}

/**
 * Consumes and discards a response body (to free the connection).
 *
 * @param {object} body - undici body stream
 */
async function consumeBody(body) {
  try {
    for await (const _chunk of body) {
      // Discard
    }
  } catch {
    // Ignore read errors during cleanup
  }
}

/**
 * Sleep helper.
 *
 * @param {number} seconds - Delay in seconds
 * @returns {Promise<void>}
 */
function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

module.exports = {
  KiroHttpClient,
  getProxyDispatcher,
  buildProxyDispatcher,
  buildSocksConnect,
  createSocksDispatcher,
  resolveSocksPort,
  consumeBody,
};