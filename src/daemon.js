'use strict';

/**
 * Background daemon management for the gateway.
 *
 * `serve --background` spawns a detached child process that keeps running
 * after the parent exits, recording its PID in a pid file (default
 * `.kiro-gateway.pid` in the working directory). The daemon's output is
 * appended to a log file (default `kiro-gateway.log`). The `stop` command
 * reads the pid file, terminates the process, and cleans up the pid file.
 *
 * Both file locations can be overridden with the `KIRO_PID_FILE` and
 * `KIRO_LOG_FILE` environment variables. They are resolved relative to the
 * working directory, so `stop` must be run from the same directory used to
 * start the background server.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const config = require('./config');

const DEFAULT_HEALTH_POLL_INTERVAL_MS = 500;
const DEFAULT_HEALTH_POLL_TIMEOUT_MS = 30000;
const DEFAULT_HEALTH_REQUEST_TIMEOUT_MS = 2000;
const REQUIRED_CONSECUTIVE_SUCCESSES = 2;
const DEFAULT_STOP_WAIT_TIMEOUT_MS = 8000;
const STOP_KILL_GRACE_MS = 2000;

/**
 * Raised when a background daemon operation fails.
 */
class DaemonError extends Error {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message);
    this.name = 'DaemonError';
  }
}

/**
 * Resolves pid/log file paths from options or configuration.
 *
 * @param {{pidFile?: string, logFile?: string}} [options] - Override paths
 * @returns {{pidFile: string, logFile: string}} Resolved file paths
 */
function resolvePaths(options = {}) {
  return {
    pidFile: options.pidFile || config.KIRO_PID_FILE,
    logFile: options.logFile || config.KIRO_LOG_FILE,
  };
}

/**
 * Reads a PID from a pid file.
 *
 * @param {string} pidFile - Path to the pid file
 * @returns {number|null} The PID, or null when the file is missing or corrupted
 */
function readPid(pidFile) {
  let raw;
  try {
    raw = fs.readFileSync(pidFile, 'utf8').trim();
  } catch {
    return null;
  }
  const pid = parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Checks whether a process with the given PID is alive.
 *
 * @param {number} pid - Process ID
 * @returns {boolean} True when the process exists
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user
    return err.code === 'EPERM';
  }
}

/**
 * Redirects stdout/stderr into a file.
 *
 * Used by the background child process (see startInBackground). Arbitrary
 * file descriptors cannot be inherited through stdio on Windows (only
 * 0/1/2 are supported), so the child opens the log file itself and routes
 * all output into it. This is the single mechanism for both platforms.
 *
 * @param {string} logFile - Path to the log file
 */
function redirectOutputToLogFile(logFile) {
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  process.stdout.write = logStream.write.bind(logStream);
  process.stderr.write = logStream.write.bind(logStream);
}

/**
 * Starts the gateway in the background as a detached child process.
 *
 * The child inherits the current environment and working directory, runs
 * with stdout/stderr redirected to the log file (the child redirects its
 * own output - see redirectOutputToLogFile - because Windows cannot
 * inherit arbitrary file descriptors through stdio), and is fully detached
 * from the parent (it survives the parent's exit). The child PID is
 * written to the pid file. The `--background` flag must already be
 * stripped from the child arguments, otherwise the child would spawn
 * another daemon.
 *
 * @param {string} scriptPath - Path to the gateway script to execute
 * @param {string[]} childArgs - Arguments for the child (without --background)
 * @param {{pidFile?: string, logFile?: string}} [options] - Override file paths
 * @returns {{pid: number, pidFile: string, logFile: string, child: object}} Daemon details
 * @throws {DaemonError} When a background server is already running
 */
function startInBackground(scriptPath, childArgs, options = {}) {
  const { pidFile, logFile } = resolvePaths(options);
  const { Logger } = require('./logger');
  const logger = new Logger();

  if (fs.existsSync(pidFile)) {
    const existingPid = readPid(pidFile);
    if (existingPid !== null && isProcessAlive(existingPid)) {
      throw new DaemonError(
        `Server is already running in the background (pid ${existingPid}). Run 'kiro-gateway stop' to stop it.`
      );
    }
    logger.warning(`Removing stale pid file ${pidFile} (pid ${existingPid} is not running)`);
  }

  fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });

  const child = spawn(process.execPath, [scriptPath, ...childArgs], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, KIRO_DAEMON_CHILD: '1', KIRO_DAEMON_LOG_FILE: logFile },
  });
  child.unref();

  // A failed spawn fires 'error' (not 'exit'); clean up the pid file so a
  // subsequent start/stop does not see a stale record.
  child.on('error', (err) => {
    logger.error(`Failed to start the background process: ${err.message}`);
    try {
      if (readPid(pidFile) === child.pid) {
        fs.unlinkSync(pidFile);
      }
    } catch {
      // best-effort cleanup
    }
  });

  if (!Number.isInteger(child.pid)) {
    throw new DaemonError('Failed to start the background process (no PID assigned).');
  }

  fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');
  logger.info(`Started background server (pid ${child.pid}), logs: ${logFile}`);
  return { pid: child.pid, pidFile, logFile, child };
}

/**
 * Waits a number of milliseconds.
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>} Resolves after the wait
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for a process to exit.
 *
 * @param {number} pid - Process ID
 * @param {number} timeoutMs - Maximum wait time
 * @returns {Promise<boolean>} True when the process exited in time
 */
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

/**
 * Stops the background server.
 *
 * Reads the pid file, sends SIGTERM (escalating to SIGKILL after a grace
 * period), waits for the process to exit, and removes the pid file.
 *
 * @param {{pidFile?: string, logFile?: string, waitTimeoutMs?: number, killGraceMs?: number}} [options] - Override paths and timeouts
 * @returns {Promise<number>} The PID of the stopped process
 * @throws {DaemonError} When no background server is running or it cannot be stopped
 */
