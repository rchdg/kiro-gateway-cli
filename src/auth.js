'use strict';

/**
 * Authentication manager for the Kiro API.
 *
 * Manages the lifecycle of access tokens:
 * - Loading credentials from environment, JSON file, or SQLite database
 * - Automatic token refresh on expiration
 * - Thread-safe refresh (single-threaded JS: a simple in-flight promise lock)
 * - Support for both Kiro Desktop Auth and AWS SSO OIDC (kiro-cli)
 *
 * Mirrors `kiro/auth.py`.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const undici = require('undici');

const { Logger } = require('./logger');
const { getMachineFingerprint } = require('./utils');
const {
  TOKEN_REFRESH_THRESHOLD,
  SQLITE_READONLY,
  getKiroRefreshUrl,
  getKiroApiHost,
  getKiroQHost,
  getAwsSsoOidcUrl,
} = require('./config');

const logger = new Logger();

// Supported SQLite token keys (searched in priority order)
const SQLITE_TOKEN_KEYS = [
  'kirocli:social:token', // Social login (Google, GitHub, Microsoft, etc.)
  'kirocli:odic:token', // AWS SSO OIDC (kiro-cli corporate)
  'codewhisperer:odic:token', // Legacy AWS SSO OIDC
];

// Device registration keys (for AWS SSO OIDC only)
const SQLITE_REGISTRATION_KEYS = [
  'kirocli:odic:device-registration',
  'codewhisperer:odic:device-registration',
];

const AuthType = Object.freeze({
  KIRO_DESKTOP: 'kiro_desktop',
  AWS_SSO_OIDC: 'aws_sso_oidc',
});

/**
 * Opens a SQLite database using node:sqlite when available.
 *
 * @param {string} dbPath - Path to the SQLite database
 * @param {boolean} [readOnly=false] - Open in read-only mode
 * @returns {object|null} DatabaseSync instance or null if unavailable
 */
function openSqlite(dbPath, readOnly = false) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(dbPath, { readOnly });
  } catch (err) {
    logger.warning(`node:sqlite unavailable, cannot use SQLite credentials: ${err.message}`);
    return null;
  }
}

class KiroAuthManager {
  /**
   * Initializes the authentication manager.
   *
   * @param {object} [options] - Auth options
   * @param {string|null} [options.refreshToken] - Refresh token
   * @param {string|null} [options.profileArn] - AWS CodeWhisperer profile ARN
   * @param {string} [options.region='us-east-1'] - AWS region
   * @param {string|null} [options.credsFile] - Path to JSON credentials file
   * @param {string|null} [options.clientId] - OAuth client ID (AWS SSO OIDC)
   * @param {string|null} [options.clientSecret] - OAuth client secret (AWS SSO OIDC)
   * @param {string|null} [options.sqliteDb] - Path to kiro-cli SQLite database
   * @param {string|null} [options.apiRegion] - Q API region override
   */
  constructor({
    refreshToken = null,
    profileArn = null,
    region = 'us-east-1',
    credsFile = null,
    clientId = null,
    clientSecret = null,
    sqliteDb = null,
    apiRegion = null,
  } = {}) {
    this._refreshToken = refreshToken;
    this._profileArn = profileArn;
    this._region = region;
    this._credsFile = credsFile ? expandUserPath(credsFile) : null;
    this._sqliteDb = sqliteDb ? expandUserPath(sqliteDb) : null;

    // AWS SSO OIDC specific fields
    this._clientId = clientId;
    this._clientSecret = clientSecret;
    this._scopes = null;
    this._ssoRegion = null;

    // Enterprise Kiro IDE specific fields
    this._clientIdHash = null;

    // Auto-detected API region from credentials
    this._detectedApiRegion = null;

    // Track which SQLite key we loaded credentials from (for saving back)
    this._sqliteTokenKey = null;

    this._accessToken = null;
    this._expiresAt = null; // epoch seconds
    this._refreshPromise = null; // in-flight refresh guard

    // Auth type determined after loading credentials
    this._authType = AuthType.KIRO_DESKTOP;

    // Fingerprint for User-Agent
    this._fingerprint = getMachineFingerprint();

    // Load credentials (SQLite takes priority over JSON file)
    if (this._sqliteDb) {
      this._loadCredentialsFromSqlite(this._sqliteDb);
    } else if (this._credsFile) {
      this._loadCredentialsFromFile(this._credsFile);
    }

    this._detectAuthType();

    // Fallback: discover the profile ARN from the Kiro IDE profile file
    // when no credential source (credentials.json, token file, SQLite state
    // table) provided one. This keeps the gateway working when credentials.json
    // is not shipped (e.g. published releases where the file is gitignored).
    if (!this._profileArn) {
      const discoveredArn = discoverKiroIdeProfileArn();
      if (discoveredArn) {
        this._profileArn = discoveredArn;
        logger.info(`Profile ARN discovered from Kiro IDE: ${discoveredArn}`);
      }
    }

    // Determine the final API region with priority:
    // 1. Explicit apiRegion parameter - HIGHEST
    // 2. KIRO_API_REGION env var (global override)
    // 3. Auto-detected from credentials
    // 4. SSO region (fallback)
    // 5. Default region
    const apiRegionOverride = process.env.KIRO_API_REGION;

    let finalApiRegion;
    if (apiRegion) {
      finalApiRegion = apiRegion;
    } else if (apiRegionOverride) {
      finalApiRegion = apiRegionOverride;
    } else if (this._detectedApiRegion) {
      finalApiRegion = this._detectedApiRegion;
    } else if (this._ssoRegion) {
      finalApiRegion = this._ssoRegion;
    } else {
      finalApiRegion = region;
    }

    const ssoRegionForOidc = this._ssoRegion || region;
    this._refreshUrl = getKiroRefreshUrl(ssoRegionForOidc);
    this._apiHost = getKiroApiHost(finalApiRegion);
    this._qHost = getKiroQHost(finalApiRegion);

    logger.info(
      `Auth manager initialized: sso_region=${ssoRegionForOidc}, api_region=${finalApiRegion}, ` +
        `api_host=${this._apiHost}, q_host=${this._qHost}`
    );
  }

