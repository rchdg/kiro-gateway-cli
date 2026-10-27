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

const IS_WINDOWS = process.platform === 'win32';

const DEFAULT_HEALTH_POLL_INTERVAL_MS = 500;
const DEFAULT_HEALTH_POLL_TIMEOUT_MS = 30000;
const DEFAULT_HEALTH_REQUEST_TIMEOUT_MS = 2000;
const REQUIRED_CONSECUTIVE_SUCCESSES = 2;
const DEFAULT_STOP_WAIT_TIMEOUT_MS = 8000;
const STOP_KILL_GRACE_MS = 2000;

// Windows refuses to delete/overwrite a file another handle still has open
// (antivirus scanners, indexers, a lingering child handle), so pid file work
// retries briefly. POSIX unlinks succeed even while the file is open, so a
// single attempt is enough there.
const FS_ATTEMPTS = IS_WINDOWS ? 6 : 1;
const FS_RETRY_DELAY_MS = 60;
const RETRYABLE_FS_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

// Set by redirectOutputToLogFile so shutdown can flush pending log writes.
let activeLogStream = null;

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
 * Blocks the current thread for a few milliseconds.
 *
 * Only used by the synchronous file helpers to space out retries; the delays
 * are tiny (tens of milliseconds) and happen only when a retry is needed.
 *
 * @param {number} ms - Milliseconds to block
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Removes a file, retrying transient Windows sharing violations.
 *
 * @param {string} filePath - Path to the file
 * @param {{attempts?: number, delayMs?: number}} [options] - Retry tuning
 * @returns {boolean} True when the file is gone (also when it never existed)
 */
function removeFileWithRetry(filePath, options = {}) {
  const attempts = options.attempts ?? FS_ATTEMPTS;
  const delayMs = options.delayMs ?? FS_RETRY_DELAY_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      if (!RETRYABLE_FS_ERRORS.has(err.code) || attempt === attempts - 1) return false;
      sleepSync(delayMs);
    }
  }
  return false;
}

/**
 * Writes a text file, retrying transient Windows sharing violations.
 *
 * @param {string} filePath - Path to the file
 * @param {string} content - File content
 * @param {{attempts?: number, delayMs?: number}} [options] - Retry tuning
 * @returns {boolean} True when the content was written
 */
function writeFileWithRetry(filePath, content, options = {}) {
  const attempts = options.attempts ?? FS_ATTEMPTS;
  const delayMs = options.delayMs ?? FS_RETRY_DELAY_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      return true;
    } catch (err) {
      if (!RETRYABLE_FS_ERRORS.has(err.code) || attempt === attempts - 1) return false;
      sleepSync(delayMs);
    }
  }
  return false;
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
  const resolved = path.resolve(logFile);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const logStream = fs.createWriteStream(resolved, { flags: 'a' });
  // A vanished or locked log file must not crash the daemon: log output is
  // best-effort, the gateway keeps serving regardless.
  logStream.on('error', () => {});

  const write = (chunk, encoding, callback) => {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (logStream.destroyed || logStream.writableEnded) {
      if (typeof callback === 'function') callback();
      return true;
    }
    return encoding === undefined
      ? logStream.write(chunk, callback)
      : logStream.write(chunk, encoding, callback);
  };

  process.stdout.write = write;
  process.stderr.write = write;
  activeLogStream = logStream;
}

/**
 * Flushes the redirected log stream before the process exits.
 *
 * Writes to a file stream are asynchronous, so calling process.exit()
 * immediately after logger.info() drops whatever is still buffered - which is
 * exactly the shutdown message, and on a crash the message that explains why.
 * Awaiting this first makes the last lines of the log reliable.
 *
 * @param {number} [timeoutMs] - Upper bound on the wait
 * @returns {Promise<void>} Resolves once the stream is flushed or the timeout hits
 */