async function stopBackground(options = {}) {
  const { pidFile } = resolvePaths(options);
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_STOP_WAIT_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? STOP_KILL_GRACE_MS;

  if (!fs.existsSync(pidFile)) {
    throw new DaemonError(
      `No background server is running (${pidFile} not found). Start one with 'kiro-gateway serve --background'.`
    );
  }

  const pid = readPid(pidFile);
  if (pid === null) {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    throw new DaemonError(
      `Corrupted pid file ${pidFile} (contains '${raw}'). Remove it manually and try again.`
    );
  }

  if (!isProcessAlive(pid)) {
    fs.unlinkSync(pidFile);
    throw new DaemonError(
      `No background server is running (pid ${pid} is not alive). Removed stale pid file ${pidFile}.`
    );
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    throw new DaemonError(`Failed to signal the background server (pid ${pid}): ${err.message}`);
  }

  if (!(await waitForExit(pid, waitTimeoutMs))) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // process already gone
    }
    if (!(await waitForExit(pid, killGraceMs))) {
      throw new DaemonError(`Background server (pid ${pid}) did not exit after SIGTERM and SIGKILL.`);
    }
  }

  try {
    fs.unlinkSync(pidFile);
  } catch {
    // already removed by the child on graceful shutdown
  }
  return pid;
}

/**
 * Removes the pid file when it belongs to the current process.
 *
 * Called by the background child on graceful shutdown so `stop` does not
 * find a stale pid file after the server stopped itself.
 *
 * @param {{pidFile?: string}} [options] - Override file paths
 */
function cleanupPidFile(options = {}) {
  const { pidFile } = resolvePaths(options);
  try {
    if (fs.existsSync(pidFile) && readPid(pidFile) === process.pid) {
      fs.unlinkSync(pidFile);
    }
  } catch {
    // best-effort cleanup
  }
}

/**
 * Checks whether a TCP port is already accepting connections.
 *
 * Used as a pre-flight check before spawning the background server: if the
 * port is occupied (by another gateway or any other service), the child
 * would fail to bind with EADDRINUSE after the account initialization.
 *
 * @param {string} host - Host the server would bind to
 * @param {number} port - Port the server would bind to
 * @param {number} [timeoutMs=1500] - Connection timeout
 * @returns {Promise<boolean>} True when the port is already in use
 */
function checkPortInUse(host, port, timeoutMs = 1500) {
  const net = require('node:net');
  const targetHost = host && host !== '0.0.0.0' ? host : '127.0.0.1';
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, targetHost);
  });
}

/**
 * Waits for the gateway's /health endpoint to respond.
 *
 * Polls the endpoint until it returns a success status, the child process
 * exits, or the timeout elapses. A success is only declared after several
 * consecutive healthy responses while the child is still alive, so a child
 * that dies right after starting (port conflict, init failure) is reported
 * as a startup failure instead of a success. The health request is sent to
 * 127.0.0.1 when the server is bound to 0.0.0.0, and to the given host
 * otherwise.
 *
 * @param {string} host - Host the server is bound to
 * @param {number} port - Port the server is bound to
 * @param {object} child - Spawned child process (for early-exit detection)
 * @param {{pollIntervalMs?: number, timeoutMs?: number, requestTimeoutMs?: number}} [options] - Polling settings
 * @returns {Promise<{ok: boolean, url: string|null, childExited: boolean, exitCode: number|null}>} Health check result
 */
async function waitForServerHealthy(host, port, child, options = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_POLL_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_HEALTH_REQUEST_TIMEOUT_MS;
  const requiredSuccesses = options.requiredSuccesses ?? REQUIRED_CONSECUTIVE_SUCCESSES;
  const healthHost = host && host !== '0.0.0.0' ? host : '127.0.0.1';
  const url = `http://${healthHost}:${port}/health`;
  const deadline = Date.now() + timeoutMs;

  let childExitCode = null;
  child.on('exit', (code) => {
    childExitCode = code;
  });
  child.on('error', () => {
    // A failed spawn fires 'error' instead of 'exit'; treat it as an
    // immediate startup failure so the parent does not wait for the timeout.
    childExitCode = -1;
  });

  let consecutiveSuccesses = 0;
  while (Date.now() < deadline) {
    if (childExitCode !== null) {
      return { ok: false, url: null, childExited: true, exitCode: childExitCode };
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (childExitCode !== null) {
        return { ok: false, url: null, childExited: true, exitCode: childExitCode };
      }
      if (response.ok) {
        consecutiveSuccesses += 1;
        if (consecutiveSuccesses >= requiredSuccesses) {
          return { ok: true, url, childExited: false, exitCode: null };
        }
      } else {
        consecutiveSuccesses = 0;
      }
    } catch {
      consecutiveSuccesses = 0;
      // server not up yet
    }
    await sleep(pollIntervalMs);
  }
  return { ok: false, url: null, childExited: false, exitCode: null };
}

/**
 * Returns the trailing lines of a file.
 *
 * Used to show the last log lines when a background server fails to start.
 *
 * @param {string} filePath - Path to the file
 * @param {number} [lineCount=10] - Maximum number of lines to return
 * @returns {string} The trailing lines (empty when the file cannot be read)
 */
function readTail(filePath, lineCount = 10) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-lineCount).join('\n');
}

module.exports = {
  DaemonError,
  readPid,
  isProcessAlive,
  checkPortInUse,
  startInBackground,
  stopBackground,
  cleanupPidFile,
  redirectOutputToLogFile,
  waitForServerHealthy,
  readTail,
};