  /**
   * Detects the auth type based on available credentials.
   */
  _detectAuthType() {
    if (this._clientId && this._clientSecret) {
      this._authType = AuthType.AWS_SSO_OIDC;
      logger.info('Detected auth type: AWS SSO OIDC (kiro-cli)');
    } else {
      this._authType = AuthType.KIRO_DESKTOP;
      logger.info('Detected auth type: Kiro Desktop');
    }
  }

  /**
   * Loads credentials from a kiro-cli SQLite database.
   *
   * @param {string} dbPath - Path to the SQLite database
   */
  _loadCredentialsFromSqlite(dbPath) {
    let db;
    try {
      db = openSqlite(dbPath, true);
      if (!db) return;

      // Try all possible token keys in priority order
      for (const key of SQLITE_TOKEN_KEYS) {
        const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key);
        if (row) {
          this._sqliteTokenKey = key;
          try {
            const tokenData = JSON.parse(row.value);
            this._applyTokenData(tokenData);
          } catch {
            logger.warning(`Failed to parse SQLite token JSON for key: ${key}`);
          }
          break;
        }
      }

      // Load device registration (client_id, client_secret)
      for (const key of SQLITE_REGISTRATION_KEYS) {
        const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key);
        if (row) {
          try {
            const regData = JSON.parse(row.value);
            if (regData.client_id) this._clientId = regData.client_id;
            if (regData.client_secret) this._clientSecret = regData.client_secret;
            if (regData.region && !this._ssoRegion) {
              this._ssoRegion = regData.region;
            }
          } catch {
            // Ignore malformed registration data
          }
          break;
        }
      }

      // Auto-detect API region from the profile ARN in the state table
      try {
        const profileRow = db.prepare("SELECT value FROM state WHERE key = 'api.codewhisperer.profile'").get();
        if (profileRow) {
          const profileData = JSON.parse(profileRow.value);
          const arn = profileData.arn || '';
          if (arn) {
            if (!this._profileArn) {
              this._profileArn = arn;
            }
            // ARN format: arn:aws:codewhisperer:REGION:account:profile/id
            const parts = arn.split(':');
            if (parts.length >= 4 && parts[3] && /^[a-z]+-[a-z]+-\d+$/.test(parts[3])) {
              this._detectedApiRegion = parts[3];
              logger.info(`API region auto-detected from profile ARN: ${parts[3]}`);
            }
          }
        }
      } catch {
        // No state table - not critical
      }

