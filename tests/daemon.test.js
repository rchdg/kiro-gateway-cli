'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const {
  DaemonError,
  readPid,
  isProcessAlive,
  checkPortInUse,
  startInBackground,
  stopBackground,
  getStatus,
  removeFileWithRetry,
  writeFileWithRetry,
  probeHost,
  formatUrlHost,
  buildHealthUrl,
  cleanupPidFile,
  redirectOutputToLogFile,
  flushLogOutput,
  waitForServerHealthy,
  readTail,
} = require('../src/daemon');

// ==================================================================================================
// Fixtures
// ==================================================================================================

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-daemon-test-'));
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SLEEP_SCRIPT = path.join(tmpDir, 'fixture-sleep.js');
const EXIT_SCRIPT = path.join(tmpDir, 'fixture-exit.js');
const ARGV_SCRIPT = path.join(tmpDir, 'fixture-argv.js');
const OUTPUT_SCRIPT = path.join(tmpDir, 'fixture-output.js');
const IGNORE_TERM_SCRIPT = path.join(tmpDir, 'fixture-ignore-term.js');

fs.writeFileSync(SLEEP_SCRIPT, 'setTimeout(() => process.exit(0), 60000);\n', 'utf8');
fs.writeFileSync(EXIT_SCRIPT, 'process.exit(3);\n', 'utf8');
fs.writeFileSync(
  ARGV_SCRIPT,
  "require('node:fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n" +
    'setTimeout(() => process.exit(0), 60000);\n',
  'utf8'
);
fs.writeFileSync(
  OUTPUT_SCRIPT,
  "require(process.env.KIRO_DAEMON_MODULE).redirectOutputToLogFile(process.env.KIRO_DAEMON_LOG_FILE);\n" +
    "process.stdout.write('hello stdout\\n'); process.stderr.write('hello stderr\\n');\n" +
    'setTimeout(() => process.exit(0), 60000);\n',
  'utf8'
);
fs.writeFileSync(IGNORE_TERM_SCRIPT, "process.on('SIGTERM', () => {});\nsetTimeout(() => process.exit(0), 60000);\n", 'utf8');

function tempPaths(prefix = 'pid') {
  return {
    pidFile: path.join(tmpDir, `${prefix}.pid`),
    logFile: path.join(tmpDir, `${prefix}.log`),
  };
}

function spawnNode(scriptPath) {
  return spawn(process.execPath, [scriptPath], { stdio: 'ignore' });
}

function waitForExit(child) {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}

// ==================================================================================================
// readPid
// ==================================================================================================

test('readPid: returns null for a missing file', () => {
  assert.equal(readPid(path.join(tmpDir, 'missing.pid')), null);
});

test('readPid: parses a valid pid', () => {
  const pidFile = path.join(tmpDir, 'valid.pid');
  fs.writeFileSync(pidFile, '12345\n', 'utf8');
  assert.equal(readPid(pidFile), 12345);
});

test('readPid: returns null for garbage content', () => {
  const pidFile = path.join(tmpDir, 'garbage.pid');
  fs.writeFileSync(pidFile, 'not-a-number', 'utf8');
  assert.equal(readPid(pidFile), null);
});

test('readPid: returns null for empty content', () => {
  const pidFile = path.join(tmpDir, 'empty.pid');
  fs.writeFileSync(pidFile, '', 'utf8');
  assert.equal(readPid(pidFile), null);
});

test('readPid: returns null for non-positive values', () => {
  const pidFile = path.join(tmpDir, 'zero.pid');
  fs.writeFileSync(pidFile, '0', 'utf8');
  assert.equal(readPid(pidFile), null);
});

// ==================================================================================================
// isProcessAlive
// ==================================================================================================

test('isProcessAlive: current process is alive', () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test('isProcessAlive: unknown high pid is dead', () => {
  assert.equal(isProcessAlive(99999999), false);
});

test('isProcessAlive: rejects invalid inputs', () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(NaN), false);
  assert.equal(isProcessAlive(12.5), false);
});

test('isProcessAlive: process disappears after exit', async () => {
  const child = spawnNode(EXIT_SCRIPT);
  const code = await waitForExit(child);
  assert.equal(code, 3);
  assert.equal(isProcessAlive(child.pid), false);
});

// ==================================================================================================
// startInBackground
// ==================================================================================================

