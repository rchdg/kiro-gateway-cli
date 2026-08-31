'use strict';

/**
 * Unified account system for the Kiro Gateway.
 *
 * Manages multiple Kiro accounts with failover, sticky behavior, and a
 * circuit breaker pattern. Mirrors `kiro/account_manager.py` (state
 * persistence and periodic model refresh are intentionally simplified).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { Logger } = require('./logger');
const { KiroAuthManager, AuthType } = require('./auth');
const { ModelInfoCache } = require('./cache');
const { ModelResolver } = require('./modelResolver');
const { KiroHttpClient } = require('./httpClient');
const { ErrorType } = require('./errors');
const {
  HIDDEN_MODELS,
  MODEL_ALIASES,
  HIDDEN_FROM_LIST,
  FALLBACK_MODELS,
  ACCOUNT_RECOVERY_TIMEOUT,
  ACCOUNT_MAX_BACKOFF_MULTIPLIER,
  ACCOUNT_PROBABILISTIC_RETRY_CHANCE,
  ACCOUNT_CACHE_TTL,
} = require('./config');

const logger = new Logger();

/**
 * Checks if the auth manager uses the runtime endpoint (no
 * /ListAvailableModels API available).
 *
 * @param {KiroAuthManager} authManager - Auth manager
 * @returns {boolean} True for runtime.kiro.dev endpoints
 */
function isRuntimeEndpoint(authManager) {
  return authManager.apiHost.includes('://runtime.');
}

/**
 * Formats a duration in human-readable form.
 *
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration ("30s", "5m", "2h", "1d")
 */
