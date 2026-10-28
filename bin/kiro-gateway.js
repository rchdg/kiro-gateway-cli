#!/usr/bin/env node
'use strict';

/**
 * Kiro Gateway (Node CLI) - entry point.
 *
 * Usage:
 *   node bin/kiro-gateway.js                      # Use defaults or env vars
 *   node bin/kiro-gateway.js serve                # Same as above (explicit serve command)
 *   node bin/kiro-gateway.js serve --port 9000    # Override port only
 *   node bin/kiro-gateway.js -k my-key -t TOKEN   # Override common config
 *   node bin/kiro-gateway.js serve --background   # Run in the background (daemon)
 *   node bin/kiro-gateway.js start                # Same as serve --background
 *   node bin/kiro-gateway.js status               # Show the background server status
 *   node bin/kiro-gateway.js stop                 # Stop the background server
 *   node bin/kiro-gateway.js update               # Upgrade to the latest npm version
 *
 * Configuration priority (highest to lowest):
 *   1. CLI arguments (--api-key, --port, ...)
 *   2. Environment variables (.env file / process env)
 *   3. Default values
 */

const { CliError, splitCommand, parseCliArgs, buildHelpText } = require('../src/cliArgs');

const APP_VERSION = require('../package.json').version;
const APP_TITLE = 'Kiro Gateway (Node CLI)';
const APP_DESCRIPTION =
  'Proxy gateway for Kiro API (Amazon Q Developer / AWS CodeWhisperer). OpenAI and Anthropic compatible.';

// ==================================================================================================
// Configuration validation
// ==================================================================================================

/**
 * Validates that credentials are configured.
 *
 * Priority:
 * 1. credentials.json (account system) - skips legacy validation
 * 2. Legacy .env variables (REFRESH_TOKEN, KIRO_CREDS_FILE, KIRO_CLI_DB_FILE)
 *
 * @param {object} config - Config module
 * @returns {boolean} True if the configuration is valid
 */
function validateConfiguration(config) {
  const fs = require('node:fs');

  if (fs.existsSync(config.ACCOUNTS_CONFIG_FILE)) {
    return true;
  }

  const hasRefreshToken = Boolean(config.REFRESH_TOKEN);
  const hasCredsFile = Boolean(config.KIRO_CREDS_FILE) && fs.existsSync(config.KIRO_CREDS_FILE);
  const hasCliDb = Boolean(config.KIRO_CLI_DB_FILE) && fs.existsSync(config.KIRO_CLI_DB_FILE);

  if (hasRefreshToken || hasCredsFile || hasCliDb) {
    return true;
  }

  const { getDefaultCredentialCandidates } = require('../src/credentialDiscovery');
  const discoveryPaths = getDefaultCredentialCandidates()
    .map((c) => `      ${c.path} (${c.description})`)
    .join('\n');

  const logger = new (require('../src/logger').Logger)();
  logger.error('');
  logger.error('============================================================');
  logger.error('  CONFIGURATION ERROR');
  logger.error('============================================================');
  logger.error('  No Kiro credentials configured!');
  logger.error('');
  logger.error('  Auto-discovery found nothing at the default Kiro locations:');
  logger.error(discoveryPaths);
  logger.error('');
  logger.error('  Configure one of the following:');
  logger.error('');
  logger.error('    CLI:');
  logger.error('      kiro-gateway -k my-secret-key -t your_refresh_token');
  logger.error('      kiro-gateway -k my-secret-key -f path/to/credentials.json');
  logger.error('      kiro-gateway -k my-secret-key -d ~/.local/share/kiro-cli/data.sqlite3');
  logger.error('');
  logger.error('    .env file (PROXY_API_KEY + one of the credential options):');
  logger.error('      PROXY_API_KEY="my-super-secret-password-123"');
  logger.error('      KIRO_CREDS_FILE="path/to/your/kiro-credentials.json"');
  logger.error('      REFRESH_TOKEN="your_refresh_token_here"');
  logger.error('      KIRO_CLI_DB_FILE="~/.local/share/kiro-cli/data.sqlite3"');
  logger.error('');
  logger.error('  Or create a credentials.json file with an array of accounts.');
  logger.error('============================================================');
  logger.error('');
  return false;
}

// ==================================================================================================
// Legacy .env to credentials.json migration
// ==================================================================================================