test('startInBackground: spawns a detached child and writes the pid file', async () => {
  const { pidFile, logFile } = tempPaths('start');
  const { pid } = startInBackground(SLEEP_SCRIPT, [], { pidFile, logFile });

  assert.equal(Number.isInteger(pid), true);
  assert.equal(readPid(pidFile), pid);
  assert.equal(isProcessAlive(pid), true);

  await stopBackground({ pidFile });
  assert.equal(isProcessAlive(pid), false);
  assert.equal(fs.existsSync(pidFile), false);
});

test('startInBackground: passes arguments to the child', async () => {
  const { pidFile, logFile } = tempPaths('argv');
  const argvOut = path.join(tmpDir, 'argv-out.json');
  process.env.ARGV_OUT = argvOut;

  const { pid } = startInBackground(ARGV_SCRIPT, ['serve', '--port', '9000'], { pidFile, logFile });
  delete process.env.ARGV_OUT;
  assert.equal(readPid(pidFile), pid);

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !fs.existsSync(argvOut)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(argvOut, 'utf8')), ['serve', '--port', '9000']);

  await stopBackground({ pidFile });
});

test('startInBackground: child output is appended to the log file', async () => {
  const { pidFile, logFile } = tempPaths('log');
  process.env.KIRO_DAEMON_MODULE = require.resolve('../src/daemon');
  startInBackground(OUTPUT_SCRIPT, [], { pidFile, logFile });
  delete process.env.KIRO_DAEMON_MODULE;

  const deadline = Date.now() + 3000;
  let log = '';
  while (Date.now() < deadline) {
    try {
      log = fs.readFileSync(logFile, 'utf8');
      if (log.includes('hello stdout') && log.includes('hello stderr')) break;
    } catch {
      // log file created by the child; not there yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(log.includes('hello stdout'));
  assert.ok(log.includes('hello stderr'));

  await stopBackground({ pidFile });
});

test('startInBackground: throws when another server is already running', () => {
  const { pidFile, logFile } = tempPaths('busy');
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');

  assert.throws(() => startInBackground(SLEEP_SCRIPT, [], { pidFile, logFile }), DaemonError);
  fs.unlinkSync(pidFile);
});

test('startInBackground: removes a stale pid file and starts anyway', async () => {
  const { pidFile, logFile } = tempPaths('stale');
  fs.writeFileSync(pidFile, '99999999\n', 'utf8');

  const { pid } = startInBackground(SLEEP_SCRIPT, [], { pidFile, logFile });
  assert.equal(readPid(pidFile), pid);
  assert.notEqual(pid, 99999999);

  await stopBackground({ pidFile });
});

test('startInBackground: creates the log directory when missing', async () => {
  const pidFile = path.join(tmpDir, 'nested-dir.pid');
  const logFile = path.join(tmpDir, 'nested', 'sub', 'daemon.log');
  process.env.KIRO_DAEMON_MODULE = require.resolve('../src/daemon');
  const { pid } = startInBackground(OUTPUT_SCRIPT, [], { pidFile, logFile });
  delete process.env.KIRO_DAEMON_MODULE;

  // The parent creates the missing directory synchronously; the child
  // creates the log file itself once it starts.
  assert.equal(fs.existsSync(path.dirname(logFile)), true);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !fs.existsSync(logFile)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fs.existsSync(logFile), true);

  await stopBackground({ pidFile });
});

test('startInBackground: handles a child that exits immediately', async () => {
  const { pidFile, logFile } = tempPaths('dies');
  const { pid, child } = startInBackground(path.join(tmpDir, 'missing-script.js'), [], {
    pidFile,
    logFile,
  });
  assert.equal(readPid(pidFile), pid);

  // The child exits with code 1 (script not found); stop detects the stale
  // pid and removes the file.
  await new Promise((resolve) => child.on('exit', resolve));
  await assert.rejects(stopBackground({ pidFile }), DaemonError);
  assert.equal(fs.existsSync(pidFile), false);
});

// ==================================================================================================
// redirectOutputToLogFile
// ==================================================================================================

test('redirectOutputToLogFile: routes stdout and stderr into the file', async () => {
  const logFile = path.join(tmpDir, 'redirect.log');
  const modulePath = require.resolve('../src/daemon');
  const script =
    `const { redirectOutputToLogFile } = require(${JSON.stringify(modulePath)});\n` +
    `redirectOutputToLogFile(${JSON.stringify(logFile)});\n` +
    "process.stdout.write('out line\\n');\n" +
    "process.stderr.write('err line\\n');\n" +
    'setTimeout(() => process.exit(0), 100);\n';

  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  await waitForExit(child);

  const content = fs.readFileSync(logFile, 'utf8');
  assert.ok(content.includes('out line'));
  assert.ok(content.includes('err line'));
});

test('redirectOutputToLogFile: appends to an existing file', async () => {
  const logFile = path.join(tmpDir, 'redirect-append.log');
  fs.writeFileSync(logFile, 'existing line\n', 'utf8');
  const modulePath = require.resolve('../src/daemon');
  const script =
    `const { redirectOutputToLogFile } = require(${JSON.stringify(modulePath)});\n` +
    `redirectOutputToLogFile(${JSON.stringify(logFile)});\n` +
    "process.stdout.write('new line\\n');\n" +
    'setTimeout(() => process.exit(0), 100);\n';

  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  await waitForExit(child);

  const content = fs.readFileSync(logFile, 'utf8');
  assert.ok(content.includes('existing line'));
  assert.ok(content.includes('new line'));
});

// ==================================================================================================
// stopBackground
// ==================================================================================================

test('stopBackground: throws when no pid file exists', async () => {
  await assert.rejects(stopBackground({ pidFile: path.join(tmpDir, 'nope.pid') }), DaemonError);
});

test('stopBackground: throws and removes the file for a stale pid', async () => {
  const { pidFile } = tempPaths('stale-stop');
  fs.writeFileSync(pidFile, '99999999\n', 'utf8');

  await assert.rejects(stopBackground({ pidFile }), DaemonError);
  assert.equal(fs.existsSync(pidFile), false);
});

test('stopBackground: throws on a corrupted pid file', async () => {
  const pidFile = path.join(tmpDir, 'corrupt.pid');
  fs.writeFileSync(pidFile, 'junk', 'utf8');

  await assert.rejects(stopBackground({ pidFile }), /Corrupted pid file/);
  assert.equal(fs.existsSync(pidFile), true);
});

test('stopBackground: stops a live process and removes the pid file', async () => {
  const { pidFile } = tempPaths('stop-live');
  const child = spawnNode(SLEEP_SCRIPT);
  await new Promise((resolve) => child.on('spawn', resolve));
  fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');

  const stoppedPid = await stopBackground({ pidFile });
  assert.equal(stoppedPid, child.pid);
  assert.equal(isProcessAlive(child.pid), false);
  assert.equal(fs.existsSync(pidFile), false);
});

test(
  'stopBackground: escalates to SIGKILL when SIGTERM is ignored',
  { skip: process.platform === 'win32' && 'Windows terminates unconditionally; there is nothing to escalate' },
  async () => {
    const { pidFile } = tempPaths('stop-ignore');
    const child = spawnNode(IGNORE_TERM_SCRIPT);
    await new Promise((resolve) => child.on('spawn', resolve));
    fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');

    const stoppedPid = await stopBackground({ pidFile, waitTimeoutMs: 300, killGraceMs: 500 });
    assert.equal(stoppedPid, child.pid);
    assert.equal(isProcessAlive(child.pid), false);
    assert.equal(fs.existsSync(pidFile), false);
  }
);

test('stopBackground: win32 terminates once and never escalates', async () => {
  const { pidFile } = tempPaths('stop-win32');
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');

  const signals = [];
  await assert.rejects(
    () =>
      stopBackground({
        pidFile,
        platform: 'win32',
        killImpl: (pid, signal) => signals.push(signal),
        isAliveImpl: () => true,
        waitTimeoutMs: 50,
        killGraceMs: 50,
      }),
    /did not exit after being terminated/
  );
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(fs.existsSync(pidFile), true);
});

test('stopBackground: posix escalates SIGTERM to SIGKILL', async () => {
  const { pidFile } = tempPaths('stop-posix');
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');

  const signals = [];
  await assert.rejects(
    () =>
      stopBackground({
        pidFile,
        platform: 'darwin',
        killImpl: (pid, signal) => signals.push(signal),
        isAliveImpl: () => true,
        waitTimeoutMs: 50,
        killGraceMs: 50,
      }),
    /did not exit after SIGTERM and SIGKILL/
  );
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('stopBackground: reports permission denied with a platform hint', async () => {
  const { pidFile } = tempPaths('stop-eperm');
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');

  const denied = () => {
    const err = new Error('access denied');
    err.code = 'EPERM';
    throw err;
  };

  await assert.rejects(
    () => stopBackground({ pidFile, platform: 'win32', killImpl: denied, isAliveImpl: () => true }),
    /elevated prompt/
  );
  await assert.rejects(
    () => stopBackground({ pidFile, platform: 'linux', killImpl: denied, isAliveImpl: () => true }),
    /sudo/
  );
});

test('stopBackground: treats ESRCH from kill as already stopped', async () => {
  const { pidFile } = tempPaths('stop-esrch');
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');

  const gone = () => {
    const err = new Error('no such process');
    err.code = 'ESRCH';
    throw err;
  };

  const stoppedPid = await stopBackground({
    pidFile,
    killImpl: gone,
    isAliveImpl: () => true,
  });
  assert.equal(stoppedPid, process.pid);
  assert.equal(fs.existsSync(pidFile), false);
});

// ==================================================================================================
// removeFileWithRetry / writeFileWithRetry
// ==================================================================================================

test('removeFileWithRetry: removes an existing file', () => {
  const file = path.join(tmpDir, 'retry-remove.txt');
  fs.writeFileSync(file, 'x', 'utf8');

  assert.equal(removeFileWithRetry(file), true);
  assert.equal(fs.existsSync(file), false);
});

test('removeFileWithRetry: reports success for a missing file', () => {
  assert.equal(removeFileWithRetry(path.join(tmpDir, 'retry-missing.txt')), true);
});

test('removeFileWithRetry: reports failure for a non-empty directory', () => {
  const dir = path.join(tmpDir, 'retry-dir');
  fs.mkdirSync(path.join(dir, 'child'), { recursive: true });

  assert.equal(removeFileWithRetry(dir, { attempts: 2, delayMs: 1 }), false);
  assert.equal(fs.existsSync(dir), true);
});

test('writeFileWithRetry: writes the file content', () => {
  const file = path.join(tmpDir, 'retry-write.txt');
  assert.equal(writeFileWithRetry(file, 'pid\n'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'pid\n');
});

test('writeFileWithRetry: reports failure when the directory is missing', () => {
  const file = path.join(tmpDir, 'no-such-dir', 'file.txt');
  assert.equal(writeFileWithRetry(file, 'x', { attempts: 2, delayMs: 1 }), false);
});

// ==================================================================================================
// cleanupPidFile
// ==================================================================================================

test('cleanupPidFile: removes the pid file when it matches the current pid', () => {
  const pidFile = path.join(tmpDir, 'own.pid');
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');

  cleanupPidFile({ pidFile });
  assert.equal(fs.existsSync(pidFile), false);
});

test('cleanupPidFile: keeps the pid file when it belongs to another process', () => {
  const pidFile = path.join(tmpDir, 'foreign.pid');
  fs.writeFileSync(pidFile, '12345\n', 'utf8');

  cleanupPidFile({ pidFile });
  assert.equal(fs.existsSync(pidFile), true);
  fs.unlinkSync(pidFile);
});

test('cleanupPidFile: no-op when the pid file is missing', () => {
  cleanupPidFile({ pidFile: path.join(tmpDir, 'ghost.pid') });
});

// ==================================================================================================
// checkPortInUse
// ==================================================================================================

test('checkPortInUse: reports a listening port as in use', async () => {
  const { server, port } = await startHealthServer();
  assert.equal(await checkPortInUse('0.0.0.0', port), true);
  closeServer(server);
});

test('checkPortInUse: reports a dead port as free', async () => {
  assert.equal(await checkPortInUse('0.0.0.0', 1), false);
});

// ==================================================================================================
// waitForServerHealthy
// ==================================================================================================

function startHealthServer({ ok = true } = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader('connection', 'close');
    if (ok) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"healthy"}');
    } else {
      res.writeHead(500);
      res.end('boom');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  server.closeAllConnections();
  server.close();
}

test('waitForServerHealthy: returns the health url once the server responds', async (t) => {
  const { server, port } = await startHealthServer();
  t.after(() => closeServer(server));
  const dummyChild = { on() {} };

  const result = await waitForServerHealthy('0.0.0.0', port, dummyChild, { timeoutMs: 3000 });
  assert.deepEqual(result, { ok: true, url: `http://127.0.0.1:${port}/health`, childExited: false, exitCode: null });
});

test('waitForServerHealthy: uses the bound host when not 0.0.0.0', async (t) => {
  const { server, port } = await startHealthServer();
  t.after(() => closeServer(server));
  const dummyChild = { on() {} };

  const result = await waitForServerHealthy('127.0.0.1', port, dummyChild, { timeoutMs: 3000 });
  assert.equal(result.ok, true);
  assert.equal(result.url, `http://127.0.0.1:${port}/health`);
});

test('waitForServerHealthy: reports early child exit', async (t) => {
  const { server, port } = await startHealthServer();
  t.after(() => closeServer(server));
  const child = { listeners: {} };
  child.on = (event, fn) => {
    child.listeners[event] = fn;
  };

  const pending = waitForServerHealthy('0.0.0.0', port, child, { timeoutMs: 5000 });
  child.listeners.exit(3);

  const result = await pending;
  assert.deepEqual(result, { ok: false, url: null, childExited: true, exitCode: 3 });
});

test('waitForServerHealthy: treats a child spawn error as startup failure', async (t) => {
  const { server, port } = await startHealthServer();
  t.after(() => closeServer(server));
  const child = { listeners: {} };
  child.on = (event, fn) => {
    child.listeners[event] = fn;
  };

  const pending = waitForServerHealthy('0.0.0.0', port, child, { timeoutMs: 5000 });
  child.listeners.error();

  const result = await pending;
  assert.deepEqual(result, { ok: false, url: null, childExited: true, exitCode: -1 });
});

test('waitForServerHealthy: times out when the server never comes up', async () => {
  const dummyChild = { on() {} };

  const result = await waitForServerHealthy('0.0.0.0', 1, dummyChild, {
    timeoutMs: 200,
    pollIntervalMs: 50,
    requestTimeoutMs: 100,
  });
  assert.deepEqual(result, { ok: false, url: null, childExited: false, exitCode: null });
});

test('waitForServerHealthy: keeps waiting on non-2xx responses', async (t) => {
  const { server, port } = await startHealthServer({ ok: false });
  t.after(() => closeServer(server));
  const dummyChild = { on() {} };

  const result = await waitForServerHealthy('0.0.0.0', port, dummyChild, { timeoutMs: 300 });
  assert.equal(result.ok, false);
});

test('waitForServerHealthy: child exit during verification wins over health', async (t) => {
  const { server, port } = await startHealthServer();
  t.after(() => closeServer(server));
  const child = { listeners: {} };
  child.on = (event, fn) => {
    child.listeners[event] = fn;
  };

  // The first poll gets a healthy response, but the child exits before the
  // consecutive-success verification can complete.
  const pending = waitForServerHealthy('0.0.0.0', port, child, {
    timeoutMs: 5000,
    pollIntervalMs: 100,
  });
  setTimeout(() => child.listeners.exit(3), 30);

  const result = await pending;
  assert.deepEqual(result, { ok: false, url: null, childExited: true, exitCode: 3 });
});

// ==================================================================================================
// readTail
// ==================================================================================================

test('readTail: returns the last lines of a file', () => {
  const file = path.join(tmpDir, 'tail.log');
  fs.writeFileSync(file, 'line1\nline2\nline3\nline4\n', 'utf8');
  assert.equal(readTail(file, 2), 'line3\nline4');
});

test('readTail: returns fewer lines when the file is short', () => {
  const file = path.join(tmpDir, 'short.log');
  fs.writeFileSync(file, 'only\n', 'utf8');
  assert.equal(readTail(file, 10), 'only');
});

test('readTail: returns empty for a missing file', () => {
  assert.equal(readTail(path.join(tmpDir, 'no-tail.log')), '');
});

// ==================================================================================================
// getStatus
// ==================================================================================================

test('getStatus: reports not running when the pid file is missing', async () => {
  const { pidFile, logFile } = tempPaths('status-missing');
  const status = await getStatus({ pidFile, logFile });

  assert.equal(status.running, false);
  assert.equal(status.pid, null);
  assert.equal(status.stale, false);
  assert.equal(status.corrupted, false);
  assert.equal(status.pidFile, pidFile);
  assert.equal(status.logFile, logFile);
});

test('getStatus: reports a corrupted pid file', async () => {
  const { pidFile, logFile } = tempPaths('status-corrupt');
  fs.writeFileSync(pidFile, 'junk\n', 'utf8');

  const status = await getStatus({ pidFile, logFile });
  assert.equal(status.running, false);
  assert.equal(status.corrupted, true);
  assert.equal(status.raw, 'junk');
});

test('getStatus: reports a stale pid file', async () => {
  const { pidFile, logFile } = tempPaths('status-stale');
  fs.writeFileSync(pidFile, '99999999\n', 'utf8');

  const status = await getStatus({ pidFile, logFile });
  assert.equal(status.running, false);
  assert.equal(status.pid, 99999999);
  assert.equal(status.stale, true);
});

test('getStatus: reports a running server and probes /health', async (t) => {
  const { server, port } = await startHealthServer();
  t.after(() => closeServer(server));

  const { pidFile, logFile } = tempPaths('status-live');
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');

  const status = await getStatus({ pidFile, logFile, host: '0.0.0.0', port });
  assert.equal(status.running, true);
  assert.equal(status.pid, process.pid);
  assert.equal(status.stale, false);
  assert.equal(status.healthy, true);
  assert.equal(status.url, `http://127.0.0.1:${port}/health`);
});

test('getStatus: reports unhealthy when the port does not answer', async () => {
  const { pidFile, logFile } = tempPaths('status-unhealthy');
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');

  const status = await getStatus({ pidFile, logFile, port: 1, requestTimeoutMs: 500 });
  assert.equal(status.running, true);
  assert.equal(status.healthy, false);
});

test('getStatus: skips the health probe without a port', async () => {
  const { pidFile, logFile } = tempPaths('status-noport');
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');

  const status = await getStatus({ pidFile, logFile });
  assert.equal(status.running, true);
  assert.equal(status.healthy, null);
  assert.equal(status.url, null);
});

// ==================================================================================================
// probeHost / formatUrlHost / buildHealthUrl (IPv4 + IPv6)
// ==================================================================================================

test('probeHost: maps wildcard and localhost to loopback', () => {
  assert.equal(probeHost(undefined), '127.0.0.1');
  assert.equal(probeHost(''), '127.0.0.1');
  assert.equal(probeHost('0.0.0.0'), '127.0.0.1');
  assert.equal(probeHost('localhost'), '127.0.0.1');
  assert.equal(probeHost('127.0.0.1'), '127.0.0.1');
  assert.equal(probeHost('192.168.1.10'), '192.168.1.10');
});

test('probeHost: maps IPv6 wildcards to ::1', () => {
  assert.equal(probeHost('::'), '::1');
  assert.equal(probeHost('::0'), '::1');
  assert.equal(probeHost('0:0:0:0:0:0:0:0'), '::1');
  assert.equal(probeHost('::1'), '::1');
});

test('formatUrlHost: brackets IPv6 literals only', () => {
  assert.equal(formatUrlHost('127.0.0.1'), '127.0.0.1');
  assert.equal(formatUrlHost('example.com'), 'example.com');
  assert.equal(formatUrlHost('::1'), '[::1]');
  assert.equal(formatUrlHost('[::1]'), '[::1]');
});

test('buildHealthUrl: produces a valid URL for IPv4 and IPv6 hosts', () => {
  assert.equal(buildHealthUrl('0.0.0.0', 8000), 'http://127.0.0.1:8000/health');
  assert.equal(buildHealthUrl('::', 8000), 'http://[::1]:8000/health');
  assert.equal(buildHealthUrl('', 9000), 'http://127.0.0.1:9000/health');
  // Must parse as a real URL (an unbracketed IPv6 host would throw here).
  assert.equal(new URL(buildHealthUrl('::1', 8123)).port, '8123');
});

// ==================================================================================================
// flushLogOutput
// ==================================================================================================

test('flushLogOutput: is a no-op when no log redirection is active', async () => {
  // Must not hang or throw when the process runs in the foreground.
  await flushLogOutput(50);
});

test('flushLogOutput: flushes buffered lines before the process exits', async () => {
  const logFile = path.join(tmpDir, 'flush.log');
  const daemonModulePath = require.resolve('../src/daemon');
  const script =
    `const { redirectOutputToLogFile, flushLogOutput } = require(${JSON.stringify(daemonModulePath)});\n` +
    `redirectOutputToLogFile(${JSON.stringify(logFile)});\n` +
    `console.log('line one');\n` +
    `console.log('line two');\n` +
    `flushLogOutput().then(() => process.exit(0));\n`;

  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  await waitForExit(child);

  const content = fs.readFileSync(logFile, 'utf8');
  assert.ok(content.includes('line one'), 'first line should be flushed');
  assert.ok(content.includes('line two'), 'last line should be flushed');
});
