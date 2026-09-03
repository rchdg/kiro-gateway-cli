'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const { EventEmitter } = require('node:events');

const undici = require('undici');

const {
  getProxyDispatcher,
  buildProxyDispatcher,
  buildSocksConnect,
  resolveSocksPort,
} = require('../src/httpClient');

/**
 * Fake TLS socket for unit tests: an EventEmitter with destroy() semantics.
 *
 * @class
 */
class FakeTlsSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
  }

  /**
   * Marks the socket destroyed, re-emitting errors like net.Socket.
   *
   * @param {Error} [err] - Optional error to emit
   */
  destroy(err) {
    this.destroyed = true;
    if (err) this.emit('error', err);
  }
}

/**
 * Invokes an undici connect function and resolves with its callback result.
 *
 * @param {Function} connectFn - Custom connector (opts, callback)
 * @param {object} opts - Connect options
 * @returns {Promise<{err: Error|null, socket: object|undefined}>}
 */
function invokeConnect(connectFn, opts) {
  return new Promise((resolve) => {
    connectFn(opts, (err, socket) => resolve({ err, socket }));
  });
}

// ==================================================================================================
// Minimal SOCKS5 server for integration tests (no external dependency)
// ==================================================================================================

/**
 * Creates a minimal SOCKS5 (no-auth) server for testing.
 *
 * Supports IPv4, IPv6 and domain (remote DNS) destination addresses and
 * reports every CONNECT request via the onRequest callback.
 *
 * @param {Function} [onRequest] - Called with { host, port, atyp } per CONNECT
 * @returns {import('node:net').Server} The SOCKS5 server
 */
function createSocks5Server({ onRequest } = {}) {
  const server = net.createServer((clientSocket) => {
    let buffer = Buffer.alloc(0);
    let state = 'greeting';

    clientSocket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        for (;;) {
          if (state === 'greeting') {
            if (buffer.length < 2) return;
            const nmethods = buffer[1];
            if (buffer.length < 2 + nmethods) return;
            buffer = buffer.subarray(2 + nmethods);
            clientSocket.write(Buffer.from([0x05, 0x00]));
            state = 'request';
          } else if (state === 'request') {
            if (buffer.length < 4) return;
            if (buffer[1] !== 0x01) {
              // Only CONNECT is supported
              clientSocket.destroy();
              return;
            }
            const atyp = buffer[3];
            let addrLen;
            if (atyp === 0x01) {
              addrLen = 4;
            } else if (atyp === 0x03) {
              if (buffer.length < 5) return;
              addrLen = 1 + buffer[4];
            } else if (atyp === 0x04) {
              addrLen = 16;
            } else {
              clientSocket.destroy();
              return;
            }
            if (buffer.length < 4 + addrLen + 2) return;

            let offset = 4;
            let host;
            if (atyp === 0x01) {
              host = [...buffer.subarray(offset, offset + 4)].join('.');
              offset += 4;
            } else if (atyp === 0x03) {
              const len = buffer[offset];
              offset += 1;
              host = buffer.subarray(offset, offset + len).toString();
              offset += len;
            } else {
              // atyp 0x04: expand the 16 address bytes into an IPv6 literal
              const groups = [];
              for (let i = 0; i < 16; i += 2) {
                groups.push(buffer.subarray(offset + i, offset + i + 2).toString('hex'));
              }
              host = groups.join(':');
              offset += 16;
            }
            const port = buffer.readUInt16BE(offset);
            buffer = buffer.subarray(offset + 2);
            state = 'relay';

            if (onRequest) onRequest({ host, port, atyp });

            dns.lookup(host, (err, address) => {
              if (err) {
                writeReply(clientSocket, 0x04);
                clientSocket.destroy();
                return;
              }
              const dest = net.connect(port, address, () => {
                writeReply(clientSocket, 0x00);
                clientSocket.pipe(dest);
                dest.pipe(clientSocket);
              });
              dest.on('error', () => {
                writeReply(clientSocket, 0x05);
                clientSocket.destroy();
              });
            });
            return;
          }
          // Relay state: connection is established, further data is forwarded
          // by the pipes set up in the request handler. Ignore it here to
          // avoid spinning the state machine.
          return;
        }
      } catch {
        clientSocket.destroy();
      }
    });
  });
  return server;
}