/**
 * Writes credentials.json atomically with owner-only permissions.
 *
 * The file holds refresh tokens, so it must not be world-readable, and a
 * truncating write would destroy every token if the process dies mid-write.
 *
 * @param {string} filePath - Target path
 * @param {any} data - JSON-serializable credentials
 */
function writeCredentialsFile(filePath, data) {
  const fs = require('node:fs');

  const tempFile = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tempFile, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Windows has no POSIX modes
    }
  } catch (err) {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/**
 * Creates credentials.json from legacy .env variables (one-time migration).
 *
 * @param {object} config - Config module
 * @returns {boolean} True if credentials.json was created
 */
function migrateLegacyCredentials(config) {
  const fs = require('node:fs');

  if (fs.existsSync(config.ACCOUNTS_CONFIG_FILE)) return false;

  const hasRefreshToken = Boolean(config.REFRESH_TOKEN);
  const hasCredsFile = Boolean(config.KIRO_CREDS_FILE) && fs.existsSync(config.KIRO_CREDS_FILE);
  const hasCliDb = Boolean(config.KIRO_CLI_DB_FILE) && fs.existsSync(config.KIRO_CLI_DB_FILE);

  if (!hasRefreshToken && !hasCredsFile && !hasCliDb) return false;

  const logger = new (require('../src/logger').Logger)();
  logger.info(`${config.ACCOUNTS_CONFIG_FILE} not found, creating from legacy credentials (one-time migration)`);

  const credentials = [];
  const entry = {};

  // Priority: SQLite DB > JSON file > refresh token
  if (hasCliDb) {
    entry.type = 'sqlite';
    entry.path = config.KIRO_CLI_DB_FILE;
  } else if (hasCredsFile) {
    entry.type = 'json';
    entry.path = config.KIRO_CREDS_FILE;
  } else if (hasRefreshToken) {
    entry.type = 'refresh_token';
    entry.refresh_token = config.REFRESH_TOKEN;
  }

  if (config.PROFILE_ARN) entry.profile_arn = config.PROFILE_ARN;
  if (config.REGION !== 'us-east-1') entry.region = config.REGION;
  if (process.env.KIRO_API_REGION) entry.api_region = process.env.KIRO_API_REGION;

  credentials.push(entry);

  writeCredentialsFile(config.ACCOUNTS_CONFIG_FILE, credentials);
  logger.info(`Created ${config.ACCOUNTS_CONFIG_FILE} from legacy credentials (one-time migration)`);
  return true;
}

/**
 * Creates credentials.json from auto-discovered default Kiro credential
 * paths (Kiro IDE token file, kiro-cli database).
 *
 * @param {object} config - Config module
 * @returns {boolean} True if credentials.json was created
 */
function autoDiscoverCredentials(config) {
  const fs = require('node:fs');
  const { discoverDefaultCredentials } = require('../src/credentialDiscovery');
  const logger = new (require('../src/logger').Logger)();

  logger.info(`${config.ACCOUNTS_CONFIG_FILE} not found, searching default Kiro credential paths...`);
  const entries = discoverDefaultCredentials();
  if (entries.length === 0) {
    logger.warning('Auto-discovery found no Kiro credentials at the default locations');
    return false;
  }

  writeCredentialsFile(config.ACCOUNTS_CONFIG_FILE, entries);
  logger.info(`Created ${config.ACCOUNTS_CONFIG_FILE} from auto-discovered credentials`);
  return true;
}

/**
 * Ensures credentials.json exists, in priority order:
 * 1. Existing credentials.json
 * 2. Legacy .env variables (one-time migration)
 * 3. Auto-discovery of default Kiro credential paths
 *
 * @param {object} config - Config module
 * @returns {boolean} True if credentials are configured
 */
function ensureCredentialsFile(config) {
  const fs = require('node:fs');

  if (fs.existsSync(config.ACCOUNTS_CONFIG_FILE)) return true;
  if (migrateLegacyCredentials(config)) return true;
  return autoDiscoverCredentials(config);
}

// ==================================================================================================
// Startup banner
// ==================================================================================================

/**
 * Prints the startup banner.
 *
 * @param {string} host - Server host
 * @param {number} port - Server port
 */
function printStartupBanner(host, port) {
  const { formatUrlHost } = require('../src/daemon');
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  const url = `http://${formatUrlHost(displayHost)}:${port}`;

  console.log();
  console.log(`  ${APP_TITLE} v${APP_VERSION}`);
  console.log();
  console.log('  Server running at:');
  console.log(`  ➜  ${url}`);
  console.log();
  console.log(`  Health Check:  ${url}/health`);
  console.log();
  console.log('  ────────────────────────────────────────────────');
  console.log();
}

// ==================================================================================================
// Entry point
// ==================================================================================================

async function main() {
  // When running as a background child process, redirect stdout/stderr to
  // the log file BEFORE any output. The child opens the log file itself
  // because Windows cannot inherit arbitrary file descriptors via stdio.
  if (process.env.KIRO_DAEMON_LOG_FILE) {
    require('../src/daemon').redirectOutputToLogFile(process.env.KIRO_DAEMON_LOG_FILE);
  }

  // Split the leading subcommand (e.g. "serve") from the flags FIRST
  // (no config-dependent modules loaded yet)
  let command = null;
  let args;
  try {
    const split = splitCommand(process.argv.slice(2));
    command = split.command;
    args = parseCliArgs(split.args);
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  if (args.help) {
    process.stdout.write(buildHelpText(APP_TITLE, APP_VERSION, APP_DESCRIPTION));
    process.exit(0);
  }

  if (args.version) {
    process.stdout.write(`kiro-gateway ${APP_VERSION}\n`);
    process.exit(0);
  }

  // `start` is shorthand for `serve --background`
  if (command === 'start') {
    args.background = true;
  }

  // ==============================================================================
  // Stop the background server (if any)
  // ==============================================================================
  if (command === 'stop') {
    const { stopBackground, DaemonError } = require('../src/daemon');
    try {
      const pid = await stopBackground();
      process.stdout.write(`Background server stopped (pid ${pid}).\n`);
    } catch (err) {
      if (err instanceof DaemonError) {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }
    process.exit(0);
  }

  // ==============================================================================
  // Upgrade to the latest published version (npm install -g)
  // ==============================================================================
  if (command === 'update') {
    const { runUpdate, UpdateError } = require('../src/updater');
    const { getStatus } = require('../src/daemon');
    try {
      await runUpdate({
        currentVersion: APP_VERSION,
        statusProvider: () => getStatus(),
      });
    } catch (err) {
      if (err instanceof UpdateError) {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }
    process.exit(0);
  }

  // Apply CLI overrides to process.env BEFORE loading config-dependent modules.
  // This makes CLI flags the highest-priority configuration source.
  for (const [key, value] of Object.entries(args.overrides)) {
    process.env[key] = value;
  }

  // ==============================================================================
  // Report the background server status
  // ==============================================================================
  if (command === 'status') {
    const { getStatus } = require('../src/daemon');
    const config = require('../src/config');
    const status = await getStatus({
      host: config.SERVER_HOST,
      port: config.SERVER_PORT,
    });

    if (status.running) {
      process.stdout.write(`Kiro Gateway is running in the background (pid ${status.pid}).\n`);
      if (status.healthy === true) {
        process.stdout.write(`  Health:   ${status.url} (healthy)\n`);
      } else if (status.healthy === false) {
        process.stdout.write(`  Health:   ${status.url} (not responding)\n`);
      }
      process.stdout.write(`  PID file: ${status.pidFile}\n`);
      process.stdout.write(`  Log file: ${status.logFile}\n`);
      process.stdout.write('  Stop it with: kiro-gateway stop\n');
      process.exit(0);
    }

    if (status.corrupted) {
      process.stderr.write(
        `Error: Corrupted pid file ${status.pidFile} (contains '${status.raw}'). ` +
          "Run 'kiro-gateway start' to overwrite it, or remove it manually.\n"
      );
      process.exit(1);
    }

    if (status.stale) {
      process.stdout.write(
        `Kiro Gateway is not running (pid ${status.pid} from ${status.pidFile} is not alive).\n`
      );
      process.stdout.write(
        "Run 'kiro-gateway stop' to clean up the stale pid file, or 'kiro-gateway start' to start a new server.\n"
      );
      process.exit(1);
    }

    process.stdout.write(
      `Kiro Gateway is not running in the background (no pid file: ${status.pidFile}).\n`
    );
    process.stdout.write('Start it with: kiro-gateway start\n');
    process.exit(1);
  }

  // ==============================================================================
  // Background (daemon) mode: spawn a detached child and return
  // ==============================================================================
  if (args.background) {
    const { startInBackground, waitForServerHealthy, readTail, checkPortInUse, getStatus, DaemonError } =
      require('../src/daemon');
    const config = require('../src/config');

    // Fail early when a background server is already tracked by the pid file,
    // so the message points at `stop` instead of a port conflict.
    const current = await getStatus();
    if (current.running) {
      process.stderr.write(
        `Error: Server is already running in the background (pid ${current.pid}). ` +
          "Run 'kiro-gateway stop' to stop it.\n"
      );
      process.exit(1);
    }

    // Pre-flight check: if the port is already occupied (another gateway or
    // any other service), the child would fail to bind after the account
    // initialization. Fail fast with an actionable message instead.
    if (await checkPortInUse(config.SERVER_HOST, config.SERVER_PORT)) {
      process.stderr.write(
        `Error: Port ${config.SERVER_PORT} is already in use on ${config.SERVER_HOST}. ` +
          'Another server may be running there. Stop it or choose a different port with --port.\n'
      );
      process.exit(1);
    }

    // Re-invoke this script without the --background flag or the `start`
    // subcommand so the child runs the normal foreground flow (instead of
    // spawning another daemon).
    const rawArgs = process.argv.slice(2);
    const daemonArgs = command === 'start' ? rawArgs.slice(1) : rawArgs;
    const childArgs = daemonArgs.filter((a) => a !== '--background' && a !== '-b');

    let daemon;
    try {
      daemon = startInBackground(process.argv[1], childArgs);
    } catch (err) {
      if (err instanceof DaemonError) {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }

    process.stdout.write(`Starting server in the background (pid ${daemon.pid})...\n`);

    const result = await waitForServerHealthy(config.SERVER_HOST, config.SERVER_PORT, daemon.child);

    if (result.ok) {
      process.stdout.write(`Server is running in the background: ${result.url}\n`);
      process.stdout.write('Check it with: kiro-gateway status\n');
      process.stdout.write('Stop it with: kiro-gateway stop\n');
    } else if (result.childExited) {
      process.stderr.write(`Background server exited during startup (exit code ${result.exitCode}).\n`);
      const tail = readTail(daemon.logFile, 15);
      if (tail) {
        process.stderr.write(`Last log lines from ${daemon.logFile}:\n${tail}\n`);
      }
      // The child is gone, so its pid record is stale: drop it now instead
      // of leaving `status` reporting a dead server until the next start.
      require('../src/daemon').removeFileWithRetry(daemon.pidFile);
      process.exit(1);
    } else {
      process.stdout.write(
        `Server is starting in the background (pid ${daemon.pid}).\n` +
        `Check progress in the log file: ${daemon.logFile}\n` +
        'Check it with: kiro-gateway status\n' +
        'Stop it with: kiro-gateway stop\n'
      );
    }
    process.exit(0);
  }

  // Lazy-load config-dependent modules (config.js reads process.env at load time)
  const { Logger } = require('../src/logger');
  const { AccountManager } = require('../src/accountManager');
  const { createServer } = require('../src/server');
  const config = require('../src/config');

  const logger = new Logger(config.LOG_LEVEL);

  const finalHost = config.SERVER_HOST;
  const finalPort = config.SERVER_PORT;

  // Ensure credentials.json exists: explicit file > legacy .env migration >
  // auto-discovery of default Kiro credential paths
  ensureCredentialsFile(config);

  if (!validateConfiguration(config)) {
    process.exit(1);
  }

  // ==============================================================================
  // Account system initialization
  // ==============================================================================
  logger.info('Starting application... Creating state managers.');

  const accountManager = new AccountManager(config.ACCOUNTS_CONFIG_FILE);
  await accountManager.loadCredentials();

  if (accountManager.accountCount === 0) {
    logger.error(`No accounts configured in ${config.ACCOUNTS_CONFIG_FILE}`);
    process.exit(1);
  }

  // Initialize the first working account (blocking). Configured credentials
  // may be stale (for example an expired Kiro IDE token file), so fall back
  // to auto-discovered local sources (kiro-cli database, Kiro IDE token file)
  // before giving up.
  let initialized = await accountManager.initializeFirstWorking();

  if (!initialized) {
    const { discoverDefaultCredentials } = require('../src/credentialDiscovery');
    const fallbackIds = accountManager.addCredentialEntries(discoverDefaultCredentials());

    if (fallbackIds.length > 0) {
      logger.info(
        `Configured credentials failed, retrying with ${fallbackIds.length} auto-discovered source(s)`
      );
      initialized = await accountManager.initializeFirstWorking(fallbackIds);
    }
  }

  if (!initialized) {
    logger.error(
      'Failed to initialize any account. Local Kiro credentials are missing or expired; ' +
        'run `kiro-cli login` or sign in to Kiro IDE again, then restart the gateway.'
    );
    process.exit(1);
  }

  logger.info('Account system initialized successfully');

  // ==============================================================================
  // Start the server
  // ==============================================================================
  const app = createServer({
    accountManager,
    accountSystem: config.ACCOUNT_SYSTEM,
  });

  printStartupBanner(finalHost, finalPort);
  logger.info(`Starting server on ${finalHost}:${finalPort}...`);

  const server = app.listen(finalPort, finalHost, () => {
    const { formatUrlHost } = require('../src/daemon');
    logger.info(`Server is running at http://${formatUrlHost(finalHost)}:${finalPort}`);
  });

  // Bind failures arrive as an 'error' event, not as a thrown exception, so
  // without this handler Node prints a raw stack trace (syscall/errno/address)
  // for something the user can fix by changing one flag.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        `Port ${finalPort} is already in use on ${finalHost}. ` +
          'Stop the process using it or choose another port with --port.'
      );
    } else if (err.code === 'EACCES') {
      logger.error(
        `Permission denied binding ${finalHost}:${finalPort}. ` +
          'Ports below 1024 need elevated privileges; choose a port above 1024.'
      );
    } else if (err.code === 'EADDRNOTAVAIL') {
      logger.error(
        `Cannot bind ${finalHost}:${finalPort}: the address does not belong to this machine. ` +
          'Check the --host value.'
      );
    } else {
      logger.error(`Failed to start the server on ${finalHost}:${finalPort}: ${err.message}`);
    }

    if (process.env.KIRO_DAEMON_CHILD === '1') {
      require('../src/daemon').cleanupPidFile();
    }
    process.exit(1);
  });

  // Graceful shutdown
  let shuttingDown = false;

  /**
   * Exits the process after flushing the redirected log stream.
   *
   * process.exit() drops buffered writes to a file stream, which loses the
   * final log lines - precisely the ones that explain a shutdown or a crash.
   *
   * @param {number} code - Exit code
   */
  const exitAfterFlush = async (code) => {
    try {
      await require('../src/daemon').flushLogOutput();
    } catch {
      // Never let logging block the exit
    }
    process.exit(code);
  };

  /**
   * Cleans up daemon state before the process goes away.
   */
  const cleanupIfDaemon = () => {
    if (process.env.KIRO_DAEMON_CHILD !== '1') return;
    try {
      require('../src/daemon').cleanupPidFile();
    } catch {
      // best-effort cleanup
    }
  };

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Shutting down application (${signal || 'shutdown'})...`);

    server.close(() => {
      cleanupIfDaemon();
      logger.info('Server closed');
      exitAfterFlush(0);
    });

    // Keep-alive clients hold the listener open long after the last response,
    // so idle sockets are dropped immediately; only in-flight requests get the
    // grace period below.
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }

    // Force exit if connections don't close within 5 seconds
    setTimeout(() => {
      cleanupIfDaemon();
      logger.warning('Forcing shutdown after timeout');
      exitAfterFlush(0);
    }, 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A single unhandled rejection used to take the gateway down silently in
  // background mode: the daemon just vanished and `status` reported it stopped
  // with no explanation. Log it with a stack so the log file explains why.
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
    logger.error(`Unhandled promise rejection: ${detail}`);
  });

  // An uncaught exception leaves the process in an unknown state, so it is
  // still fatal - but it must be reported and the pid file cleaned up.
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.stack || err.message}`);
    cleanupIfDaemon();
    exitAfterFlush(1);
  });
}

main().catch(async (err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  try {
    await require('./../src/daemon').flushLogOutput();
  } catch {
    // Never let logging block the exit
  }
  process.exit(1);
});