      logger.info(`Credentials loaded from SQLite database: ${dbPath}`);
    } catch (err) {
      logger.error(`Error loading credentials from SQLite: ${err.message}`);
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // Already closed
        }
      }
    }
  }

  /**
   * Applies parsed token data (shared between SQLite and file loading).
   *
   * @param {object} tokenData - Token data object
   */
  _applyTokenData(tokenData) {
    if (tokenData.access_token) this._accessToken = tokenData.access_token;
    if (tokenData.refresh_token) this._refreshToken = tokenData.refresh_token;
    if (tokenData.profile_arn) this._profileArn = tokenData.profile_arn;
    if (tokenData.region) {
      this._ssoRegion = tokenData.region;
    }
    if (tokenData.scopes) this._scopes = tokenData.scopes;

    if (tokenData.expires_at) {
      const parsed = parseExpiresAt(tokenData.expires_at);
      if (parsed !== null) this._expiresAt = parsed;
    }
  }

  /**
   * Loads credentials from a JSON file.
   *
   * @param {string} filePath - Path to the JSON credentials file
   */
  _loadCredentialsFromFile(filePath) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      if (data.refreshToken) this._refreshToken = data.refreshToken;
      if (data.accessToken) this._accessToken = data.accessToken;
      if (data.profileArn) this._profileArn = data.profileArn;
      if (data.region) {
        this._ssoRegion = data.region;
        this._detectedApiRegion = data.region;
      }

      // Enterprise Kiro IDE: clientIdHash → device registration file
      if (data.clientIdHash) {
        this._clientIdHash = data.clientIdHash;
        this._loadEnterpriseDeviceRegistration(data.clientIdHash);
      }

      if (data.clientId) this._clientId = data.clientId;
      if (data.clientSecret) this._clientSecret = data.clientSecret;

      if (data.expiresAt) {
        const parsed = parseExpiresAt(data.expiresAt);
        if (parsed !== null) this._expiresAt = parsed;
      }

      logger.info(`Credentials loaded from ${filePath}`);
    } catch (err) {
      logger.error(`Error loading credentials from file: ${err.message}`);
    }
  }

  /**
   * Loads clientId/clientSecret from the Enterprise Kiro IDE device
   * registration file (~/.aws/sso/cache/{clientIdHash}.json).
   *
   * @param {string} clientIdHash - Client ID hash
   */
  _loadEnterpriseDeviceRegistration(clientIdHash) {
    try {
      const deviceRegPath = path.join(os.homedir(), '.aws', 'sso', 'cache', `${clientIdHash}.json`);
      if (!fs.existsSync(deviceRegPath)) {
        logger.warning(`Enterprise device registration file not found: ${deviceRegPath}`);
        return;
      }

      const deviceData = JSON.parse(fs.readFileSync(deviceRegPath, 'utf8'));
      if (deviceData.clientId) this._clientId = deviceData.clientId;
      if (deviceData.clientSecret) this._clientSecret = deviceData.clientSecret;
      logger.info(`Enterprise device registration loaded from ${deviceRegPath}`);
    } catch (err) {
      logger.error(`Error loading enterprise device registration: ${err.message}`);
    }
  }

  /**
   * Saves updated credentials to a JSON file (preserving other fields).
   */
  _saveCredentialsToFile() {
    if (!this._credsFile) return;

    try {
      let existingData = {};
      if (fs.existsSync(this._credsFile)) {
        existingData = JSON.parse(fs.readFileSync(this._credsFile, 'utf8'));
      }

      existingData.accessToken = this._accessToken;
      existingData.refreshToken = this._refreshToken;
      if (this._expiresAt) {
        existingData.expiresAt = new Date(this._expiresAt * 1000).toISOString();
      }
      if (this._profileArn) {
        existingData.profileArn = this._profileArn;
      }

      fs.writeFileSync(this._credsFile, JSON.stringify(existingData, null, 2));
      logger.debug(`Credentials saved to ${this._credsFile}`);
    } catch (err) {
      logger.error(`Error saving credentials: ${err.message}`);
    }
  }

  /**
   * Saves updated credentials back to the SQLite database (read-merge-write).
   */
  _saveCredentialsToSqlite() {
    if (!this._sqliteDb) return;

    if (SQLITE_READONLY) {
      logger.debug('SQLite write-back disabled (SQLITE_READONLY=true)');
      return;
    }

    let db;
    try {
      if (!fs.existsSync(this._sqliteDb)) {
        logger.warning(`SQLite database not found for writing: ${this._sqliteDb}`);
        return;
      }

      db = openSqlite(this._sqliteDb, false);
      if (!db) return;

      const keys = this._sqliteTokenKey
        ? [this._sqliteTokenKey].concat(SQLITE_TOKEN_KEYS)
        : SQLITE_TOKEN_KEYS;

      for (const key of keys) {
        if (this._trySaveToKey(db, key)) {
          logger.debug(`Credentials saved to SQLite key: ${key} (merged)`);
          return;
        }
      }

      logger.warning('Failed to save credentials to SQLite: no matching keys found');
    } catch (err) {
      logger.error(`Error saving credentials to SQLite: ${err.message}`);
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // Already closed
        }
      }
    }
  }

  /**
   * Attempts to save credentials to a specific SQLite key (read-merge-write).
   *
   * @param {object} db - DatabaseSync instance
   * @param {string} key - SQLite key
   * @returns {boolean} True if the save succeeded
   */
  _trySaveToKey(db, key) {
    try {
      const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key);
      if (!row) return false;

      const existingData = JSON.parse(row.value);

      // Merge: update ONLY our fields, preserve everything else
      existingData.access_token = this._accessToken;
      existingData.refresh_token = this._refreshToken;
      existingData.expires_at = this._expiresAt
        ? new Date(this._expiresAt * 1000).toISOString()
        : null;
      existingData.region = this._ssoRegion || this._region;

      if (this._scopes) {
        existingData.scopes = this._scopes;
      }

      const result = db
        .prepare('UPDATE auth_kv SET value = ? WHERE key = ?')
        .run(JSON.stringify(existingData), key);

      return result.changes > 0;
    } catch (err) {
      logger.debug(`Failed to save to key ${key}: ${err.message}`);
      return false;
    }
  }

  /**
   * @returns {boolean} True if the token is expiring soon (or expiry unknown)
   */
  isTokenExpiringSoon() {
    if (this._expiresAt === null) return true;
    const threshold = Date.now() / 1000 + TOKEN_REFRESH_THRESHOLD;
    return this._expiresAt <= threshold;
  }

  /**
   * @returns {boolean} True if the token has actually expired (or expiry unknown)
   */
  isTokenExpired() {
    if (this._expiresAt === null) return true;
    return Date.now() / 1000 >= this._expiresAt;
  }

  /**
   * Performs a token refresh request routed by auth type.
   *
   * @throws {Error} On refresh failure
   */
  async _refreshTokenRequest() {
    if (this._authType === AuthType.AWS_SSO_OIDC) {
      await this._refreshTokenAwsSsoOidc();
    } else {
      await this._refreshTokenKiroDesktop();
    }
  }

  /**
   * Refreshes the token using the Kiro Desktop Auth endpoint.
   *
   * @throws {Error} If the refresh token is missing or the response is invalid
   */
  async _refreshTokenKiroDesktop() {
    if (!this._refreshToken) {
      throw new Error('Refresh token is not set');
    }

    logger.info('Refreshing Kiro token via Kiro Desktop Auth...');

    const payload = JSON.stringify({ refreshToken: this._refreshToken });
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': `KiroIDE-0.7.45-${this._fingerprint}`,
    };

    const response = await undici.request(this._refreshUrl, {
      method: 'POST',
      headers,
      body: payload,
      bodyTimeout: 30_000,
      headersTimeout: 30_000,
    });

    if (response.statusCode !== 200) {
      const text = await readBodyText(response.body);
      throw new Error(`Kiro Desktop Auth refresh failed: ${response.statusCode} ${text.slice(0, 300)}`);
    }

    const data = await response.body.json();
    const newAccessToken = data.accessToken;
    const newRefreshToken = data.refreshToken;
    const expiresIn = data.expiresIn || 3600;
    const newProfileArn = data.profileArn;

    if (!newAccessToken) {
      throw new Error(`Response does not contain accessToken: ${JSON.stringify(data)}`);
    }

    this._accessToken = newAccessToken;
    if (newRefreshToken) this._refreshToken = newRefreshToken;
    if (newProfileArn) this._profileArn = newProfileArn;

    // Expiration with a 60 second buffer
    this._expiresAt = Date.now() / 1000 + expiresIn - 60;

    logger.info(`Token refreshed via Kiro Desktop Auth, expires in ${expiresIn}s`);

    if (this._sqliteDb) {
      this._saveCredentialsToSqlite();
    } else {
      this._saveCredentialsToFile();
    }
  }

  /**
   * Refreshes the token using the AWS SSO OIDC endpoint.
   *
   * Strategy: try with the current in-memory token first. On 400
   * (token invalidated by kiro-cli re-login), reload credentials from
   * SQLite and retry once.
   *
   * @throws {Error} If required credentials are missing
   */
  async _refreshTokenAwsSsoOidc() {
    try {
      await this._doAwsSsoOidcRefresh();
    } catch (err) {
      const status = err && err.statusCode;
      if (status === 400 && this._sqliteDb) {
        logger.warning('Token refresh failed with 400, reloading credentials from SQLite and retrying...');
        this._loadCredentialsFromSqlite(this._sqliteDb);
        await this._doAwsSsoOidcRefresh();
      } else {
        throw err;
      }
    }
  }

  /**
   * Performs the actual AWS SSO OIDC token refresh.
   *
   * Uses the AWS SSO OIDC CreateToken API format (JSON, camelCase).
   *
   * @throws {Error} On refresh failure
   */
  async _doAwsSsoOidcRefresh() {
    if (!this._refreshToken) throw new Error('Refresh token is not set');
    if (!this._clientId) throw new Error('Client ID is not set (required for AWS SSO OIDC)');
    if (!this._clientSecret) throw new Error('Client secret is not set (required for AWS SSO OIDC)');

    logger.info('Refreshing Kiro token via AWS SSO OIDC...');

    const ssoRegion = this._ssoRegion || this._region;
    const url = getAwsSsoOidcUrl(ssoRegion);

    const payload = JSON.stringify({
      grantType: 'refresh_token',
      clientId: this._clientId,
      clientSecret: this._clientSecret,
      refreshToken: this._refreshToken,
    });

    const response = await undici.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      bodyTimeout: 30_000,
      headersTimeout: 30_000,
    });

    if (response.statusCode !== 200) {
      const text = await readBodyText(response.body);
      const err = new Error(
        `AWS SSO OIDC refresh failed: ${response.statusCode} ${text.slice(0, 300)}`
      );
      err.statusCode = response.statusCode;
      throw err;
    }

    const result = await response.body.json();
    const newAccessToken = result.accessToken;
    const newRefreshToken = result.refreshToken;
    const expiresIn = result.expiresIn || 3600;

    if (!newAccessToken) {
      throw new Error(`AWS SSO OIDC response does not contain accessToken: ${JSON.stringify(result)}`);
    }

    this._accessToken = newAccessToken;
    if (newRefreshToken) this._refreshToken = newRefreshToken;

    this._expiresAt = Date.now() / 1000 + expiresIn - 60;

    logger.info(`Token refreshed via AWS SSO OIDC, expires in ${expiresIn}s`);

    if (this._sqliteDb) {
      this._saveCredentialsToSqlite();
    } else {
      this._saveCredentialsToFile();
    }
  }

  /**
   * Returns a valid access token, refreshing it if necessary.
   *
   * For SQLite mode implements graceful degradation: if the refresh fails
   * with 400, falls back to the existing access token until it expires.
   *
   * @returns {Promise<string>} A valid access token
   * @throws {Error} If unable to obtain a token
   */
  async getAccessToken() {
    // Token is valid and not expiring soon - just return it
    if (this._accessToken && !this.isTokenExpiringSoon()) {
      return this._accessToken;
    }

    // Reuse an in-flight refresh instead of duplicating it
    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    // SQLite mode: reload credentials first, kiro-cli may have updated them
    if (this._sqliteDb && this.isTokenExpiringSoon()) {
      logger.debug('SQLite mode: reloading credentials before refresh attempt');
      this._loadCredentialsFromSqlite(this._sqliteDb);
      if (this._accessToken && !this.isTokenExpiringSoon()) {
        logger.debug('SQLite reload provided fresh token, no refresh needed');
        return this._accessToken;
      }
    }

    this._refreshPromise = (async () => {
      try {
        await this._refreshTokenRequest();
      } catch (err) {
        const status = err && err.statusCode;
        // Graceful degradation for SQLite mode when refresh fails with 400
        if (status === 400 && this._sqliteDb) {
          logger.warning(
            'Token refresh failed with 400 after SQLite reload. This may happen if kiro-cli ' +
              'refreshed tokens in memory without persisting.'
          );
          if (this._accessToken && !this.isTokenExpired()) {
            logger.warning('Using existing access_token until it expires.');
            return this._accessToken;
          }
          throw new Error('Token expired and refresh failed. Please run "kiro-cli login" to refresh credentials.');
        }
        throw err;
      }

      if (!this._accessToken) {
        throw new Error('Failed to obtain access token');
      }
      return this._accessToken;
    })();

    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  /**
   * Forces a token refresh (used on 403 responses).
   *
   * @returns {Promise<string>} The new access token
   */
  async forceRefresh() {
    await this._refreshTokenRequest();
    return this._accessToken;
  }

  /** @returns {string|null} AWS CodeWhisperer profile ARN */
  get profileArn() {
    return this._profileArn;
  }

  /** @returns {string} AWS region */
  get region() {
    return this._region;
  }

  /** @returns {string} API host for the current region */
  get apiHost() {
    return this._apiHost;
  }

  /** @returns {string} Q API host for the current region */
  get qHost() {
    return this._qHost;
  }

  /** @returns {string} Unique machine fingerprint */
  get fingerprint() {
    return this._fingerprint;
  }

  /** @returns {string} Authentication type */
  get authType() {
    return this._authType;
  }
}

