'use strict';

/**
 * Self-update support for the gateway.
 *
 * The `update` command asks the npm registry for the latest published
 * version of this package and, when it differs from the running version,
 * shells out to `npm install -g kiro-gateway-cli@latest`.
 *
 * The registry lookup is best-effort: when it fails (offline, proxy, ...)
 * the install still runs, so the command behaves like a plain global
 * reinstall.
 */

const { spawn } = require('node:child_process');

const PACKAGE_NAME = 'kiro-gateway-cli';
const REGISTRY_URL = 'https://registry.npmjs.org/kiro-gateway-cli/latest';
const DEFAULT_REGISTRY_TIMEOUT_MS = 5000;

/**
 * Raised when the update cannot be performed.
 */
class UpdateError extends Error {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message);
    this.name = 'UpdateError';
  }
}

/**
 * Strips a leading `v` and surrounding whitespace from a version string.
 *
 * @param {string} version - Version string (e.g. "v1.7.0")
 * @returns {string} Normalized version (e.g. "1.7.0")
 */
function normalizeVersion(version) {
  return String(version || '').trim().replace(/^v/i, '');
}

/**
 * Looks up the latest published version on the npm registry.
 *
 * @param {{registryUrl?: string, timeoutMs?: number, fetchImpl?: Function}} [options] - Overrides (for tests)
 * @returns {Promise<string|null>} Latest version, or null when unavailable
 */
async function fetchLatestVersion(options = {}) {
  const url = options.registryUrl || REGISTRY_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (typeof fetchImpl !== 'function') return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return normalizeVersion(data && data.version) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs a global npm install of this package.
 *
 * The child inherits stdio so npm's progress output is visible to the user.
 *
 * @param {{packageName?: string, npmCommand?: string, spawnImpl?: Function, stdio?: string}} [options] - Overrides (for tests)
 * @returns {Promise<{code: number, signal: string|null}>} Child exit status
 * @throws {UpdateError} When npm cannot be started
 */
function installLatest(options = {}) {
  const packageName = options.packageName || PACKAGE_NAME;
  const npmCommand = options.npmCommand || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const spawnImpl = options.spawnImpl || spawn;
  const stdio = options.stdio || 'inherit';
  const args = ['install', '-g', `${packageName}@latest`];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(npmCommand, args, { stdio });
    } catch (err) {
      reject(new UpdateError(`Failed to run "${npmCommand}": ${err.message}`));
      return;
    }

    child.on('error', (err) => {
      reject(new UpdateError(`Failed to run "${npmCommand}": ${err.message}`));
    });
    child.on('close', (code, signal) => {
      resolve({ code: typeof code === 'number' ? code : 1, signal: signal || null });
    });
  });
}

/**
 * Updates the gateway to the latest published version.
 *
 * @param {{
 *   currentVersion: string,
 *   packageName?: string,
 *   registryUrl?: string,
 *   timeoutMs?: number,
 *   npmCommand?: string,
 *   fetchImpl?: Function,
 *   spawnImpl?: Function,
 *   statusProvider?: () => Promise<{running: boolean, pid: number|null}>,
 *   stdout?: (text: string) => void,
 *   stderr?: (text: string) => void,
 * }} options - Update options
 * @returns {Promise<boolean>} True when a new version was installed
 * @throws {UpdateError} When the install fails
 */
async function runUpdate(options = {}) {
  const currentVersion = normalizeVersion(options.currentVersion);
  const stdout = options.stdout || ((text) => process.stdout.write(text));
  const stderr = options.stderr || ((text) => process.stderr.write(text));
  const packageName = options.packageName || PACKAGE_NAME;

  // Upgrading replaces the files on disk, but a server already running in the
  // background keeps executing the old code until it is restarted. Say so
  // instead of letting the user believe the running instance was upgraded.
  const statusProvider = options.statusProvider;
  let backgroundStatus = null;
  if (typeof statusProvider === 'function') {
    try {
      backgroundStatus = await statusProvider();
    } catch {
      backgroundStatus = null;
    }
  }

  const latestVersion = await fetchLatestVersion(options);

  if (latestVersion && latestVersion === currentVersion) {
    stdout(`kiro-gateway is already up to date (v${currentVersion}).\n`);
    if (backgroundStatus && backgroundStatus.running) {
      stdout(
        `Note: the background server (pid ${backgroundStatus.pid}) keeps running the current version; ` +
          "restart it with 'kiro-gateway stop' and 'kiro-gateway start' if needed.\n"
      );
    }
    return false;
  }

  if (latestVersion) {
    stdout(`Updating kiro-gateway v${currentVersion} -> v${latestVersion}...\n`);
  } else {
    stderr(`Warning: could not check the npm registry. Installing the latest ${packageName} anyway.\n`);
    stdout(`Installing ${packageName}@latest...\n`);
  }

  const result = await installLatest({ ...options, packageName });

  if (result.code !== 0) {
    throw new UpdateError(
      `Update failed: "npm install -g ${packageName}@latest" exited with code ${result.code}. ` +
        'You may need to run it manually (e.g. with sudo on Linux/macOS).'
    );
  }

  if (latestVersion) {
    stdout(`Updated kiro-gateway to v${latestVersion}.\n`);
  } else {
    stdout(`Updated ${packageName} to the latest version.\n`);
  }
  if (backgroundStatus && backgroundStatus.running) {
    stderr(
      `Warning: the background server (pid ${backgroundStatus.pid}) is still running the previous ` +
        "version. Restart it with 'kiro-gateway stop' and 'kiro-gateway start' to apply the upgrade.\n"
    );
  }
  stdout("Run 'kiro-gateway --version' to confirm.\n");
  return true;
}

module.exports = {
  PACKAGE_NAME,
  REGISTRY_URL,
  UpdateError,
  normalizeVersion,
  fetchLatestVersion,
  installLatest,
  runUpdate,
};
