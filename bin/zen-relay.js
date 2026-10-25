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
 *   - after MAX_MS regardless (safety net);
 *   - immediately (on the next quiet moment) when a local control request asks
 *     for it, which is how the OpenCode plugin reacts to a 403/429.
 *
 *   OpenCode --HTTPS_PROXY--> 127.0.0.1:10900 (this relay) --> 127.0.0.1:10901 (xray)
 *
 *   POST http://127.0.0.1:10902/rotate   retire every tunnel; idle ones close now
 *   POST http://127.0.0.1:10902/rotate?all=1  close every tunnel immediately
 *   GET  http://127.0.0.1:10902/status   current tunnel counts
 *
 * Env:
 *   ZEN_RELAY_PORT          listen port                 (default 10900)
 *   ZEN_PROXY_PORT          upstream proxy port          (default 10901)
 *   ZEN_RELAY_CONTROL_PORT  local control HTTP port      (default 10902, 0=off)
 *   ZEN_RELAY_ROTATE_MS     retire age                   (default 180000)
 *   ZEN_RELAY_SOFT_IDLE_MS  quiet period for rotation     (default 15000)
 *   ZEN_RELAY_HARD_IDLE_MS  full-silence timeout          (default 300000)
 *   ZEN_RELAY_MAX_MS        absolute connection age       (default 900000)
 *   ZEN_RELAY_RETIRE_MS     quiet period after /rotate    (default 250)
 */
'use strict';

const net = require('node:net');
const http = require('node:http');

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = Number(process.env.ZEN_RELAY_PORT || 10900);
const UP_HOST = '127.0.0.1';
const UP_PORT = Number(process.env.ZEN_PROXY_PORT || 10901);
const CONTROL_PORT = Number(process.env.ZEN_RELAY_CONTROL_PORT ?? 10902);
const ROTATE_MS = Number(process.env.ZEN_RELAY_ROTATE_MS || 180000);
const SOFT_IDLE_MS = Number(process.env.ZEN_RELAY_SOFT_IDLE_MS || 15000);
const HARD_IDLE_MS = Number(process.env.ZEN_RELAY_HARD_IDLE_MS || 300000);
const MAX_MS = Number(process.env.ZEN_RELAY_MAX_MS || 900000);
const RETIRE_MS = Number(process.env.ZEN_RELAY_RETIRE_MS || 250);
const TICK_MS = 1000;

const log = (...a) => console.log(new Date().toISOString(), '[zen-relay]', ...a);

const connections = new Set();

const server = net.createServer((client) => {
  const now = Date.now();
  const conn = { started: now, last: now, closed: false, retire: false, client, upstream: null };
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

/**
 * Retire every tunnel without cutting an in-flight stream. A quiet tunnel is
 * closed on this tick; a busy one is marked and closed once it goes quiet for
 * RETIRE_MS. With `all`, close everything regardless (used by manual tooling).
 */
const rotate = (all) => {
  const now = Date.now();
  const total = connections.size;
  let closed = 0;
  for (const conn of connections) {
    conn.retire = true;
    if (all || now - conn.last > RETIRE_MS) {
      conn.close(all ? 'rotated-request-all' : 'rotated-request');
      closed++;
    }
  }
  return { closed, retired: total, active: connections.size };
};

const ticker = setInterval(() => {
  const now = Date.now();
  for (const conn of connections) {
    const age = now - conn.started;
    const quiet = now - conn.last;
    if (quiet > HARD_IDLE_MS) conn.close('closed-idle');
    else if (age > MAX_MS) conn.close('closed-max-age');
    else if (conn.retire && quiet > RETIRE_MS) conn.close('rotated-request');
    else if (age > ROTATE_MS && quiet > SOFT_IDLE_MS) conn.close('rotated');
  }
}, TICK_MS);
ticker.unref?.();

const control = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'POST' && url.pathname === '/rotate') {
    const all = url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true';
    send(200, rotate(all));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    const now = Date.now();
    let idle = 0;
    for (const conn of connections) if (now - conn.last > RETIRE_MS) idle++;
    send(200, { active: connections.size, idle, upstream: `${UP_HOST}:${UP_PORT}` });
    return;
  }
  send(404, { error: 'not found' });
});
control.on('error', (error) => log(`control error: ${error.message}`));
control.unref?.();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`Port ${LISTEN_PORT} in use, freeing port...`);
    try {
      require('node:child_process').execFileSync('fuser', ['-k', '-9', `${LISTEN_PORT}/tcp`], { stdio: 'ignore' });
    } catch (_) {}
    setTimeout(() => server.listen(LISTEN_PORT, LISTEN_HOST), 600);
  } else {
    log('server error:', err.message);
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UP_HOST}:${UP_PORT} ` +
      `(rotate ${ROTATE_MS / 1000}s, soft-idle ${SOFT_IDLE_MS / 1000}s, ` +
      `hard-idle ${HARD_IDLE_MS / 1000}s, max ${MAX_MS / 1000}s)`);
  if (CONTROL_PORT > 0) {
    control.listen(CONTROL_PORT, LISTEN_HOST, () => {
      log(`control on http://${LISTEN_HOST}:${CONTROL_PORT} (/rotate, /status)`);
    });
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    control.close();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
