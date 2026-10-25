#!/usr/bin/env node
/**
 * zen-relay — Intelligent proxy relay with automatic 403/429 failover.
 *
 * For opencode.ai traffic:
 *   - Intercepts CONNECT tunnel using local certificate.
 *   - Inspects response status codes from opencode.ai.
 *   - When an exit IP is limited (429) or forbidden (403), it automatically
 *     switches to a fresh proxy exit from the Xray pool and retries the
 *     in-flight request transparently.
 *   - OpenCode never sees the 403/429 error and the session continues seamlessly.
 *
 * For non-opencode.ai traffic (models.dev, github.com, etc.):
 *   - Pure, uninspected byte-level transparent TCP passthrough.
 *   - Retires idle tunnels so long-lived pooled connections rotate periodically.
 *
 * Architecture:
 *   OpenCode --HTTPS_PROXY--> 127.0.0.1:10900 (this relay) --> 127.0.0.1:10901 (xray)
 */
'use strict';

const http = require('node:http');
const http2 = require('node:http2');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = Number(process.env.ZEN_RELAY_PORT || 10900);
const UP_HOST = '127.0.0.1';
const UP_PORT = Number(process.env.ZEN_PROXY_PORT || 10901);
const MAX_RETRIES = Number(process.env.ZEN_MAX_RETRIES || 15);
const ROTATE_MS = Number(process.env.ZEN_RELAY_ROTATE_MS || 180000);
const SOFT_IDLE_MS = Number(process.env.ZEN_RELAY_SOFT_IDLE_MS || 15000);
const HARD_IDLE_MS = Number(process.env.ZEN_RELAY_HARD_IDLE_MS || 300000);
const MAX_MS = Number(process.env.ZEN_RELAY_MAX_MS || 900000);
const TICK_MS = 5000;

const log = (...a) => console.log(new Date().toISOString(), '[zen-relay]', ...a);

// Ensure SSL certificates for local interception
const CERT_DIR = process.env.ZEN_CERT_DIR || path.join(os.homedir(), '.config', 'zen-proxy', 'certs');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');

function ensureCertificates() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    return {
      key: fs.readFileSync(KEY_FILE),
      cert: fs.readFileSync(CERT_FILE)
    };
  }

  log(`Generating local interception certificate in ${CERT_DIR}...`);
  fs.mkdirSync(CERT_DIR, { recursive: true });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY_FILE,
    '-out', CERT_FILE,
    '-days', '365',
    '-subj', '/CN=opencode.ai',
    '-addext', 'subjectAltName=DNS:opencode.ai,DNS:*.opencode.ai'
  ], { stdio: 'pipe' });

  return {
    key: fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE)
  };
}

const certs = ensureCertificates();