function formatDuration(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

class Account {
  /**
   * Complete account entity with all dependencies.
   *
   * @param {string} id - Unique account identifier
   */
  constructor(id) {
    this.id = id;
    this.authManager = null;
    this.modelCache = null;
    this.modelResolver = null;
    this.failures = 0;
    this.lastFailureTime = 0;
    this.modelsCachedAt = 0;
    this.stats = { totalRequests: 0, successfulRequests: 0, failedRequests: 0 };
  }
}

class AccountManager {
  /**
   * Manages multiple Kiro accounts with failover.
   *
   * @param {string} credentialsFile - Path to credentials.json
   */
  constructor(credentialsFile) {
    this._credentialsFile = credentialsFile;
    this._accounts = new Map(); // id → Account
    this._credentialsConfig = [];
    this._currentAccountIndex = 0; // Global sticky index
  }

  /**
   * Loads credentials from credentials.json.
   *
   * Validates each entry and creates Account objects. Invalid entries are
   * skipped with warnings. Folders are scanned for credential files.
   */
  async loadCredentials() {
    if (!fs.existsSync(this._credentialsFile)) {
      logger.warning(`Credentials file not found: ${this._credentialsFile}`);
      return;
    }

    try {
      this._credentialsConfig = JSON.parse(fs.readFileSync(this._credentialsFile, 'utf8'));
    } catch (err) {
      logger.error(`Failed to load credentials: ${err.message}`);
      return;
    }

    if (!Array.isArray(this._credentialsConfig)) {
      logger.error(`Credentials file must contain an array: ${this._credentialsFile}`);
      this._credentialsConfig = [];
      return;
    }

    for (const entry of this._credentialsConfig) {
      const credType = entry.type;
      const credPath = entry.path;
      const enabled = entry.enabled !== false;

      if (!enabled) continue;

      if (!credType) {
        logger.warning(`Invalid credential entry (missing type): ${JSON.stringify(entry)}`);
        continue;
      }

      // Validate required fields based on type
      if (['json', 'sqlite'].includes(credType) && !credPath) {
        logger.warning(`Invalid credential entry (type=${credType} requires path): ${JSON.stringify(entry)}`);
        continue;
      }

      if (credType === 'refresh_token' && !entry.refresh_token) {
        logger.warning(
          `Invalid credential entry (type=refresh_token requires refresh_token field): ${JSON.stringify(entry)}`
        );
        continue;
      }

      // refresh_token type - no path processing needed
      if (credType === 'refresh_token') {
        const token = entry.refresh_token || '';
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
        const accountId = `refresh_token_${tokenHash}`;
        if (!this._accounts.has(accountId)) {
          this._accounts.set(accountId, new Account(accountId));
        }
        continue;
      }

      // Handle folder scanning for json/sqlite types
      const expandedPath = expandUser(credPath);
      if (fs.existsSync(expandedPath) && fs.statSync(expandedPath).isDirectory()) {
        logger.info(`Scanning folder for credentials: ${credPath}`);
        for (const fileName of fs.readdirSync(expandedPath)) {
          const filePath = path.join(expandedPath, fileName);
          if (!fs.statSync(filePath).isFile()) continue;

          if (credType === 'json') {
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
              if (data.refreshToken || data.clientId) {
                this._addAccount(filePath);
              }
            } catch {
              logger.warning(`Invalid JSON credentials file ${fileName}`);
            }
          } else if (credType === 'sqlite') {
            try {
              const { DatabaseSync } = require('node:sqlite');
              const db = new DatabaseSync(filePath, { readOnly: true });
              const table = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_kv'")
                .get();
              db.close();
              if (table) {
                this._addAccount(filePath);
              }
            } catch {
              logger.warning(`Invalid SQLite database file ${fileName}`);
            }
          }
        }
      } else if (fs.existsSync(expandedPath) && fs.statSync(expandedPath).isFile()) {
        this._addAccount(expandedPath);
      } else {
        logger.warning(`Credential path not found: ${credPath}`);
      }
    }

    logger.info(`Loaded ${this._accounts.size} account(s) from credentials`);
  }

  /**
   * Adds an account if it does not exist yet.
   *
   * @param {string} accountId - Account ID (path or token hash)
   */
  _addAccount(accountId) {
    const resolved = path.resolve(accountId);
    if (!this._accounts.has(resolved)) {
      this._accounts.set(resolved, new Account(resolved));
      logger.debug(`Added account: ${resolved}`);
    }
  }

  /**
   * Initializes an account (lazy initialization).
   *
   * Creates the auth manager, verifies the token, and loads model data.
   *
   * @param {string} accountId - Account ID to initialize
   * @returns {Promise<boolean>} True if successful
   */
  async _initializeAccount(accountId) {
    const account = this._accounts.get(accountId);
    if (!account) return false;

    try {
      const credsConfig = this._findCredsConfig(accountId);
      if (!credsConfig) {
        logger.error(`No credentials config found for account: ${accountId}`);
        return false;
      }

      const credType = credsConfig.type;

      let authManager;
      if (credType === 'json') {
        authManager = new KiroAuthManager({
          credsFile: accountId,
          profileArn: credsConfig.profile_arn,
          region: credsConfig.region || 'us-east-1',
          apiRegion: credsConfig.api_region,
        });
      } else if (credType === 'sqlite') {
        authManager = new KiroAuthManager({
          sqliteDb: accountId,
          profileArn: credsConfig.profile_arn,
          region: credsConfig.region || 'us-east-1',
          apiRegion: credsConfig.api_region,
        });
      } else if (credType === 'refresh_token') {
        authManager = new KiroAuthManager({
          refreshToken: credsConfig.refresh_token,
          profileArn: credsConfig.profile_arn,
          region: credsConfig.region || 'us-east-1',
          apiRegion: credsConfig.api_region,
        });
      } else {
        logger.error(`Unknown credential type: ${credType}`);
        return false;
      }

      // Get the token to verify credentials
      await authManager.getAccessToken();

      // Determine the model list: static for runtime endpoints,
      // dynamic for the old endpoint
      let modelsList;
      if (isRuntimeEndpoint(authManager)) {
        logger.debug(`Account ${accountId}: Using static model list for runtime.kiro.dev endpoint`);
        modelsList = FALLBACK_MODELS;
      } else {
        modelsList = await this._fetchModelsFromApi(authManager);
      }

      // Create the model cache and resolver
      const modelCache = new ModelInfoCache();
      modelCache.update(modelsList);

      for (const [displayName, internalId] of Object.entries(HIDDEN_MODELS)) {
        modelCache.addHiddenModel(displayName, internalId);
      }

      const modelResolver = new ModelResolver(
        modelCache,
        HIDDEN_MODELS,
        MODEL_ALIASES,
        HIDDEN_FROM_LIST
      );

      account.authManager = authManager;
      account.modelCache = modelCache;
      account.modelResolver = modelResolver;
      account.modelsCachedAt = Date.now() / 1000;

      logger.info(`Initialized account: ${accountId}`);
      return true;
    } catch (err) {
      logger.error(`Failed to initialize account ${accountId}: ${err.message}`);
      return false;
    }
  }

  /**
   * Finds the credentials config entry for an account.
   *
   * @param {string} accountId - Account ID
   * @returns {object|null} Credentials config entry or null
   */
  _findCredsConfig(accountId) {
    for (const entry of this._credentialsConfig) {
      const credPath = entry.path || '';
      const expandedPath = expandUser(credPath);

      if (entry.type === 'refresh_token') {
        const token = entry.refresh_token || '';
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
        if (accountId === `refresh_token_${tokenHash}`) {
          return entry;
        }
      } else if (path.resolve(expandedPath) === accountId) {
        return entry;
      }
    }
    return null;
  }

  /**
   * Fetches the model list from the old Q endpoint (with fallback).
   *
   * @param {KiroAuthManager} authManager - Auth manager
   * @returns {Promise<Array<object>>} Model list
   */
  async _fetchModelsFromApi(authManager) {
    const httpClient = new KiroHttpClient(authManager);

    try {
      const params = { origin: 'AI_EDITOR' };
      if (authManager.authType === AuthType.KIRO_DESKTOP && authManager.profileArn) {
        params.profileArn = authManager.profileArn;
      }

      const listModelsUrl = `${authManager.qHost}/ListAvailableModels`;

      const response = await httpClient.requestWithRetry('GET', listModelsUrl, { params });

      if (response.statusCode === 200) {
        const data = await response.body.json();
        const models = data.models || [];
        if (Array.isArray(models) && models.length > 0) {
          return models;
        }
        throw new Error('Empty model list from API');
      }
      throw new Error(`HTTP ${response.statusCode}`);
    } catch (err) {
      logger.error(`Failed to fetch models after retries: ${err.message}`);
      logger.warning('Using pre-configured fallback models.');
      return FALLBACK_MODELS;
    }
  }

  /**
   * Refreshes the model cache for an account (TTL refresh).
   *
   * @param {string} accountId - Account ID
   */
  async _refreshAccountModels(accountId) {
    const account = this._accounts.get(accountId);
    if (!account || !account.authManager) return;

    if (isRuntimeEndpoint(account.authManager)) {
      // Runtime endpoint - use the static list
      account.modelCache.update(FALLBACK_MODELS);
      account.modelsCachedAt = Date.now() / 1000;
      return;
    }

    const httpClient = new KiroHttpClient(account.authManager);
    try {
      const params = { origin: 'AI_EDITOR' };
      if (account.authManager.authType === AuthType.KIRO_DESKTOP && account.authManager.profileArn) {
        params.profileArn = account.authManager.profileArn;
      }

      const response = await httpClient.requestWithRetry('GET', `${account.authManager.qHost}/ListAvailableModels`, {
        params,
      });

      if (response.statusCode === 200) {
        const data = await response.body.json();
        const modelsList = data.models || [];
        if (Array.isArray(modelsList) && modelsList.length > 0) {
          account.modelCache.update(modelsList);
          account.modelsCachedAt = Date.now() / 1000;
          logger.debug(`Refreshed models for ${accountId}`);
        }
      }
    } catch (err) {
      logger.warning(`Failed to refresh models for ${accountId} after retries: ${err.message}`);
    }
  }

  /**
   * Gets the next available account for a model (Circuit Breaker + Sticky).
   *
   * @param {string} model - Model name (will be normalized)
   * @param {Set<string>} [excludeAccounts] - Accounts already tried in this failover loop
   * @returns {Promise<Account|null>} Account or null if none available
   */
  async getNextAccount(model, excludeAccounts = new Set()) {
    // Special case: single account - bypass the Circuit Breaker
    if (this._accounts.size === 1) {
      const account = this._accounts.values().next().value;

      if (excludeAccounts.has(account.id)) return null;

      if (!account.authManager) {
        const success = await this._initializeAccount(account.id);
        if (!success) return null;
      }

      // Check TTL and refresh if needed
      if (account.modelsCachedAt > 0) {
        const age = Date.now() / 1000 - account.modelsCachedAt;
        if (age > ACCOUNT_CACHE_TTL) {
          try {
            await this._refreshAccountModels(account.id);
          } catch (err) {
            logger.warning(`Failed to refresh models for ${account.id}: ${err.message}`);
          }
        }
      }

      // Always return the single account (no model validation - Kiro decides)
      return account;
    }

    // Multi-account logic: global sticky
    const allAccountIds = Array.from(this._accounts.keys());
    const startIndex = this._currentAccountIndex;

    for (let i = 0; i < allAccountIds.length; i++) {
      const currentIndex = (startIndex + i) % allAccountIds.length;
      const accountId = allAccountIds[currentIndex];
      const account = this._accounts.get(accountId);

      // Skip accounts already tried in this failover loop
      if (excludeAccounts.has(accountId)) continue;

      // Check the Circuit Breaker (Half-Open state with exponential backoff)
      if (account.failures > 0) {
        const timeSinceFailure = Date.now() / 1000 - account.lastFailureTime;

        const backoffMultiplier = Math.min(
          2 ** (account.failures - 1),
          ACCOUNT_MAX_BACKOFF_MULTIPLIER
        );
        const effectiveTimeout = ACCOUNT_RECOVERY_TIMEOUT * backoffMultiplier;

        if (timeSinceFailure < effectiveTimeout) {
          // Probabilistic retry (10% chance)
          if (Math.random() > ACCOUNT_PROBABILISTIC_RETRY_CHANCE) {
            continue;
          }
          logger.info(`Probabilistic retry for broken account ${accountId}`);
        } else {
          logger.info(
            `Half-Open state for ${accountId} (recovery timeout passed, effective=${formatDuration(effectiveTimeout)})`
          );
        }
      }

      // Lazy initialization
      if (!account.authManager) {
        const success = await this._initializeAccount(accountId);
        if (!success) {
          account.failures += 1;
          continue;
        }
      }

      // Check TTL and refresh if needed
      if (account.modelsCachedAt > 0) {
        const age = Date.now() / 1000 - account.modelsCachedAt;
        if (age > ACCOUNT_CACHE_TTL) {
          try {
            await this._refreshAccountModels(accountId);
          } catch (err) {
            logger.warning(`Failed to refresh models for ${accountId}: ${err.message}`);
          }
        }
      }

      // No model validation - let the Kiro API decide (gateway, not gatekeeper)
      return account;
    }

    return null;
  }

  /**
   * Reports a successful request (resets failures, updates stats and sticky index).
   *
   * @param {string} accountId - Account ID
   * @param {string} model - Model name
   */
  reportSuccess(accountId, model) {
    const account = this._accounts.get(accountId);
    if (!account) return;

    if (account.failures > 0) {
      account.failures = 0;
    }

    account.stats.totalRequests += 1;
    account.stats.successfulRequests += 1;

    // Global sticky: move the current index to the successful account
    const allAccountIds = Array.from(this._accounts.keys());
    const successfulIndex = allAccountIds.indexOf(accountId);
    if (successfulIndex !== -1) {
      this._currentAccountIndex = successfulIndex;
    }
  }

  /**
   * Reports a failed request (updates failures and stats).
   *
   * @param {string} accountId - Account ID
   * @param {string} model - Model name
   * @param {string} errorType - ErrorType.FATAL or ErrorType.RECOVERABLE
   * @param {number} statusCode - HTTP status code
   * @param {string|null} reason - Error reason from the Kiro API
   */
  reportFailure(accountId, model, errorType, statusCode, reason) {
    const account = this._accounts.get(accountId);
    if (!account) return;

    // Special case: INVALID_MODEL_ID is a discovery process, not an account failure
    if (reason === 'INVALID_MODEL_ID') {
      account.stats.totalRequests += 1;
      logger.warning(
        `Model '${model}' not available on account ${accountId}: status=${statusCode}, reason=${reason}`
      );
      return;
    }

    // Update the failure count (only for RECOVERABLE)
    if (errorType === ErrorType.RECOVERABLE) {
      account.failures += 1;
      account.lastFailureTime = Date.now() / 1000;

      const backoffMultiplier = Math.min(
        2 ** (account.failures - 1),
        ACCOUNT_MAX_BACKOFF_MULTIPLIER
      );
      const effectiveTimeout = ACCOUNT_RECOVERY_TIMEOUT * backoffMultiplier;
      logger.warning(
        `Account ${accountId} failure #${account.failures}: status=${statusCode}, reason=${reason}, ` +
          `cooldown=${formatDuration(effectiveTimeout)}`
      );
    }

    account.stats.totalRequests += 1;
    account.stats.failedRequests += 1;

    // The sticky index only changes on success (global sticky behavior)
  }

  /**
   * Gets the first initialized account (for legacy mode).
   *
   * @returns {Account} First initialized account
   * @throws {Error} If no initialized accounts exist
   */
  getFirstAccount() {
    for (const account of this._accounts.values()) {
      if (account.authManager) {
        return account;
      }
    }
    throw new Error('No initialized accounts available');
  }

  /**
   * Collects unique models from all initialized accounts.
   *
   * @returns {string[]} Sorted unique model IDs
   */
  getAllAvailableModels() {
    const allModels = new Set();
    for (const account of this._accounts.values()) {
      if (account.modelResolver) {
        for (const model of account.modelResolver.getAvailableModels()) {
          allModels.add(model);
        }
      }
    }
    return Array.from(allModels).sort();
  }

  /** @returns {number} Number of configured accounts */
  get accountCount() {
    return this._accounts.size;
  }

  /** @returns {string[]} All account IDs */
  get accountIds() {
    return Array.from(this._accounts.keys());
  }
}

/**
 * Expands "~" in a path.
 *
 * @param {string} p - Path
 * @returns {string} Expanded path
 */
function expandUser(p) {
  if (!p) return '';
  if (p.startsWith('~')) {
    const os = require('node:os');
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

module.exports = { Account, AccountManager, isRuntimeEndpoint };