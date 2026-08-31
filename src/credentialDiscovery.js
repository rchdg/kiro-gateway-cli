'use strict';

/**
 * Auto-discovery of default Kiro credential locations.
 *
 * When the gateway runs without an explicit credentials.json or legacy
 * environment variables, it scans the standard Kiro installation paths:
 *
 * 1. Kiro IDE token file: ~/.aws/sso/cache/kiro-auth-token.json
 * 2. kiro-cli database:   <platform data dir>/kiro-cli/data.sqlite3
 *
 * Each candidate is validated before being accepted, so unrelated files in
 * shared directories (e.g. ~/.aws/sso/cache) are ignored.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Logger } = require('./logger');
const { SQLITE_TOKEN_KEYS, SQLITE_REGISTRATION_KEYS } = require('./auth');

const logger = new Logger();

/**
 * Returns the kiro-cli data directory for the current platform.
 *
 * Mirrors the `directories` crate used by kiro-cli:
 * - macOS:   ~/Library/Application Support/kiro-cli
 * - Linux:   $XDG_DATA_HOME/kiro-cli or ~/.local/share/kiro-cli
 * - Windows: %APPDATA%/kiro-cli
 *
 * @param {string} [platform=process.platform] - Target platform
 * @returns {string|null} kiro-cli data directory or null if unsupported
 */
function getKiroCliDataDir(platform = process.platform) {
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'kiro-cli');
  }
  if (platform === 'linux') {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(dataHome, 'kiro-cli');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, 'kiro-cli') : null;
  }
  return null;
}

/**
 * Returns the ordered list of default Kiro credential candidates.
 *
 * @param {string} [platform=process.platform] - Target platform
 * @returns {Array<{type: string, path: string, description: string}>}
 *   Candidate entries in priority order
 */
function getDefaultCredentialCandidates(platform = process.platform) {
  const candidates = [];

  candidates.push({
    type: 'json',
    path: path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json'),
    description: 'Kiro IDE credentials',
  });

  const kiroCliDataDir = getKiroCliDataDir(platform);
  if (kiroCliDataDir) {
    candidates.push({
      type: 'sqlite',
      path: path.join(kiroCliDataDir, 'data.sqlite3'),
      description: 'kiro-cli database',
    });
  }

  return candidates;
}

/**
 * Validates a JSON credentials file candidate.
 *
 * Accepted when it looks like a Kiro credentials file (has a refreshToken
 * or a clientId). Malformed JSON and unrelated files are rejected.
 *
 * @param {string} filePath - Path to the JSON file
 * @returns {boolean} True if the file is a valid Kiro credential
 */
function isValidJsonCredential(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    return Boolean(data.refreshToken || data.clientId);
  } catch {
    return false;
  }
}

/**
 * Validates a kiro-cli SQLite database candidate.
 *
 * Accepted when the auth_kv table exists and contains at least one known
 * token key or device registration key.
 *
 * @param {string} dbPath - Path to the SQLite database
 * @returns {boolean} True if the database holds Kiro credentials
 */
function isValidSqliteCredential(dbPath) {
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_kv'")
      .get();
    if (!table) return false;

    for (const key of SQLITE_TOKEN_KEYS.concat(SQLITE_REGISTRATION_KEYS)) {
      const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key);
      if (row) return true;
    }
    return false;
  } catch {
    return false;
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
 * Discovers valid credentials from the default Kiro installation paths.
 *
 * @returns {Array<object>} Credential entries ready for credentials.json
 */
function discoverDefaultCredentials() {
  const entries = [];

  for (const candidate of getDefaultCredentialCandidates()) {
    if (!fs.existsSync(candidate.path)) continue;

    if (candidate.type === 'json' && isValidJsonCredential(candidate.path)) {
      entries.push({ type: 'json', path: candidate.path });
      logger.info(`Discovered ${candidate.description}: ${candidate.path}`);
    } else if (candidate.type === 'sqlite' && isValidSqliteCredential(candidate.path)) {
      entries.push({ type: 'sqlite', path: candidate.path });
      logger.info(`Discovered ${candidate.description}: ${candidate.path}`);
    }
  }

  return entries;
}

module.exports = {
  getKiroCliDataDir,
  getDefaultCredentialCandidates,
  isValidJsonCredential,
  isValidSqliteCredential,
  discoverDefaultCredentials,
};