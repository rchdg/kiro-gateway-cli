'use strict';

/**
 * CLI argument parsing for the gateway.
 *
 * Dedicated flags for the most common configuration items. CLI values
 * have the HIGHEST priority - they override `.env` and environment
 * variables. Parsing is pure (no process access) so it can be tested.
 */

// Subcommands supported by the CLI
const COMMANDS = ['serve'];

const FLAG_DEFS = [
  { flags: ['-H', '--host'], env: 'SERVER_HOST', help: 'Server host address' },
  { flags: ['-p', '--port'], env: 'SERVER_PORT', type: 'int', help: 'Server port' },
  { flags: ['-k', '--api-key'], env: 'PROXY_API_KEY', help: 'API key for clients (optional; unset = no auth)' },
  { flags: ['-t', '--refresh-token'], env: 'REFRESH_TOKEN', help: 'Kiro refresh token' },
  { flags: ['-f', '--creds-file'], env: 'KIRO_CREDS_FILE', help: 'Path to Kiro credentials JSON file' },
  { flags: ['-d', '--cli-db'], env: 'KIRO_CLI_DB_FILE', help: 'Path to kiro-cli SQLite database' },
  { flags: ['-r', '--region'], env: 'KIRO_REGION', help: 'SSO/auth region (default: us-east-1)' },
  { flags: ['--api-region'], env: 'KIRO_API_REGION', help: 'Override the Q API region' },
  { flags: ['--profile-arn'], env: 'PROFILE_ARN', help: 'AWS CodeWhisperer profile ARN' },
  { flags: ['--log-level'], env: 'LOG_LEVEL', help: 'Log level (DEBUG, INFO, WARNING, ERROR)' },
  { flags: ['--proxy-url'], env: 'VPN_PROXY_URL', help: 'Proxy URL for the Kiro API (HTTP/HTTPS or SOCKS5/socks5h)' },
  { flags: ['--account-system'], env: 'ACCOUNT_SYSTEM', value: 'true', help: 'Enable multi-account failover' },
];

/**
 * Raised when the user passes an unknown flag or invalid value.
 */
class CliError extends Error {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * Looks up a flag definition by name.
 *
 * @param {string} flag - Flag name (e.g. "--port")
 * @returns {object|undefined} Flag definition
 */
function findFlagDef(flag) {
  return FLAG_DEFS.find((def) => def.flags.includes(flag));
}

/**
 * Splits a leading subcommand from the arguments.
 *
 * When the first argument is not a flag and not a known command, a
 * CliError is raised (there are no positional arguments in this CLI).
 *
 * @param {string[]} argv - Arguments (without the node/script prefix)
 * @returns {{command: string|null, args: string[]}} Subcommand (or null) and remaining args
 * @throws {CliError} On unknown subcommands
 */
function splitCommand(argv) {
  if (argv.length === 0 || argv[0].startsWith('-')) {
    return { command: null, args: argv };
  }
  if (COMMANDS.includes(argv[0])) {
    return { command: argv[0], args: argv.slice(1) };
  }
  throw new CliError(`Unknown command: ${argv[0]}. Run with --help to see available commands.`);
}

/**
 * Parses CLI arguments.
 *
 * @param {string[]} argv - Arguments (without the node/script prefix)
 * @returns {{host: string|null, port: number|null, overrides: object, help: boolean, version: boolean}}
 * @throws {CliError} On unknown flags or invalid values
 */
function parseCliArgs(argv) {
  const result = {
    host: null,
    port: null,
    overrides: {},
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      result.help = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      result.version = true;
      continue;
    }

    const def = findFlagDef(arg);
    if (!def) {
      throw new CliError(`Unknown option: ${arg}. Run with --help to see available options.`);
    }

    if (def.value !== undefined) {
      // Boolean-style flag (no value)
      result.overrides[def.env] = def.value;
      continue;
    }

    // Value flag
    const value = argv[++i];
    if (value === undefined || value === '') {
      throw new CliError(`Option ${arg} requires a value.`);
    }

    if (def.type === 'int') {
      const parsed = parseInt(value, 10);
      if (Number.isNaN(parsed)) {
        throw new CliError(`Invalid value for ${arg}: '${value}' is not a number.`);
      }
      if (def.env === 'SERVER_PORT') {
        result.port = parsed;
      }
    }

    if (def.env === 'SERVER_HOST') {
      result.host = value;
    }

    result.overrides[def.env] = value;
  }

  return result;
}

/**
 * Returns the usage text for --help.
 *
 * @param {string} appTitle - Application title
 * @param {string} appVersion - Application version
 * @param {string} appDescription - Application description
 * @returns {string} Help text
 */
function buildHelpText(appTitle, appVersion, appDescription) {
  const lines = [
    `${appTitle} v${appVersion}`,
    appDescription,
    '',
    'Usage: kiro-gateway [serve] [options]',
    '',
    'Commands:',
    '  serve                      Start the proxy gateway server (default)',
    '',
    'Options:',
    ...FLAG_DEFS.map((def) => {
      const flagNames = def.flags.join(', ');
      return `  ${flagNames.padEnd(26)} ${def.help}`;
    }),
    '  -v, --version              Print version',
    '  -h, --help                 Print help',
    '',
    'Configuration priority (highest to lowest):',
    '  1. CLI arguments',
    '  2. Environment variables',
    '  3. Default values',
    '',
  ];
  return lines.join('\n');
}

module.exports = { CliError, COMMANDS, FLAG_DEFS, splitCommand, parseCliArgs, buildHelpText };