/**
 * Writes a SOCKS5 reply header.
 *
 * @param {import('node:net').Socket} socket - Client socket
 * @param {number} rep - Reply code (0 = success)
 */
function writeReply(socket, rep) {
  const reply = Buffer.alloc(10);
  reply[0] = 0x05;
  reply[1] = rep;
  reply[2] = 0x00;
  reply[3] = 0x01;
  reply.writeUInt32BE(0x7f000001, 4);
  reply.writeUInt16BE(0, 8);
  socket.write(reply);
}

/**
 * Starts a server and resolves once it is listening.
 *
 * Binds without a host so the socket is dual-stack: destination hostnames
 * such as 'localhost' may resolve to ::1 or 127.0.0.1 depending on the
 * platform resolver order, and both must reach the server.
 *
 * @param {import('node:net').Server} server - Server to start
 * @returns {Promise<number>} The bound port
 */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve(server.address().port));
  });
}

/**
 * Stops a server and resolves once it is closed.
 *
 * @param {import('node:net').Server} server - Server to close
 * @returns {Promise<void>}
 */
function close(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

// ==================================================================================================
// buildProxyDispatcher - unit tests
// ==================================================================================================

test('buildProxyDispatcher: returns null for an empty proxy URL', () => {
  assert.equal(buildProxyDispatcher(''), null);
  assert.equal(buildProxyDispatcher(null), null);
});

test('buildProxyDispatcher: returns null for an invalid proxy URL', () => {
  assert.equal(buildProxyDispatcher('not a url at all'), null);
  assert.equal(buildProxyDispatcher('http://[::1'), null);
});

test('buildProxyDispatcher: returns a ProxyAgent for HTTP proxy URLs', () => {
  const agent = buildProxyDispatcher('http://127.0.0.1:7890');
  assert.ok(agent instanceof undici.ProxyAgent);
});

test('buildProxyDispatcher: returns a ProxyAgent for HTTPS proxy URLs', () => {
  const agent = buildProxyDispatcher('https://user:pass@proxy.example.com:8080');
  assert.ok(agent instanceof undici.ProxyAgent);
});

test('buildProxyDispatcher: returns an undici Agent for every SOCKS scheme', () => {
  for (const scheme of ['socks', 'socks4', 'socks4a', 'socks5', 'socks5h']) {
    const agent = buildProxyDispatcher(`${scheme}://127.0.0.1:1080`);
    assert.ok(agent instanceof undici.Agent, `${scheme} should build an undici Agent`);
  }
});

test('buildProxyDispatcher: returns null for an unsupported scheme', () => {
  assert.equal(buildProxyDispatcher('ftp://127.0.0.1:21'), null);
});

test('getProxyDispatcher: returns null when no proxy is configured', () => {
  assert.equal(getProxyDispatcher(''), null);
  assert.equal(getProxyDispatcher(undefined), null);
});

test('getProxyDispatcher: bare host:port defaults to HTTP', () => {
  const agent = getProxyDispatcher('127.0.0.1:7890');
  assert.ok(agent instanceof undici.ProxyAgent);
});

test('getProxyDispatcher: caches the dispatcher per proxy URL', () => {
  const first = getProxyDispatcher('socks5://127.0.0.1:1080');
  const second = getProxyDispatcher('socks5://127.0.0.1:1080');
  assert.ok(first instanceof undici.Agent);
  assert.equal(first, second);

  const other = getProxyDispatcher('socks5://127.0.0.1:1081');
  assert.notEqual(first, other);
});

test('resolveSocksPort: defaults to the protocol port when undici passes null', () => {
  assert.equal(resolveSocksPort('https:', null), 443);
  assert.equal(resolveSocksPort('http:', null), 80);
});

test('resolveSocksPort: keeps an explicit port', () => {
  assert.equal(resolveSocksPort('https:', 8443), 8443);
  assert.equal(resolveSocksPort('http:', 8080), 8080);
  assert.equal(resolveSocksPort('https:', 0), 443);
});

// ==================================================================================================
// SOCKS integration tests (local SOCKS5 server + local origin server)
// ==================================================================================================

test('SOCKS5h: requests tunnel through the proxy with remote DNS', async () => {
  const requests = [];
  const socksServer = createSocks5Server({ onRequest: (r) => requests.push(r) });
  const socksPort = await listen(socksServer);

  const originServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('origin-ok');
  });
  const originPort = await listen(originServer);

  const dispatcher = getProxyDispatcher(`socks5h://127.0.0.1:${socksPort}`);
  try {
    const response = await undici.request(`http://localhost:${originPort}/`, {
      dispatcher,
    });
    const body = await response.body.text();
    assert.equal(response.statusCode, 200);
    assert.equal(body, 'origin-ok');
  } finally {
    await dispatcher.destroy();
    await close(socksServer);
    await close(originServer);
  }

  // socks5h performs proxy-side DNS: the proxy receives the hostname, not an IP.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].host, 'localhost');
  assert.equal(requests[0].atyp, 0x03);
});