async function flushLogOutput(timeoutMs = 1000) {
  const stream = activeLogStream;
  if (!stream || stream.destroyed || stream.writableEnded) return;

  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      stream.off('finish', finish);
      resolve();
    };
    // Do not let a stuck disk hold the shutdown hostage.
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    stream.once('finish', finish);
    stream.end();
  });
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
 * @param {string[]} childArgs - Arguments for the child (without --background/start)
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
    if (existingPid === null) {
      logger.warning(`Removing corrupted pid file ${pidFile}`);
    } else {
      logger.warning(`Removing stale pid file ${pidFile} (pid ${existingPid} is not running)`);
    }
    removeFileWithRetry(pidFile);
  }

  fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });

  // Spawn with an absolute script path so the child does not depend on the
  // inherited working directory. The pid and log paths are passed as absolute
  // values too, so the child's own cleanup and log redirection cannot be
  // affected by a different working directory (Windows detached children do
  // sometimes start elsewhere).
  const absolutePidFile = path.resolve(pidFile);
  const absoluteLogFile = path.resolve(logFile);
  const child = spawn(process.execPath, [path.resolve(scriptPath), ...childArgs], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      KIRO_DAEMON_CHILD: '1',
      KIRO_DAEMON_LOG_FILE: absoluteLogFile,
      KIRO_PID_FILE: absolutePidFile,
      KIRO_LOG_FILE: absoluteLogFile,
    },
  });
  child.unref();

  // A failed spawn fires 'error' (not 'exit'); clean up the pid file so a
  // subsequent start/stop does not see a stale record.
  child.on('error', (err) => {
    logger.error(`Failed to start the background process: ${err.message}`);
    if (readPid(pidFile) === child.pid) {
      removeFileWithRetry(pidFile);
    }
  });

  if (!Number.isInteger(child.pid)) {
    throw new DaemonError('Failed to start the background process (no PID assigned).');
  }

  if (!writeFileWithRetry(pidFile, `${child.pid}\n`)) {
    throw new DaemonError(
      `Failed to write the pid file ${pidFile}. The background process (pid ${child.pid}) was started ` +
        'but cannot be tracked; stop it manually.'
    );
  }
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
async function waitForExit(pid, timeoutMs, isAlive = isProcessAlive) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

/**
 * Stops the background server.
 *
 * Reads the pid file, terminates the process, waits for it to exit, and
 * removes the pid file.
 *
 * Termination differs per platform because Windows has no POSIX signals:
 * there `process.kill` maps onto TerminateProcess, so the process dies
 * immediately without running its shutdown handlers and there is nothing to
 * escalate to. On macOS/Linux SIGTERM is sent first and SIGKILL follows after
 * a grace period, letting the server close its sockets and clean up after
 * itself.
 *
 * @param {{pidFile?: string, logFile?: string, waitTimeoutMs?: number, killGraceMs?: number, platform?: string, killImpl?: Function, isAliveImpl?: Function}} [options] - Override paths, timeouts and platform hooks
 * @returns {Promise<number>} The PID of the stopped process
 * @throws {DaemonError} When no background server is running or it cannot be stopped
 */
async function stopBackground(options = {}) {
  const { pidFile } = resolvePaths(options);
  const platform = options.platform || process.platform;
  const isWindows = platform === 'win32';
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_STOP_WAIT_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? STOP_KILL_GRACE_MS;
  const killImpl = options.killImpl || process.kill;
  const isAlive = options.isAliveImpl || isProcessAlive;

  if (!fs.existsSync(pidFile)) {
    throw new DaemonError(
      `No background server is running (${pidFile} not found). Start one with 'kiro-gateway start'.`
    );
  }

  const pid = readPid(pidFile);
  if (pid === null) {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    throw new DaemonError(
      `Corrupted pid file ${pidFile} (contains '${raw}'). Remove it manually and try again.`
    );
  }

  if (!isAlive(pid)) {
    removeFileWithRetry(pidFile);
    throw new DaemonError(
      `No background server is running (pid ${pid} is not alive). Removed stale pid file ${pidFile}.`
    );
  }

  try {
    killImpl(pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') {
      // The process disappeared between the liveness check and the signal.
      removeFileWithRetry(pidFile);
      return pid;
    }
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      throw new DaemonError(
        `Failed to stop the background server (pid ${pid}): permission denied. ` +
          (isWindows
            ? 'If the server was started from an elevated prompt, run this command from one too.'
            : 'It may belong to another user; try running this command with sudo.')
      );
    }
    throw new DaemonError(`Failed to signal the background server (pid ${pid}): ${err.message}`);
  }

  let exited = await waitForExit(pid, waitTimeoutMs, isAlive);

  // Only POSIX supports a second, harder signal: Windows already terminated
  // the process unconditionally with the first one.
  if (!exited && !isWindows) {
    try {
      killImpl(pid, 'SIGKILL');
    } catch {
      // process already gone
    }
    exited = await waitForExit(pid, killGraceMs, isAlive);
  }

  if (!exited) {
    throw new DaemonError(
      isWindows
        ? `Background server (pid ${pid}) did not exit after being terminated.`
        : `Background server (pid ${pid}) did not exit after SIGTERM and SIGKILL.`
    );
  }

  if (!removeFileWithRetry(pidFile)) {
    const { Logger } = require('./logger');
    new Logger().warning(
      `Background server (pid ${pid}) stopped, but the pid file ${pidFile} could not be removed. ` +
        'Remove it manually.'
    );
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
  if (fs.existsSync(pidFile) && readPid(pidFile) === process.pid) {
    removeFileWithRetry(pidFile);
  }
}

