#!/usr/bin/env node
/**
 * zen-scrape.js — Scrapes public GitHub repositories for free Xray/V2Ray nodes,
 * parses and validates them, and generates ~/.config/zen-proxy/zen.json.
 *
 * Supported protocols: VLESS (Reality, TLS, WS, gRPC), Trojan (TLS, WS)
 *
 * Usage:
 *   node bin/zen-scrape.js
 *   node bin/zen-scrape.js --max 25 --output ~/.config/zen-proxy/zen.json
 *   node bin/zen-scrape.js --skip-test
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

const DEFAULT_SOURCES = [
  'https://raw.githubusercontent.com/barry-far/V2ray-config/main/Splitted-By-Protocol/vless.txt',
  'https://raw.githubusercontent.com/barry-far/V2ray-config/main/Splitted-By-Protocol/trojan.txt',
  'https://raw.githubusercontent.com/sevcator/5ubscrpt10n/main/protocols/vl.txt',
  'https://raw.githubusercontent.com/sevcator/5ubscrpt10n/main/protocols/tr.txt',
  'https://raw.githubusercontent.com/yebekhe/TelegramV2rayCollector/main/sub/normal/mix',
  'https://raw.githubusercontent.com/yebekhe/TelegramV2rayCollector/main/sub/base64/mix',
  'https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt'
];

// Parse CLI args
const args = process.argv.slice(2);
let outputFile = path.join(os.homedir(), '.config', 'zen-proxy', 'zen.json');
let maxNodes = 30;
let testNodes = true;
let pingTimeoutMs = 2000;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' || args[i] === '-o') {
    outputFile = args[++i];
  } else if (args[i] === '--max' || args[i] === '-m') {
    maxNodes = parseInt(args[++i], 10) || 30;
  } else if (args[i] === '--skip-test') {
    testNodes = false;
  } else if (args[i] === '--timeout') {
    pingTimeoutMs = parseInt(args[++i], 10) || 2000;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`Usage: zen-scrape.js [options]
Options:
  --output, -o <file>   Output Xray JSON config (default: ~/.config/zen-proxy/zen.json)
  --max, -m <n>         Maximum active nodes to include (default: 30)
  --skip-test           Skip TCP connectivity pre-check
  --timeout <ms>        TCP test timeout in ms (default: 2000)
`);
    process.exit(0);
  }
}

async function fetchUrl(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'v2rayN/6.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeContent(raw) {
  const lines = [];
  const trimmed = raw.trim();
  // Check if entire content is base64
  if (!trimmed.includes('\n') && /^[A-Za-z0-9+/=]+$/.test(trimmed)) {
    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
      return decoded.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    } catch (_) {}
  }

  for (let line of trimmed.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    // Some lines might be individual base64 strings
    if (!line.includes('://') && /^[A-Za-z0-9+/=]{20,}$/.test(line)) {
      try {
        const decoded = Buffer.from(line, 'base64').toString('utf8');
        lines.push(...decoded.split(/\r?\n/).map(l => l.trim()).filter(Boolean));
        continue;
      } catch (_) {}
    }
    lines.push(line);
  }
  return lines;
}

function parseProxyUri(uri, tag) {
  try {
    const url = new URL(uri.trim());
    const protocol = url.protocol.replace(':', '').toLowerCase();
    const id = decodeURIComponent(url.username || '');
    const address = url.hostname;
    const port = parseInt(url.port, 10);
    const searchParams = url.searchParams;
    const remark = decodeURIComponent(url.hash ? url.hash.slice(1) : `${protocol}-${address}:${port}`);

    if (!address || !port || isNaN(port)) return null;

    if (protocol === 'vless') {
      if (!id) return null;
      const security = (searchParams.get('security') || 'none').toLowerCase();
      // Modern Xray prohibits plain VLESS without TLS or Reality
      if (security !== 'tls' && security !== 'reality') return null;

      const type = (searchParams.get('type') || 'tcp').toLowerCase();
      const flow = searchParams.get('flow') || '';
      const sni = searchParams.get('sni') || '';
      const pbk = searchParams.get('pbk') || '';
      const sid = searchParams.get('sid') || '';
      const fp = searchParams.get('fp') || 'chrome';
      const pathStr = searchParams.get('path') || '';
      const host = searchParams.get('host') || '';
      const serviceName = searchParams.get('serviceName') || '';

      const outbound = {
        tag,
        protocol: 'vless',
        settings: {
          vnext: [{
            address,
            port,
            users: [{
              id,
              encryption: searchParams.get('encryption') || 'none',
              flow: flow || undefined,
            }]
          }]
        },
        streamSettings: {
          network: type,
          security: security,
        }
      };

      if (security === 'tls') {
        outbound.streamSettings.tlsSettings = {
          serverName: sni || address,
          fingerprint: fp,
          allowInsecure: searchParams.get('allowInsecure') === '1',
        };
      } else if (security === 'reality') {
        outbound.streamSettings.realitySettings = {
          serverName: sni || address,
          fingerprint: fp,
          publicKey: pbk,
          shortId: sid,
          spiderX: searchParams.get('spx') || '/',
        };
      }

      if (type === 'ws') {
        outbound.streamSettings.wsSettings = {
          path: pathStr || '/',
          host: host || undefined,
        };
      } else if (type === 'grpc') {
        outbound.streamSettings.grpcSettings = {
          serviceName: serviceName,
        };
      }

      return { remark, address, port, outbound };
    } else if (protocol === 'trojan') {
      const password = id || decodeURIComponent(url.password || '');
      if (!password) return null;
      const security = (searchParams.get('security') || 'tls').toLowerCase();
      const type = (searchParams.get('type') || 'tcp').toLowerCase();
      const sni = searchParams.get('sni') || '';
      const pathStr = searchParams.get('path') || '';
      const host = searchParams.get('host') || '';

      const outbound = {
        tag,
        protocol: 'trojan',
        settings: {
          servers: [{
            address,
            port,
            password,
          }]
        },
        streamSettings: {
          network: type,
          security: security,
        }
      };

      if (security === 'tls') {
        outbound.streamSettings.tlsSettings = {
          serverName: sni || address,
          allowInsecure: searchParams.get('allowInsecure') === '1',
        };
      }

      if (type === 'ws') {
        outbound.streamSettings.wsSettings = {
          path: pathStr || '/',
          host: host || undefined,
        };
      }

      return { remark, address, port, outbound };
    }
  } catch (_) {
    return null;
  }
  return null;
}

function testTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let settled = false;
    const start = Date.now();
    const finish = (latency) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve(latency);
    };

    s.setTimeout(timeoutMs);
    s.on('connect', () => finish(Date.now() - start));
    s.on('timeout', () => finish(null));
    s.on('error', () => finish(null));
    s.connect(port, host);
  });
}

function buildXrayConfig(outbounds) {
  const outboundTags = outbounds.map(o => o.tag);

  return {
    log: {
      loglevel: "warning"
    },
    dns: {
      servers: [
        "1.1.1.1",
        "8.8.8.8",
        "localhost"
      ]
    },
    inbounds: [
      {
        listen: "127.0.0.1",
        port: 10901,
        protocol: "mixed",
        settings: {
          auth: "noauth",
          udp: true
        },
        sniffing: {
          enabled: true,
          destOverride: ["http", "tls"],
          routeOnly: true
        },
        tag: "mixed-in"
      }
    ],
    outbounds: [
      ...outbounds,
      {
        tag: "direct",
        protocol: "freedom"
      },
      {
        tag: "block",
        protocol: "blackhole"
      }
    ],
    routing: {
      domainStrategy: "AsIs",
      balancers: [
        {
          tag: "zenbal",
          selector: outboundTags,
          strategy: {
            type: "leastLoad",
            settings: {
              expected: 2,
              maxRTT: "5s",
              tolerance: 0.5
            }
          }
        }
      ],
      rules: [
        {
          type: "field",
          network: "tcp",
          balancerTag: "zenbal"
        }
      ]
    },
    burstObservatory: {
      subjectSelector: outboundTags,
      pingConfig: {
        destination: "https://connectivitycheck.gstatic.com/generate_204",
        httpMethod: "HEAD",
        interval: "2m",
        sampling: 1,
        timeout: "4s"
      }
    }
  };
}

function findXrayBin() {
  const candidates = [
    process.env.XRAY,
    'xray',
    path.join(os.homedir(), '.local', 'share', 'v2rayN', 'bin', 'xray', 'xray'),
    path.join(os.homedir(), '.local', 'bin', 'xray'),
    '/usr/local/bin/xray',
    '/usr/bin/xray'
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore' });
      return c;
    } catch (_) {}
  }
  return null;
}

async function main() {
  console.log('[zen-scrape] Starting public Xray proxy scraper...');
  console.log(`[zen-scrape] Sources: ${DEFAULT_SOURCES.length} GitHub repositories`);

  const rawLines = new Set();
  for (const src of DEFAULT_SOURCES) {
    try {
      process.stdout.write(`[zen-scrape] Fetching ${src.split('/').slice(3, 5).join('/')}... `);
      const text = await fetchUrl(src);
      const lines = decodeContent(text);
      let count = 0;
      for (const line of lines) {
        if (line.startsWith('vless://') || line.startsWith('trojan://')) {
          rawLines.add(line);
          count++;
        }
      }
      console.log(`OK (${count} nodes)`);
    } catch (e) {
      console.log(`FAILED (${e.message})`);
    }
  }

  console.log(`[zen-scrape] Total raw candidate URIs collected: ${rawLines.size}`);

  const candidates = [];
  const seenEndpoints = new Set();
  let tagIdx = 1;

  // Import from local v2rayN configs if present
  const localGuiDir = path.join(os.homedir(), '.local', 'share', 'v2rayN', 'guiConfigs');
  if (fs.existsSync(localGuiDir)) {
    try {
      const files = fs.readdirSync(localGuiDir).filter(f => f.endsWith('.json'));
      let localCount = 0;
      for (const f of files) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(localGuiDir, f), 'utf8'));
          const outbounds = content.outbounds || [];
          for (const ob of outbounds) {
            if (['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria'].includes(ob.protocol)) {
              if (ob.protocol === 'vless') {
                const sec = ob.streamSettings?.security;
                if (sec !== 'tls' && sec !== 'reality') continue;
              }
              let addr = '';
              let port = 443;
              if (ob.settings?.vnext?.[0]) {
                addr = ob.settings.vnext[0].address;
                port = ob.settings.vnext[0].port;
              } else if (ob.settings?.servers?.[0]) {
                addr = ob.settings.servers[0].address;
                port = ob.settings.servers[0].port;
              } else if (ob.settings?.address && ob.settings?.port) {
                addr = ob.settings.address;
                port = ob.settings.port;
              }
              if (addr && port) {
                const ep = `${addr}:${port}`;
                if (!seenEndpoints.has(ep)) {
                  seenEndpoints.add(ep);
                  const cloned = JSON.parse(JSON.stringify(ob));
                  cloned.tag = `s${tagIdx}`;
                  candidates.push({
                    remark: content.remarks || cloned.tag,
                    address: addr,
                    port,
                    outbound: cloned,
                    isLocal: true
                  });
                  tagIdx++;
                  localCount++;
                }
              }
            }
          }
        } catch (_) {}
      }
      if (localCount > 0) {
        console.log(`[zen-scrape] Imported ${localCount} existing profiles from ${localGuiDir}`);
      }
    } catch (_) {}
  }

  for (const uri of rawLines) {
    const parsed = parseProxyUri(uri, `s${tagIdx}`);
    if (!parsed) continue;

    const endpoint = `${parsed.address}:${parsed.port}`;
    if (seenEndpoints.has(endpoint)) continue;
    seenEndpoints.add(endpoint);

    candidates.push(parsed);
    tagIdx++;
  }

  // Prioritize Reality and local verified configs
  candidates.sort((a, b) => {
    const aScore = (a.isLocal ? 10 : 0) + (a.outbound.streamSettings?.security === 'reality' ? 5 : 0);
    const bScore = (b.isLocal ? 10 : 0) + (b.outbound.streamSettings?.security === 'reality' ? 5 : 0);
    return bScore - aScore;
  });

  console.log(`[zen-scrape] Unique parsed valid proxies: ${candidates.length}`);
  if (candidates.length === 0) {
    console.error('[zen-scrape] Error: No valid proxies could be extracted.');
    process.exit(1);
  }

  let selectedOutbounds = [];
  if (testNodes) {
    console.log(`[zen-scrape] Testing connectivity (concurrency 20, timeout ${pingTimeoutMs}ms)...`);
    const activeNodes = [];
    const pool = [...candidates];
    const CONCURRENCY = 20;

    async function worker() {
      while (pool.length > 0 && activeNodes.length < maxNodes * 2) {
        const item = pool.shift();
        if (!item) break;
        const latency = await testTcp(item.address, item.port, pingTimeoutMs);
        if (latency !== null) {
          item.latency = latency;
          activeNodes.push(item);
          process.stdout.write(`\r[zen-scrape] Verified live nodes: ${activeNodes.length}/${maxNodes} (last ping: ${latency}ms) `);
        }
      }
    }

    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);
    console.log('');

    if (activeNodes.length === 0) {
      console.log('[zen-scrape] Warning: No nodes responded to TCP ping. Using top parsed nodes.');
      selectedOutbounds = candidates.slice(0, maxNodes).map((c, i) => {
        c.outbound.tag = `s${i + 1}`;
        return c.outbound;
      });
    } else {
      activeNodes.sort((a, b) => a.latency - b.latency);
      console.log(`[zen-scrape] Found ${activeNodes.length} live responsive nodes. Fastest: ${activeNodes[0].latency}ms, median: ${activeNodes[Math.floor(activeNodes.length / 2)].latency}ms.`);
      selectedOutbounds = activeNodes.slice(0, maxNodes).map((c, i) => {
        c.outbound.tag = `s${i + 1}`;
        return c.outbound;
      });
    }
  } else {
    selectedOutbounds = candidates.slice(0, maxNodes).map((c, i) => {
      c.outbound.tag = `s${i + 1}`;
      return c.outbound;
    });
  }

  const xrayConfig = buildXrayConfig(selectedOutbounds);

  // Validate with xray if available
  const xrayBin = findXrayBin();
  const tmpFile = path.join(os.tmpdir(), `zen-scrape-test-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(xrayConfig, null, 2));

  if (xrayBin) {
    try {
      const assetDir = process.env.XRAY_LOCATION_ASSET ||
        (fs.existsSync(path.join(os.homedir(), '.local', 'share', 'v2rayN', 'bin', 'geosite.dat'))
          ? path.join(os.homedir(), '.local', 'share', 'v2rayN', 'bin')
          : undefined);

      execFileSync(xrayBin, ['-test', '-c', tmpFile], {
        env: { ...process.env, ...(assetDir ? { XRAY_LOCATION_ASSET: assetDir } : {}) },
        stdio: 'pipe'
      });
      console.log(`[zen-scrape] Xray configuration validated successfully with ${xrayBin}.`);
    } catch (e) {
      console.warn(`[zen-scrape] Warning: Xray test warning/failure: ${e.message}`);
    }
  }
  fs.unlinkSync(tmpFile);

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(xrayConfig, null, 2));
  console.log(`[zen-scrape] Saved ${selectedOutbounds.length} proxy outbounds to ${outputFile}`);
}

main().catch(err => {
  console.error('[zen-scrape] Fatal:', err);
  process.exit(1);
});
