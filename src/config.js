'use strict';

/**
 * Configuration and constants for Kiro Gateway (Node CLI).
 *
 * Loads environment variables from a `.env` file (if present) and provides
 * typed access to all settings. Mirrors `kiro/config.py` of the Python
 * implementation.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ==================================================================================================
// Minimal .env loader (no external dependency)
// ==================================================================================================

function loadDotEnv(filePath = '.env') {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    // Raw value: strip surrounding quotes without processing escape sequences
    // (preserves Windows paths like D:\Projects\file.json)
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    // Do not override already-set environment variables (process env wins)
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Load .env from the current working directory (mirrors Python load_dotenv())
loadDotEnv();

// ==================================================================================================
// Helpers
// ==================================================================================================

function envStr(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : value;
}

function envInt(name, fallback) {
  const value = parseInt(envStr(name, String(fallback)), 10);
  return Number.isNaN(value) ? fallback : value;
}

function envFloat(name, fallback) {
  const value = parseFloat(envStr(name, String(fallback)));
  return Number.isNaN(value) ? fallback : value;
}

function envBool(name, fallback) {
  const raw = envStr(name, '').toLowerCase();
  if (raw === '') return fallback;
  return ['true', '1', 'yes'].includes(raw);
}

function expandUser(p) {
  if (!p) return '';
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// ==================================================================================================
// Server Settings
// ==================================================================================================

const DEFAULT_SERVER_HOST = '0.0.0.0';
const SERVER_HOST = envStr('SERVER_HOST', DEFAULT_SERVER_HOST);

const DEFAULT_SERVER_PORT = 8000;
const SERVER_PORT = envInt('SERVER_PORT', DEFAULT_SERVER_PORT);

// ==================================================================================================
// Proxy Server Settings
// ==================================================================================================

// Optional: when unset (default), client authentication is disabled and all
// requests pass through without an API key. When set, clients must send it.
const PROXY_API_KEY = envStr('PROXY_API_KEY', '');

// ==================================================================================================
// VPN/Proxy Settings for Kiro API Access
// Supports HTTP/HTTPS and SOCKS proxies (socks5://, socks5h://, socks4a://, ...).
// ==================================================================================================

const VPN_PROXY_URL = envStr('VPN_PROXY_URL', '');

// ==================================================================================================
// Kiro API Credentials
// ==================================================================================================

const REFRESH_TOKEN = envStr('REFRESH_TOKEN', '');
const PROFILE_ARN = envStr('PROFILE_ARN', '');
const REGION = envStr('KIRO_REGION', 'us-east-1');

// Default to the standard Kiro IDE credentials location when KIRO_CREDS_FILE
// is not explicitly configured (auto-discovery for Kiro Desktop users).
const DEFAULT_KIRO_CREDS_FILE = '~/.aws/sso/cache/kiro-auth-token.json';
const KIRO_CREDS_FILE = expandUser(envStr('KIRO_CREDS_FILE', DEFAULT_KIRO_CREDS_FILE));
const KIRO_CLI_DB_FILE = expandUser(envStr('KIRO_CLI_DB_FILE', ''));
const SQLITE_READONLY = envBool('SQLITE_READONLY', false);

// ==================================================================================================
// Kiro API URL Templates
// ==================================================================================================

const KIRO_REFRESH_URL_TEMPLATE = 'https://prod.{region}.auth.desktop.kiro.dev/refreshToken';
const AWS_SSO_OIDC_URL_TEMPLATE = 'https://oidc.{region}.amazonaws.com/token';
const KIRO_API_HOST_TEMPLATE = 'https://runtime.{region}.kiro.dev';
const KIRO_Q_HOST_TEMPLATE = 'https://runtime.{region}.kiro.dev';

// ==================================================================================================
// Token Settings
// ==================================================================================================

const TOKEN_REFRESH_THRESHOLD = 600;

// ==================================================================================================
// Retry Configuration
// ==================================================================================================

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 1.0;

// ==================================================================================================
// Model Configuration
// ==================================================================================================

const HIDDEN_MODELS = {};

const MODEL_ALIASES = { 'auto-kiro': 'auto' };

const HIDDEN_FROM_LIST = ['auto'];

const FALLBACK_MODELS = [
  { modelId: 'auto' },
  { modelId: 'claude-sonnet-4' },
  { modelId: 'claude-sonnet-4.5' },
  { modelId: 'claude-sonnet-4.6' },
  { modelId: 'claude-sonnet-4.7' },
  { modelId: 'claude-sonnet-5' },
  { modelId: 'claude-haiku-4.5' },
  { modelId: 'claude-opus-4.5' },
  { modelId: 'claude-opus-4.6' },
  { modelId: 'claude-opus-4.7' },
  { modelId: 'claude-opus-4.8' },
  { modelId: 'claude-opus-5' },
  { modelId: 'deepseek-3.2' },
  { modelId: 'glm-5' },
  { modelId: 'minimax-m2.1' },
  { modelId: 'minimax-m2.5' },
  { modelId: 'qwen3-coder-next' },
];

const MODEL_CACHE_TTL = 3600;
const DEFAULT_MAX_INPUT_TOKENS = 200000;

// ==================================================================================================
// Tool Description Handling (Kiro API Limitations)
// ==================================================================================================

const TOOL_DESCRIPTION_MAX_LENGTH = envInt('TOOL_DESCRIPTION_MAX_LENGTH', 10000);

// ==================================================================================================
// Fake Reasoning Settings (Extended Thinking via Tag Injection)
// ==================================================================================================

const FAKE_REASONING_ENABLED = envStr('FAKE_REASONING', '') === ''
  ? true
  : !['false', '0', 'no', 'disabled', 'off'].includes(envStr('FAKE_REASONING', '').toLowerCase());

const FAKE_REASONING_MAX_TOKENS = envInt('FAKE_REASONING_MAX_TOKENS', 4000);
const FAKE_REASONING_BUDGET_CAP = envInt('FAKE_REASONING_BUDGET_CAP', 10000);

const _FAKE_REASONING_HANDLING_RAW = envStr('FAKE_REASONING_HANDLING', 'as_reasoning_content').toLowerCase();
const FAKE_REASONING_HANDLING = ['as_reasoning_content', 'remove', 'pass', 'strip_tags'].includes(
  _FAKE_REASONING_HANDLING_RAW
)
  ? _FAKE_REASONING_HANDLING_RAW
  : 'as_reasoning_content';

const FAKE_REASONING_OPEN_TAGS = ['<thinking>', ' thinking', '<reasoning>', '<thought>'];
const FAKE_REASONING_INITIAL_BUFFER_SIZE = envInt('FAKE_REASONING_INITIAL_BUFFER_SIZE', 20);

// ==================================================================================================
// First Token Timeout Settings (Streaming Retry)
// ==================================================================================================

const FIRST_TOKEN_TIMEOUT = envFloat('FIRST_TOKEN_TIMEOUT', 15);
const STREAMING_READ_TIMEOUT = envFloat('STREAMING_READ_TIMEOUT', 300);
const FIRST_TOKEN_MAX_RETRIES = envInt('FIRST_TOKEN_MAX_RETRIES', 3);

// ==================================================================================================
// Account System Settings
// ==================================================================================================

const ACCOUNT_SYSTEM = envBool('ACCOUNT_SYSTEM', false);
const ACCOUNTS_CONFIG_FILE = envStr('ACCOUNTS_CONFIG_FILE', 'credentials.json');

const ACCOUNT_RECOVERY_TIMEOUT = envInt('ACCOUNT_RECOVERY_TIMEOUT', 60);
const ACCOUNT_MAX_BACKOFF_MULTIPLIER = envFloat('ACCOUNT_MAX_BACKOFF_MULTIPLIER', 1440.0);
const ACCOUNT_PROBABILISTIC_RETRY_CHANCE = envFloat('ACCOUNT_PROBABILISTIC_RETRY_CHANCE', 0.1);
const ACCOUNT_CACHE_TTL = envInt('ACCOUNT_CACHE_TTL', 43200);

// ==================================================================================================
// Logging
// ==================================================================================================

const LOG_LEVEL = envStr('LOG_LEVEL', 'INFO').toUpperCase();

// ==================================================================================================
// Application Version
// ==================================================================================================

const APP_VERSION = '1.0.0';
const APP_TITLE = 'Kiro Gateway (Node CLI)';
const APP_DESCRIPTION =
  'Proxy gateway for Kiro API (Amazon Q Developer / AWS CodeWhisperer). OpenAI and Anthropic compatible.';

// ==================================================================================================
// URL Builders
// ==================================================================================================

/** @returns {string} Kiro Desktop Auth token refresh URL for the region. */
function getKiroRefreshUrl(region) {
  return KIRO_REFRESH_URL_TEMPLATE.replace('{region}', region);
}