test('SOCKS5: requests tunnel through the proxy with local DNS', async () => {
  const requests = [];
  const socksServer = createSocks5Server({ onRequest: (r) => requests.push(r) });
  const socksPort = await listen(socksServer);

  const originServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('origin-ok');
  });
  const originPort = await listen(originServer);

  const dispatcher = getProxyDispatcher(`socks5://127.0.0.1:${socksPort}`);
  try {
    const response = await undici.request(`http://localhost:${originPort}/`, {
      dispatcher,
    });
    const body = await response.body.text();
    assert.equal(response.statusCode, 200);
    assert.equal(body, 'origin-ok');
  } finally {
    await dispatcher.destroy();
    await close(socksServer);
    await close(originServer);
  }

  // socks5 performs client-side DNS: the proxy receives a resolved IP
  // address (v4 or v6, depending on the local resolver order), not the
  // hostname.
  assert.equal(requests.length, 1);
  assert.ok(requests[0].atyp === 0x01 || requests[0].atyp === 0x04);
  assert.notEqual(requests[0].host, 'localhost');
  assert.match(requests[0].host, /^[0-9a-f:.]+$/);
});

test('SOCKS5h: unreachable destination surfaces a network error', async () => {
  const socksServer = createSocks5Server();
  const socksPort = await listen(socksServer);

  const dispatcher = getProxyDispatcher(`socks5h://127.0.0.1:${socksPort}`);
  try {
    await assert.rejects(
      () => undici.request('http://localhost:1/', { dispatcher, connectTimeout: 2000 }),
      (err) => {
        // Any network-level failure is acceptable - the key is that the
        // request does not hang and does not succeed.
        assert.ok(err);
        return true;
      }
    );
  } finally {
    await dispatcher.destroy();
    await close(socksServer);
  }
});

/**
 * Emits a socket event on the next tick, after the connect function's
 * promise chain has attached its listeners.
 *
 * @param {EventEmitter} socket - Fake socket
 * @param {string} event - Event name
 * @param {*} [arg] - Event payload
 * @returns {Promise<void>}
 */
function emitOnNextTick(socket, event, arg) {
  return new Promise((resolve) => setImmediate(() => {
    socket.emit(event, arg);
    resolve();
  }));
}

// ==================================================================================================
// buildSocksConnect - TLS wiring unit tests
// ==================================================================================================

test('buildSocksConnect: HTTPS falls back to the hostname when servername is null', async () => {
  let receivedOpts = null;
  const socket = new FakeTlsSocket();
  const agent = {
    connect: async (req, opts) => {
      receivedOpts = opts;
      return socket;
    },
  };

  const connect = buildSocksConnect(agent);
  const pending = invokeConnect(connect, {
    hostname: 'runtime.us-east-1.kiro.dev',
    host: 'runtime.us-east-1.kiro.dev',
    protocol: 'https:',
    port: null,
    servername: null,
    localAddress: null,
  });
  await emitOnNextTick(socket, 'secureConnect');

  const { err, socket: resolved } = await pending;
  assert.equal(err, null);
  assert.equal(resolved, socket);
  // The fix: servername must be the real host, not null, or TLS verification
  // runs against the socket default and fails with ERR_TLS_CERT_ALTNAME_INVALID.
  assert.equal(receivedOpts.servername, 'runtime.us-east-1.kiro.dev');
  assert.equal(receivedOpts.secureEndpoint, true);
  assert.equal(receivedOpts.port, 443);
  assert.equal(receivedOpts.host, 'runtime.us-east-1.kiro.dev');
});

