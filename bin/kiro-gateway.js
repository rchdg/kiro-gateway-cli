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
 *
 * Configuration priority (highest to lowest):
 *   1. CLI arguments (--api-key, --port, ...)
 *   2. Environment variables (.env file / process env)
 *   3. Default values
 */

const { CliError, splitCommand, parseCliArgs, buildHelpText } = require('../src/cliArgs');

const APP_VERSION = '1.0.0';
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

  const logger = new (require('../src/logger').Logger)();
  logger.error('');
  logger.error('============================================================');
  logger.error('  CONFIGURATION ERROR');
  logger.error('============================================================');
  logger.error('  No Kiro credentials configured!');
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
 * Creates credentials.json from legacy .env variables (one-time migration).
 *
 * @param {object} config - Config module
 */
function migrateLegacyCredentials(config) {
  const fs = require('node:fs');

  if (fs.existsSync(config.ACCOUNTS_CONFIG_FILE)) return;

  const hasRefreshToken = Boolean(config.REFRESH_TOKEN);
  const hasCredsFile = Boolean(config.KIRO_CREDS_FILE) && fs.existsSync(config.KIRO_CREDS_FILE);
  const hasCliDb = Boolean(config.KIRO_CLI_DB_FILE) && fs.existsSync(config.KIRO_CLI_DB_FILE);

  if (!hasRefreshToken && !hasCredsFile && !hasCliDb) return;

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

  fs.writeFileSync(config.ACCOUNTS_CONFIG_FILE, JSON.stringify(credentials, null, 2), 'utf8');
  logger.info(`Created ${config.ACCOUNTS_CONFIG_FILE} from legacy credentials (one-time migration)`);
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
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  const url = `http://${displayHost}:${port}`;

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
  // Split the leading subcommand (e.g. "serve") from the flags FIRST
  // (no config-dependent modules loaded yet)
  let args;
  try {
    const { args: rest } = splitCommand(process.argv.slice(2));
    args = parseCliArgs(rest);
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

  // Apply CLI overrides to process.env BEFORE loading config-dependent modules.
  // This makes CLI flags the highest-priority configuration source.
  for (const [key, value] of Object.entries(args.overrides)) {
    process.env[key] = value;
  }

  // Lazy-load config-dependent modules (config.js reads process.env at load time)
  const { Logger } = require('../src/logger');
  const { AccountManager } = require('../src/accountManager');
  const { createServer } = require('../src/server');
  const config = require('../src/config');

  const logger = new Logger(config.LOG_LEVEL);

  const finalHost = config.SERVER_HOST;
  const finalPort = config.SERVER_PORT;

  if (!validateConfiguration(config)) {
    process.exit(1);
  }

  // Migrate legacy credentials to credentials.json
  migrateLegacyCredentials(config);

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

  // Initialize the first working account (blocking)
  const allAccounts = accountManager.accountIds;
  let initialized = false;

  for (let i = 0; i < allAccounts.length; i++) {
    const accountId = allAccounts[i];
    logger.info(`Attempting to initialize account: ${accountId}`);

    const success = await accountManager._initializeAccount(accountId);
    if (success) {
      logger.info(`Successfully initialized account: ${accountId}`);
      initialized = true;
      break;
    }
    logger.warning(`Failed to initialize account: ${accountId}`);
  }

  if (!initialized) {
    logger.error('Failed to initialize any account. Check your credentials.');
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
    logger.info(`Server is running at http://${finalHost}:${finalPort}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down application...');
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
    // Force exit if connections don't close within 5 seconds
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});