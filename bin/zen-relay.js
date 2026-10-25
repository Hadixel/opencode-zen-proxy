#!/usr/bin/env node
/**
 * zen-relay — transparent TCP relay in front of the proxy, with tunnel rotation.
 *
 * Why: OpenCode (Bun) keeps pooled CONNECT tunnels to the proxy, and the proxy
 * picks an upstream exit once per tunnel. A tunnel pinned to an exit whose free
 * allowance is spent makes *every* request return 429 until the tunnel dies.
 *
 * This relay is byte transparent (no TLS termination — the client fingerprint
 * stays OpenCode's, which Zen requires), and retires tunnels:
 *
 *   - after ROTATE_MS of age, but only when the tunnel has been quiet for
 *     SOFT_IDLE_MS, so an in-flight stream is never cut;
 *   - after HARD_IDLE_MS of complete silence;
 *   - after MAX_MS regardless (safety net).
 *
 *   OpenCode --HTTPS_PROXY--> 127.0.0.1:10900 (this relay) --> 127.0.0.1:10901 (xray)
 *
 * Env:
 *   ZEN_RELAY_PORT     listen port                 (default 10900)
 *   ZEN_PROXY_PORT     upstream proxy port          (default 10901)
 *   ZEN_RELAY_ROTATE_MS retire age                  (default 180000)
 *   ZEN_RELAY_SOFT_IDLE_MS quiet period for rotation(default 15000)
 *   ZEN_RELAY_HARD_IDLE_MS full-silence timeout     (default 300000)
 *   ZEN_RELAY_MAX_MS   absolute connection age      (default 900000)
 */
'use strict';

const net = require('node:net');

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = Number(process.env.ZEN_RELAY_PORT || 10900);
const UP_HOST = '127.0.0.1';
const UP_PORT = Number(process.env.ZEN_PROXY_PORT || 10901);
const ROTATE_MS = Number(process.env.ZEN_RELAY_ROTATE_MS || 180000);
const SOFT_IDLE_MS = Number(process.env.ZEN_RELAY_SOFT_IDLE_MS || 15000);
const HARD_IDLE_MS = Number(process.env.ZEN_RELAY_HARD_IDLE_MS || 300000);
const MAX_MS = Number(process.env.ZEN_RELAY_MAX_MS || 900000);
const TICK_MS = 5000;

const log = (...a) => console.log(new Date().toISOString(), '[zen-relay]', ...a);

const connections = new Set();

const server = net.createServer((client) => {
  const conn = { started: Date.now(), last: Date.now(), closed: false, client, upstream: null };
  conn.upstream = net.connect(UP_PORT, UP_HOST);
  connections.add(conn);

  const close = (why) => {
    if (conn.closed) return;
    conn.closed = true;
    connections.delete(conn);
    conn.client.destroy();
    conn.upstream.destroy();
    log(`${why} after ${Math.round((Date.now() - conn.started) / 1000)}s`);
  };
  conn.close = close;

  client.on('data', (d) => { conn.last = Date.now(); conn.upstream.write(d); });
  conn.upstream.on('data', (d) => { conn.last = Date.now(); conn.client.write(d); });
  client.on('error', () => close('client-error'));
  conn.upstream.on('error', () => close('upstream-error'));
  client.on('close', () => close('client-close'));
  conn.upstream.on('close', () => close('upstream-close'));
  conn.upstream.on('connect', () => log('open'));
});

const ticker = setInterval(() => {
  const now = Date.now();
  for (const conn of connections) {
    const age = now - conn.started;
    const quiet = now - conn.last;
    if (quiet > HARD_IDLE_MS) conn.close('closed-idle');
    else if (age > MAX_MS) conn.close('closed-max-age');
    else if (age > ROTATE_MS && quiet > SOFT_IDLE_MS) conn.close('rotated');
  }
}, TICK_MS);
ticker.unref?.();

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UP_HOST}:${UP_PORT} ` +
      `(rotate ${ROTATE_MS / 1000}s, soft-idle ${SOFT_IDLE_MS / 1000}s, ` +
      `hard-idle ${HARD_IDLE_MS / 1000}s, max ${MAX_MS / 1000}s)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