// Internal HTTPS/H2 server to process decrypted opencode.ai traffic
const interceptor = http2.createSecureServer({
  key: certs.key,
  cert: certs.cert,
  allowHTTP1: true
}, async (req, res) => {
  const reqUrl = req.url || '/';
  const reqMethod = req.method || 'GET';
  const reqPath = reqUrl.startsWith('http') ? new URL(reqUrl).pathname + new URL(reqUrl).search : reqUrl;

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const bodyBuf = Buffer.concat(chunks);

  log(`-> Client request: ${reqMethod} ${reqPath} (${bodyBuf.length} bytes)`);

  function attemptUpstream(attempt) {
    let settled = false;

    const retry = (reason) => {
      if (settled) return;
      settled = true;
      if (attempt < MAX_RETRIES) {
        log(`[attempt ${attempt}/${MAX_RETRIES}] ${reason} -> Retrying on fresh proxy exit...`);
        setTimeout(() => attemptUpstream(attempt + 1), 50);
      } else {
        log(`[attempt ${attempt}/${MAX_RETRIES}] All retries exhausted (${reason}).`);
        if (!res.headersSent) {
          res.writeHead(504, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              type: 'ProxyFailoverError',
              message: `All ${MAX_RETRIES} proxy retries failed: ${reason}`
            }
          }));
        }
      }
    };

    // Open CONNECT tunnel through upstream Xray
    const connectReq = http.request({
      host: UP_HOST,
      port: UP_PORT,
      method: 'CONNECT',
      path: 'opencode.ai:443',
      headers: { Host: 'opencode.ai:443' },
      timeout: 15000
    });

    connectReq.on('timeout', () => {
      connectReq.destroy();
      retry('Xray CONNECT timeout');
    });

    connectReq.on('error', (err) => {
      retry(`Xray CONNECT error: ${err.message}`);
    });

    connectReq.on('connect', (cRes, socket, head) => {
      if (cRes.statusCode !== 200) {
        socket.destroy();
        retry(`Xray CONNECT status ${cRes.statusCode}`);
        return;
      }

      socket.setTimeout(6500);
      socket.on('timeout', () => {
        socket.destroy();
        retry('Upstream handshake timeout (6.5s)');
      });

      const tlsSocket = tls.connect({
        socket,
        servername: 'opencode.ai',
        ALPNProtocols: ['h2', 'http/1.1']
      });

      tlsSocket.on('error', (err) => {
        retry(`TLS handshake error: ${err.message}`);
      });

      tlsSocket.on('secureConnect', () => {
        // Once connected, allow long streaming idle timeout
        socket.setTimeout(120000);
        const alpn = tlsSocket.alpnProtocol;

        if (alpn === 'h2') {
          // HTTP/2 protocol
          const h2Client = http2.connect('https://opencode.ai', {
            createConnection: () => tlsSocket
          });

          h2Client.on('error', (err) => {
            retry(`HTTP/2 connection error: ${err.message}`);
          });

          const h2Headers = {
            ':method': reqMethod,
            ':path': reqPath,
            ...Object.fromEntries(
              Object.entries(req.headers).filter(([k]) =>
                !k.startsWith(':') &&
                !['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'content-length'].includes(k.toLowerCase())
              )
            ),
            'content-length': bodyBuf.length
          };

          const h2Req = h2Client.request(h2Headers);

          h2Req.on('response', (headers) => {
            const status = Number(headers[':status'] || 200);

            // Check if exit IP is spent (429) or client/IP blocked (403)
            if ((status === 403 || status === 429) && attempt < MAX_RETRIES) {
              const bodyChunks = [];
              h2Req.on('data', (c) => bodyChunks.push(c));
              h2Req.on('end', () => {
                const errSnippet = Buffer.concat(bodyChunks).toString('utf8').slice(0, 120);
                try { h2Client.close(); } catch (_) {}
                try { socket.destroy(); } catch (_) {}
                retry(`HTTP ${status} (${errSnippet})`);
              });
              return;
            }

            settled = true;
            log(`<- Upstream responded HTTP ${status} (attempt ${attempt})`);

            const outHeaders = {};
            for (const [k, v] of Object.entries(headers)) {
              if (!k.startsWith(':')) outHeaders[k] = v;
            }

            if (!res.headersSent) {
              res.writeHead(status, outHeaders);
            }
            h2Req.pipe(res);
          });

          h2Req.on('error', (err) => {
            retry(`HTTP/2 stream error: ${err.message}`);
          });

          if (bodyBuf.length > 0) h2Req.write(bodyBuf);
          h2Req.end();

        } else {
          // HTTP/1.1 fallback
          const h1Req = https.request({
            host: 'opencode.ai',
            path: reqPath,
            method: reqMethod,
            createConnection: () => tlsSocket,
            headers: {
              ...req.headers,
              host: 'opencode.ai',
              'content-length': bodyBuf.length
            }
          }, (h1Res) => {
            const status = h1Res.statusCode || 200;
            if ((status === 403 || status === 429) && attempt < MAX_RETRIES) {
              const bodyChunks = [];
              h1Res.on('data', (c) => bodyChunks.push(c));
              h1Res.on('end', () => {
                const errSnippet = Buffer.concat(bodyChunks).toString('utf8').slice(0, 120);
                try { socket.destroy(); } catch (_) {}
                retry(`HTTP/1.1 ${status} (${errSnippet})`);
              });
              return;
            }

            settled = true;
            log(`<- Upstream HTTP/1.1 responded ${status} (attempt ${attempt})`);
            if (!res.headersSent) {
              res.writeHead(status, h1Res.headers);
            }
            h1Res.pipe(res);
          });

          h1Req.on('error', (err) => {
            retry(`HTTP/1.1 request error: ${err.message}`);
          });

          if (bodyBuf.length > 0) h1Req.write(bodyBuf);
          h1Req.end();
        }
      });
    });

    connectReq.end();
  }

  attemptUpstream(1);
});

// Main proxy server
const rawConnections = new Set();

const server = http.createServer();

server.on('connect', (req, clientSocket, head) => {
  const target = req.url || '';
  const isOpencodeAi = target.startsWith('opencode.ai') || target.includes('.opencode.ai');

  if (isOpencodeAi) {
    // Intercept opencode.ai to provide 403/429 failover
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    interceptor.emit('connection', clientSocket);
  } else {
    // Blind TCP passthrough for other domains
    const conn = { started: Date.now(), last: Date.now(), closed: false, client: clientSocket, upstream: null };
    conn.upstream = net.connect(UP_PORT, UP_HOST);
    rawConnections.add(conn);

    const close = (why) => {
      if (conn.closed) return;
      conn.closed = true;
      rawConnections.delete(conn);
      conn.client.destroy();
      conn.upstream.destroy();
      log(`${why} [${target}] after ${Math.round((Date.now() - conn.started) / 1000)}s`);
    };
    conn.close = close;

    let tunnelEstablished = false;
    let upBuf = Buffer.alloc(0);

    conn.upstream.on('connect', () => {
      // Forward CONNECT request to upstream HTTP proxy
      conn.upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });

    conn.upstream.on('data', (d) => {
      conn.last = Date.now();
      if (!tunnelEstablished) {
        upBuf = Buffer.concat([upBuf, d]);
        const idx = upBuf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          tunnelEstablished = true;
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          const remainder = upBuf.subarray(idx + 4);
          if (remainder.length > 0) clientSocket.write(remainder);
        }
      } else {
        clientSocket.write(d);
      }
    });

    clientSocket.on('data', (d) => {
      conn.last = Date.now();
      if (tunnelEstablished) {
        conn.upstream.write(d);
      }
    });
    clientSocket.on('error', () => close('client-error'));
    conn.upstream.on('error', () => close('upstream-error'));
    clientSocket.on('close', () => close('client-close'));
    conn.upstream.on('close', () => close('upstream-close'));
  }
});

// Periodic idle connection cleanup for raw connections
const ticker = setInterval(() => {
  const now = Date.now();
  for (const conn of rawConnections) {
    const age = now - conn.started;
    const quiet = now - conn.last;
    if (quiet > HARD_IDLE_MS) conn.close('closed-idle');
    else if (age > MAX_MS) conn.close('closed-max-age');
    else if (age > ROTATE_MS && quiet > SOFT_IDLE_MS) conn.close('rotated');
  }
}, TICK_MS);
ticker.unref?.();

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`Listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UP_HOST}:${UP_PORT}`);
  log(`Interception enabled for opencode.ai with max ${MAX_RETRIES} automatic failover retries.`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`Received ${sig}, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
