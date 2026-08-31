'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CliError, splitCommand, parseCliArgs, buildHelpText } = require('../src/cliArgs');

// ==================================================================================================
// splitCommand
// ==================================================================================================

test('splitCommand: no arguments returns no command', () => {
  const { command, args } = splitCommand([]);
  assert.equal(command, null);
  assert.deepEqual(args, []);
});

test('splitCommand: serve subcommand is extracted', () => {
  const { command, args } = splitCommand(['serve', '--port', '9000']);
  assert.equal(command, 'serve');
  assert.deepEqual(args, ['--port', '9000']);
});

test('splitCommand: flag-first arguments are not treated as a command', () => {
  const { command, args } = splitCommand(['--port', '9000']);
  assert.equal(command, null);
  assert.deepEqual(args, ['--port', '9000']);
});

test('splitCommand: unknown command raises CliError', () => {
  assert.throws(() => splitCommand(['stop']), CliError);
});

test('parseCliArgs: no arguments returns defaults', () => {
  const args = parseCliArgs([]);
  assert.equal(args.host, null);
  assert.equal(args.port, null);
  assert.deepEqual(args.overrides, {});
  assert.equal(args.help, false);
  assert.equal(args.version, false);
});

test('parseCliArgs: host and port', () => {
  const args = parseCliArgs(['--host', '127.0.0.1', '--port', '9000']);
  assert.equal(args.host, '127.0.0.1');
  assert.equal(args.port, 9000);
  assert.equal(args.overrides.SERVER_HOST, '127.0.0.1');
  assert.equal(args.overrides.SERVER_PORT, '9000');
});

test('parseCliArgs: short flags', () => {
  const args = parseCliArgs(['-H', '0.0.0.0', '-p', '8080']);
  assert.equal(args.host, '0.0.0.0');
  assert.equal(args.port, 8080);
});

test('parseCliArgs: api key and refresh token', () => {
  const args = parseCliArgs(['-k', 'my-key', '-t', 'my-token']);
  assert.equal(args.overrides.PROXY_API_KEY, 'my-key');
  assert.equal(args.overrides.REFRESH_TOKEN, 'my-token');
});

test('parseCliArgs: credentials file and cli db', () => {
  const args = parseCliArgs(['-f', '~/credentials.json', '-d', '~/data.sqlite3']);
  assert.equal(args.overrides.KIRO_CREDS_FILE, '~/credentials.json');
  assert.equal(args.overrides.KIRO_CLI_DB_FILE, '~/data.sqlite3');
});

test('parseCliArgs: region, api region, profile arn, log level, proxy', () => {
  const args = parseCliArgs([
    '-r', 'eu-central-1',
    '--api-region', 'us-west-2',
    '--profile-arn', 'arn:aws:codewhisperer:us-east-1:123:profile/id',
    '--log-level', 'DEBUG',
    '--proxy-url', 'http://127.0.0.1:7890',
  ]);

  assert.equal(args.overrides.KIRO_REGION, 'eu-central-1');
  assert.equal(args.overrides.KIRO_API_REGION, 'us-west-2');
  assert.equal(args.overrides.PROFILE_ARN, 'arn:aws:codewhisperer:us-east-1:123:profile/id');
  assert.equal(args.overrides.LOG_LEVEL, 'DEBUG');
  assert.equal(args.overrides.VPN_PROXY_URL, 'http://127.0.0.1:7890');
});

test('parseCliArgs: account system boolean flag', () => {
  const args = parseCliArgs(['--account-system']);
  assert.equal(args.overrides.ACCOUNT_SYSTEM, 'true');
});

test('parseCliArgs: help and version flags', () => {
  assert.equal(parseCliArgs(['--help']).help, true);
  assert.equal(parseCliArgs(['-h']).help, true);
  assert.equal(parseCliArgs(['--version']).version, true);
  assert.equal(parseCliArgs(['-v']).version, true);
});

test('parseCliArgs: unknown flag raises CliError', () => {
  assert.throws(() => parseCliArgs(['--bogus']), CliError);
  assert.throws(() => parseCliArgs(['-x']), CliError);
});

test('parseCliArgs: missing value raises CliError', () => {
  assert.throws(() => parseCliArgs(['--port']), CliError);
  assert.throws(() => parseCliArgs(['-k']), CliError);
});

test('parseCliArgs: non-numeric port raises CliError', () => {
  assert.throws(() => parseCliArgs(['--port', 'abc']), CliError);
});

test('parseCliArgs: last flag wins for repeated options', () => {
  const args = parseCliArgs(['--region', 'us-east-1', '--region', 'eu-central-1']);
  assert.equal(args.overrides.KIRO_REGION, 'eu-central-1');
});

test('buildHelpText: documents all common options', () => {
  const help = buildHelpText('Test Gateway', '1.0.0', 'description');
  assert.ok(help.includes('serve'));
  assert.ok(help.includes('Usage: kiro-gateway [serve] [options]'));
  assert.ok(help.includes('--api-key'));
  assert.ok(help.includes('--refresh-token'));
  assert.ok(help.includes('--creds-file'));
  assert.ok(help.includes('--cli-db'));
  assert.ok(help.includes('--region'));
  assert.ok(help.includes('--log-level'));
  assert.ok(help.includes('--proxy-url'));
  assert.ok(help.includes('--account-system'));
  assert.ok(help.includes('1. CLI arguments'));
});