// ==================================================================================================
// Helpers
// ==================================================================================================

/**
 * Expands "~" in a path to the home directory.
 *
 * @param {string} p - Path
 * @returns {string} Expanded path
 */
function expandUserPath(p) {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Parses an ISO 8601 expires_at timestamp (handles RFC3339 and
 * nanoseconds precision) into epoch seconds.
 *
 * @param {string} expiresStr - Expiration timestamp
 * @returns {number|null} Epoch seconds or null if unparseable
 */
function parseExpiresAt(expiresStr) {
  try {
    // Handle RFC3339 Z suffix and truncate nanosecond precision
    let normalized = expiresStr;
    if (normalized.endsWith('Z')) {
      normalized = normalized.slice(0, -1) + '+00:00';
    }
    // Truncate sub-millisecond precision (node Date parses milliseconds max)
    normalized = normalized.replace(/\.(\d{3})\d+/, '.$1');

    const ts = Date.parse(normalized);
    if (Number.isNaN(ts)) return null;
    return ts / 1000;
  } catch {
    return null;
  }
}

/**
 * Reads the full text of a response body (max 1MB to bound memory).
 *
 * @param {object} body - undici body stream
 * @returns {Promise<string>} Body text
 */
async function readBodyText(body) {
  try {
    let text = '';
    for await (const chunk of body) {
      text += Buffer.from(chunk).toString('utf8');
      if (text.length > 1024 * 1024) break;
    }
    return text;
  } catch {
    return '';
  }
}

/**
 * Returns the platform-specific path to the Kiro IDE profile file.
 *
 * Kiro IDE (a VS Code fork) stores the active profile ARN in its
 * globalStorage directory following the VS Code layout:
 *
 * - macOS:   ~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/profile.json
 * - Windows: %APPDATA%/Kiro/User/globalStorage/kiro.kiroagent/profile.json
 * - Linux:   ~/.config/Kiro/User/globalStorage/kiro.kiroagent/profile.json
 *
 * @param {string} [platform=process.platform] - Target platform
 * @returns {string|null} Path to the profile file or null if unsupported
 */
function getKiroIdeProfilePath(platform = process.platform) {
  const extensionDir = path.join('User', 'globalStorage', 'kiro.kiroagent', 'profile.json');

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Kiro', extensionDir);
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, 'Kiro', extensionDir) : null;
  }
  if (platform === 'linux') {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(configHome, 'Kiro', extensionDir);
  }
  return null;
}

/**
 * Discovers the profile ARN from the Kiro IDE profile file.
 *
 * The profile file contains {"arn": "arn:aws:codewhisperer:...", "name": "..."}.
 * Missing files, malformed JSON, and missing/empty arn fields all return null
 * so the caller can fall back gracefully.
 *
 * @param {string|null} [profilePath] - Explicit path (defaults to the platform path)
 * @returns {string|null} Profile ARN or null if unavailable
 */
function discoverKiroIdeProfileArn(profilePath = null) {
  const resolvedPath = profilePath || getKiroIdeProfilePath();
  if (!resolvedPath) return null;

  try {
    if (!fs.existsSync(resolvedPath)) return null;
    const data = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    if (!data || typeof data !== 'object') return null;
    const arn = data.arn;
    return typeof arn === 'string' && arn.length > 0 ? arn : null;
  } catch {
    return null;
  }
}

module.exports = {
  AuthType,
  KiroAuthManager,
  SQLITE_TOKEN_KEYS,
  SQLITE_REGISTRATION_KEYS,
  parseExpiresAt,
  readBodyText,
  getKiroIdeProfilePath,
  discoverKiroIdeProfileArn,
};