/**
 * Resolves the host to use when the CLI probes a running server.
 *
 * A server bound to a wildcard address is reachable on loopback, so the
 * wildcard is replaced with the matching loopback address. IPv6 wildcards
 * map to `::1` (not `127.0.0.1`) so an IPv6-only server is still reachable.
 *
 * @param {string} host - Host the server was bound to
 * @returns {string} Host to connect to
 */
function probeHost(host) {
  if (!host) return '127.0.0.1';
  if (host === '0.0.0.0' || host === 'localhost') return '127.0.0.1';
  if (host === '::' || host === '::0' || host === '0:0:0:0:0:0:0:0') return '::1';
  return host;
}

/**
 * Formats a host for inclusion in a URL, bracketing IPv6 literals.
 *
 * @param {string} host - Bare host (e.g. "::1" or "127.0.0.1")
 * @returns {string} Host usable inside a URL authority
 */
function formatUrlHost(host) {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

/**
 * Builds the health endpoint URL for a bound host/port pair.
 *
 * @param {string} host - Host the server was bound to
 * @param {number} port - Port the server was bound to
 * @returns {string} Health endpoint URL
 */
function buildHealthUrl(host, port) {
  return `http://${formatUrlHost(probeHost(host))}:${port}/health`;
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
  const targetHost = probeHost(host);
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
  const url = buildHealthUrl(host, port);
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

/**
 * Queries the gateway's /health endpoint once.
 *
 * @param {string} url - Health endpoint URL
 * @param {number} [timeoutMs] - Request timeout
 * @returns {Promise<boolean>} True when the endpoint answered successfully
 */
async function checkHealth(url, timeoutMs = DEFAULT_HEALTH_REQUEST_TIMEOUT_MS) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Reports the state of the background server.
 *
 * The pid file is the single source of truth: it is written by
 * startInBackground and removed by stopBackground (or by the child itself on
 * graceful shutdown). When `host` and `port` are given, the /health endpoint
 * is probed as well, so a live process that no longer serves HTTP (wrong
 * port, still starting) can be told apart from a working server.
 *
 * @param {{pidFile?: string, logFile?: string, host?: string, port?: number, requestTimeoutMs?: number}} [options] - Overrides
 * @returns {Promise<{running: boolean, pid: number|null, pidFile: string, logFile: string, healthy: boolean|null, url: string|null, stale: boolean, corrupted: boolean, raw: string|null}>} Status details
 */
async function getStatus(options = {}) {
  const { pidFile, logFile } = resolvePaths(options);
  const status = {
    running: false,
    pid: null,
    pidFile,
    logFile,
    healthy: null,
    url: null,
    stale: false,
    corrupted: false,
    raw: null,
  };

  if (!fs.existsSync(pidFile)) return status;

  const pid = readPid(pidFile);
  if (pid === null) {
    status.corrupted = true;
    try {
      status.raw = fs.readFileSync(pidFile, 'utf8').trim();
    } catch {
      // file disappeared between the checks
    }
    return status;
  }

  status.pid = pid;
  if (!isProcessAlive(pid)) {
    status.stale = true;
    return status;
  }

  status.running = true;

  if (options.port !== undefined && options.port !== null) {
    status.url = buildHealthUrl(options.host, options.port);
    status.healthy = await checkHealth(status.url, options.requestTimeoutMs);
  }

  return status;
}

module.exports = {
  DaemonError,
  IS_WINDOWS,
  FS_ATTEMPTS,
  readPid,
  isProcessAlive,
  removeFileWithRetry,
  writeFileWithRetry,
  probeHost,
  formatUrlHost,
  buildHealthUrl,
  checkPortInUse,
  startInBackground,
  stopBackground,
  getStatus,
  checkHealth,
  cleanupPidFile,
  redirectOutputToLogFile,
  flushLogOutput,
  waitForServerHealthy,
  readTail,
};