test('buildSocksConnect: HTTPS keeps an explicit servername', async () => {
  let receivedOpts = null;
  const socket = new FakeTlsSocket();
  const agent = {
    connect: async (req, opts) => {
      receivedOpts = opts;
      return socket;
    },
  };

  const connect = buildSocksConnect(agent);
  const pending = invokeConnect(connect, {
    hostname: 'api.example.com',
    host: 'api.example.com',
    protocol: 'https:',
    port: 443,
    servername: 'api.example.com',
  });
  await emitOnNextTick(socket, 'secureConnect');

  const { err } = await pending;
  assert.equal(err, null);
  assert.equal(receivedOpts.servername, 'api.example.com');
});

test('buildSocksConnect: TLS handshake errors surface through the callback, not a crash', async () => {
  const socket = new FakeTlsSocket();
  const agent = { connect: async () => socket };

  const connect = buildSocksConnect(agent);
  const pending = invokeConnect(connect, {
    hostname: 'api.example.com',
    host: 'api.example.com',
    protocol: 'https:',
    port: 443,
    servername: null,
  });

  const tlsErr = new Error("Hostname/IP does not match certificate's altnames");
  tlsErr.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
  await emitOnNextTick(socket, 'error', tlsErr);

  const { err, socket: resolved } = await pending;
  assert.equal(err, tlsErr);
  assert.equal(resolved, undefined);
  assert.equal(socket.destroyed, true);
});

test('buildSocksConnect: stalled TLS handshake times out', async () => {
  const socket = new FakeTlsSocket();
  const agent = { connect: async () => socket };

  const connect = buildSocksConnect(agent, 30);
  const { err, socket: resolved } = await invokeConnect(connect, {
    hostname: 'api.example.com',
    host: 'api.example.com',
    protocol: 'https:',
    port: 443,
    servername: null,
  });

  assert.equal(err.code, 'UND_ERR_CONNECT_TIMEOUT');
  assert.match(err.message, /TLS handshake timed out/);
  assert.equal(resolved, undefined);
  assert.equal(socket.destroyed, true);
});

test('buildSocksConnect: removes its TLS listeners after secureConnect', async () => {
  const socket = new FakeTlsSocket();
  const agent = { connect: async () => socket };

  const connect = buildSocksConnect(agent);
  const pending = invokeConnect(connect, {
    hostname: 'api.example.com',
    host: 'api.example.com',
    protocol: 'https:',
    port: 443,
    servername: 'api.example.com',
  });
  await emitOnNextTick(socket, 'secureConnect');
  await pending;

  // Post-connect socket errors must reach undici, not our handshake handler.
  assert.equal(socket.listenerCount('error'), 0);
});

test('buildSocksConnect: HTTP connects immediately without a servername', async () => {
  let receivedOpts = null;
  const socket = new FakeTlsSocket();
  const agent = {
    connect: async (req, opts) => {
      receivedOpts = opts;
      return socket;
    },
  };

  const connect = buildSocksConnect(agent);
  const { err, socket: resolved } = await invokeConnect(connect, {
    hostname: 'localhost',
    host: 'localhost',
    protocol: 'http:',
    port: 8080,
    servername: null,
  });

  assert.equal(err, null);
  assert.equal(resolved, socket);
  assert.equal(receivedOpts.secureEndpoint, false);
  assert.equal(receivedOpts.servername, undefined);
  assert.equal(receivedOpts.port, 8080);
});

test('buildSocksConnect: agent rejection surfaces through the callback', async () => {
  const agent = {
    connect: async () => {
      throw new Error('socks handshake failed');
    },
  };

  const connect = buildSocksConnect(agent);
  const { err } = await invokeConnect(connect, {
    hostname: 'localhost',
    host: 'localhost',
    protocol: 'http:',
    port: 80,
  });

  assert.equal(err.message, 'socks handshake failed');
});

test('buildSocksConnect: retries the tunnel once on transient failure', async () => {
  let attempts = 0;
  const socket = new FakeTlsSocket();
  const agent = {
    connect: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('socks proxy timed out');
      }
      return socket;
    },
  };

  const connect = buildSocksConnect(agent);
  const { err, socket: resolved } = await invokeConnect(connect, {
    hostname: 'localhost',
    host: 'localhost',
    protocol: 'http:',
    port: 80,
  });

  assert.equal(err, null);
  assert.equal(resolved, socket);
  assert.equal(attempts, 2);
});