/** @returns {string} AWS SSO OIDC token URL for the region. */
function getAwsSsoOidcUrl(region) {
  return AWS_SSO_OIDC_URL_TEMPLATE.replace('{region}', region);
}

/** @returns {string} API host for the region. */
function getKiroApiHost(region) {
  return KIRO_API_HOST_TEMPLATE.replace('{region}', region);
}

/** @returns {string} Q API host for the region. */
function getKiroQHost(region) {
  return KIRO_Q_HOST_TEMPLATE.replace('{region}', region);
}

module.exports = {
  SERVER_HOST,
  SERVER_PORT,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  PROXY_API_KEY,
  VPN_PROXY_URL,
  REFRESH_TOKEN,
  PROFILE_ARN,
  REGION,
  KIRO_CREDS_FILE,
  DEFAULT_KIRO_CREDS_FILE,
  KIRO_CLI_DB_FILE,
  SQLITE_READONLY,
  TOKEN_REFRESH_THRESHOLD,
  MAX_RETRIES,
  BASE_RETRY_DELAY,
  HIDDEN_MODELS,
  MODEL_ALIASES,
  HIDDEN_FROM_LIST,
  FALLBACK_MODELS,
  MODEL_CACHE_TTL,
  DEFAULT_MAX_INPUT_TOKENS,
  TOOL_DESCRIPTION_MAX_LENGTH,
  FAKE_REASONING_ENABLED,
  FAKE_REASONING_MAX_TOKENS,
  FAKE_REASONING_BUDGET_CAP,
  FAKE_REASONING_HANDLING,
  FAKE_REASONING_OPEN_TAGS,
  FAKE_REASONING_INITIAL_BUFFER_SIZE,
  FIRST_TOKEN_TIMEOUT,
  STREAMING_READ_TIMEOUT,
  FIRST_TOKEN_MAX_RETRIES,
  ACCOUNT_SYSTEM,
  ACCOUNTS_CONFIG_FILE,
  ACCOUNT_RECOVERY_TIMEOUT,
  ACCOUNT_MAX_BACKOFF_MULTIPLIER,
  ACCOUNT_PROBABILISTIC_RETRY_CHANCE,
  ACCOUNT_CACHE_TTL,
  LOG_LEVEL,
  APP_VERSION,
  APP_TITLE,
  APP_DESCRIPTION,
  getKiroRefreshUrl,
  getAwsSsoOidcUrl,
  getKiroApiHost,
  getKiroQHost,
};