#!/usr/bin/env node
/**
 * zen-scrape — build an Xray config for the Zen proxy from public node feeds.
 *
 * It fetches a handful of public, frequently-updated repositories that publish
 * Xray/V2Ray share links, converts the links to Xray outbounds, de-duplicates
 * them, optionally probes each exit, and writes a random-balancer config that
 * `start-zen-proxy.sh` can run.
 *
 *   zen-scrape.js                         fetch, probe, write ~/.config/zen-proxy/zen.json
 *   zen-scrape.js --no-test --limit 100   convert without probing (fast)
 *   zen-scrape.js --zen-check 5           also verify the first 5 live exits against Zen
 *   zen-scrape.js --dry-run --verbose     report what would be written
 *
 * Public nodes are shared and untrusted. Traffic through them is visible to
 * their operators. Do not use them for credentials, private code, or anything
 * sensitive. Prefer your own VPS for real work.
 *
 * Env:
 *   ZEN_CONFIG           output config (default ~/.config/zen-proxy/zen.json)
 *   ZEN_NODES_STATE      node cache    (default ~/.config/zen-proxy/nodes.json)
 *   XRAY                 xray binary   (default: xray on PATH, then v2rayN's copy)
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

const HOME = os.homedir();
const CONFIG_PATH = process.env.ZEN_CONFIG || path.join(HOME, ".config", "zen-proxy", "zen.json");
const STATE_PATH = process.env.ZEN_NODES_STATE || path.join(HOME, ".config", "zen-proxy", "nodes.json");
const SOURCES_PATH = path.join(HOME, ".config", "zen-proxy", "sources.json");
let TMP;
const tmpDir = () => (TMP ??= fs.mkdtempSync(path.join(os.tmpdir(), "zen-scrape-")));
const USER_AGENT = "zen-scrape/1.0 (+https://github.com/)";

/** Feeds that publish raw share links or subscriptions and update frequently. */
const DEFAULT_SOURCES = [
  { name: "Barabama/FreeNodes", url: "https://raw.githubusercontent.com/Barabama/FreeNodes/main/nodes/merged.txt" },
  { name: "snakem982/proxypool", url: "https://raw.githubusercontent.com/snakem982/proxypool/main/source/v2ray-2.txt" },
  { name: "Pawdroid/Free-servers", url: "https://raw.githubusercontent.com/Pawdroid/Free-servers/main/sub" },
  { name: "ripaojiedian/freenode", url: "https://raw.githubusercontent.com/ripaojiedian/freenode/main/sub" },
  { name: "zengfr/vless", url: "https://raw.githubusercontent.com/zengfr/free-vpn-subscribe/main/vpn_sub_vless.txt" },
  { name: "zengfr/trojan", url: "https://raw.githubusercontent.com/zengfr/free-vpn-subscribe/main/vpn_sub_trojan.txt" },
  { name: "zengfr/vmess", url: "https://raw.githubusercontent.com/zengfr/free-vpn-subscribe/main/vpn_sub_vmess.txt" },
  { name: "zengfr/ss", url: "https://raw.githubusercontent.com/zengfr/free-vpn-subscribe/main/vpn_sub_shadowsocks.txt" },
  { name: "freefq/free", url: "https://raw.githubusercontent.com/freefq/free/master/v2" },
  { name: "awesome-vpn/awesome-vpn", url: "https://raw.githubusercontent.com/awesome-vpn/awesome-vpn/master/all" },
];

const SCHEMES = ["vmess", "vless", "trojan", "ss", "ssr", "hysteria", "hysteria2", "hy2", "tuic", "anytls", "socks"];
const SUPPORTED = new Set(["vmess", "vless", "trojan", "ss"]);

const argv = process.argv.slice(2);
const opt = {
  limit: 300,
  concurrency: 16,
  timeout: 6,
  zenCheck: 0,
  test: true,
  dryRun: false,
  refresh: false,
  verbose: false,
  output: CONFIG_PATH,
  state: STATE_PATH,
  sources: [],
  sourcesFile: null,
};

const log = (...args) => console.log("[zen-scrape]", ...args);
const debug = (...args) => { if (opt.verbose) log(...args); };
const warn = (...args) => console.error("[zen-scrape]", ...args);

const usage = () => {
  console.log(`usage: zen-scrape.js [options]

  --limit <n>        candidates kept after de-duplication (default ${opt.limit})
  --concurrency <n>  parallel exit probes (default ${opt.concurrency})
  --timeout <sec>    per-probe timeout (default ${opt.timeout})
  --no-test          skip connectivity probes
  --zen-check <n>    verify the first n live exits against Zen (default 0)
  --sources <file>   JSON source list ({"sources":[{"name","url"}]})
  --source <url>     add one source URL (repeatable)
  --refresh          ignore the cached node list
  --dry-run          fetch/convert/report, do not write the config
  --verbose          per-source and per-probe details
  --output <path>    config path (default ${CONFIG_PATH})
  --state <path>     node cache path (default ${STATE_PATH})
  -h, --help         show this help

Public nodes are shared and untrusted; do not send secrets through them.`);
};

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const value = () => {
    const next = argv[++i];
    if (next === undefined) throw new Error(`${arg} needs a value`);
    return next;
  };
  switch (arg) {
    case "--limit": opt.limit = positive(value(), arg); break;
    case "--concurrency": opt.concurrency = positive(value(), arg); break;
    case "--timeout": opt.timeout = positive(value(), arg); break;
    case "--zen-check": opt.zenCheck = nonNegative(value(), arg); break;
    case "--no-test": opt.test = false; break;
    case "--refresh": opt.refresh = true; break;
    case "--dry-run": opt.dryRun = true; break;
    case "--verbose": opt.verbose = true; break;
    case "--output": opt.output = value(); break;
    case "--state": opt.state = value(); break;
    case "--sources": opt.sourcesFile = value(); break;
    case "--source": opt.sources.push({ name: `cli:${opt.sources.length + 1}`, url: value() }); break;
    case "-h": case "--help": usage(); process.exit(0); break;
    default: throw new Error(`unknown argument: ${arg}`);
  }
}

function positive(raw, flag) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number`);
  return n;
}

function nonNegative(raw, flag) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be zero or a positive number`);
  return n;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

const URI_RE = new RegExp(`(?:^|\\n)\\s*(${SCHEMES.join("|")})://`, "i");

/** Decode standard or URL-safe base64, tolerating whitespace and missing padding. */
function decodeBase64Raw(input) {
  let s = input.replace(/^\uFEFF/, "").trim();
  if (!s || s.includes("://")) return null;
  s = s.replace(/\s+/g, "");
  if (s.length < 4 || s.length > 24 * 1024 * 1024) return null;
  const variants = [s, s.replace(/-/g, "+").replace(/_/g, "/")];
  for (const variant of variants) {
    const padded = variant + "=".repeat((4 - (variant.length % 4)) % 4);
    try {
      const out = Buffer.from(padded, "base64").toString("utf8");
      if (!out || out.includes("\uFFFD")) continue;
      const printable = [...out].filter((c) => c === "\n" || c === "\r" || c === "\t" || c >= " ").length;
      if (printable / out.length < 0.9) continue;
      return out;
    } catch {
      // try the next alphabet
    }
  }
  return null;
}

/** Decode a subscription body, accepting it only when it contains share links. */
function decodeBase64(input) {
  const out = decodeBase64Raw(input);
  return out && URI_RE.test(out) ? out : null;
}

/** Pull share URIs out of plain text, subscription base64, and per-line base64. */
function extractLinks(text) {
  if (!text) return [];
  let body = text.replace(/^\uFEFF/, "");
  if (!URI_RE.test(body)) {
    const decoded = decodeBase64(body);
    if (decoded) return extractLinks(decoded);
  }
  const links = [];
  for (const raw of body.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const at = line.indexOf("://");
    if (at > 0) {
      const scheme = line.slice(0, at).toLowerCase();
      if (!SCHEMES.includes(scheme)) continue;
      links.push(line);
      continue;
    }
    // Some per-protocol feeds base64 each line separately.
    const decoded = decodeBase64(line);
    if (decoded) links.push(...extractLinks(decoded));
  }
  return links;
}

function splitHostPort(authority) {
  const value = authority.trim().replace(/\/+$/, "");
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return null;
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    const port = rest.startsWith(":") ? Number(rest.slice(1)) : NaN;
    return host && Number.isInteger(port) ? { host, port } : null;
  }
  const cut = value.lastIndexOf(":");
  if (cut <= 0) return null;
  const host = value.slice(0, cut);
  const port = Number(value.slice(cut + 1));
  return host && Number.isInteger(port) && port > 0 && port < 65536 ? { host, port } : null;
}

function first(value) {
  if (typeof value !== "string") return "";
  return value.split(",")[0].trim();
}

function safeDecode(value) {
  if (typeof value !== "string") return "";
  try { return decodeURIComponent(value); } catch { return value; }
}

function splitList(value) {
  if (typeof value !== "string") return undefined;
  const list = value.split(",").map((item) => item.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

function boolParam(params, ...names) {
  for (const name of names) {
    const value = params.get(name);
    if (value === null) continue;
    return value === "" || value === "1" || value === "true" || value === "yes";
  }
  return false;
}

function streamSettings(input) {
  const network = (input.network || "tcp").toLowerCase();
  const security = (input.security || "none").toLowerCase();
  const ss = { network };

  const tlsSettings = {};
  if (security === "tls") {
    if (input.sni) tlsSettings.serverName = input.sni;
    if (input.alpn) tlsSettings.alpn = input.alpn;
    if (input.fp) tlsSettings.fingerprint = input.fp;
    // Xray 26 removed `allowInsecure`; a node with an untrusted certificate is
    // dropped by the connectivity probe instead of being written unverified.
    ss.security = "tls";
    if (Object.keys(tlsSettings).length) ss.tlsSettings = tlsSettings;
  } else if (security === "reality") {
    if (!input.publicKey) return null;
    ss.security = "reality";
    ss.realitySettings = {
      serverName: input.sni || input.host || "",
      fingerprint: input.fp || "chrome",
      publicKey: input.publicKey,
    };
    if (input.shortId) ss.realitySettings.shortId = input.shortId;
    if (input.spiderX) ss.realitySettings.spiderX = input.spiderX;
  } else {
    ss.security = "none";
  }

  const host = input.host || "";
  const pathValue = input.path || "";
  if (network === "ws") {
    ss.wsSettings = { path: pathValue || "/" };
    if (host) ss.wsSettings.host = host;
  } else if (network === "grpc" || network === "gun") {
    ss.network = "grpc";
    ss.grpcSettings = { serviceName: input.serviceName || pathValue.replace(/^\//, "") };
  } else if (network === "h2" || network === "http") {
    ss.network = "h2";
    const httpSettings = { path: pathValue || "/" };
    if (host) httpSettings.host = splitList(host);
    ss.httpSettings = httpSettings;
  } else if (network === "httpupgrade") {
    ss.httpupgradeSettings = { path: pathValue || "/" };
    if (host) ss.httpupgradeSettings.host = host;
  } else if (network === "xhttp") {
    ss.xhttpSettings = { path: pathValue || "/" };
    if (host) ss.xhttpSettings.host = host;
    if (input.mode) ss.xhttpSettings.mode = input.mode;
  } else if (network === "kcp") {
    ss.kcpSettings = { header: { type: input.headerType || "none" } };
    if (input.seed) ss.kcpSettings.seed = input.seed;
  } else if (network === "quic") {
    ss.quicSettings = {
      security: input.quicSecurity || "none",
      key: input.quicKey || "",
      header: { type: input.headerType || "none" },
    };
  } else if (network === "tcp") {
    if (input.headerType === "http") {
      ss.tcpSettings = {
        header: {
          type: "http",
          request: {
            path: [pathValue || "/"],
            headers: host ? { Host: [host] } : {},
          },
        },
      };
    }
  } else {
    return null;
  }
  return ss;
}

function baseOutbound(protocol, settings, stream) {
  const outbound = { protocol, settings };
  if (stream) outbound.streamSettings = stream;
  return outbound;
}

function parseVless(url, name) {
  const params = url.searchParams;
  const id = safeDecode(url.username) || params.get("id") || "";
  if (!id) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port) || 443;
  const network = (params.get("type") || params.get("net") || "tcp").toLowerCase();
  let security = (params.get("security") || "none").toLowerCase();
  if (security === "xtls") security = "tls";
  const stream = streamSettings({
    network,
    security,
    host: first(params.get("host") || params.get("ws-host") || ""),
    path: params.get("path") || params.get("serviceName") || "",
    serviceName: params.get("serviceName") || "",
    sni: params.get("sni") || params.get("serverName") || "",
    alpn: splitList(params.get("alpn") || ""),
    fp: params.get("fp") || params.get("fingerprint") || "",
    publicKey: params.get("pbk") || params.get("publicKey") || "",
    shortId: params.get("sid") || params.get("shortId") || "",
    spiderX: params.get("spx") || params.get("spiderX") || "",
    allowInsecure: boolParam(params, "allowInsecure", "insecure"),
    headerType: (params.get("headerType") || params.get("type") || "").toLowerCase(),
    mode: params.get("mode") || "",
    seed: params.get("seed") || "",
    quicSecurity: params.get("quicSecurity") || "",
    quicKey: params.get("key") || "",
  });
  if (!stream) return null;
  const flow = params.get("flow") || "";
  return baseOutbound(
    "vless",
    { vnext: [{ address: host, port, users: [{ id, encryption: "none", flow: flow || undefined, level: 0 }] }] },
    stream,
  );
}

function parseVmess(link, name) {
  const encoded = safeDecode(link.slice("vmess://".length).split("#")[0].trim());
  let data;
  try {
    const text = decodeBase64Raw(encoded);
    if (!text) return null;
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || !data.add || !data.id) return null;
  const host = String(data.add).replace(/^\[|\]$/g, "");
  const port = Number(data.port);
  if (!host || !Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  const network = String(data.net || "tcp").toLowerCase();
  const tls = String(data.tls ?? data.security ?? "").toLowerCase();
  const stream = streamSettings({
    network,
    security: tls === "tls" || tls === "reality" ? tls : tls === "true" ? "tls" : "none",
    host: first(data.host || ""),
    path: data.path || "",
    serviceName: data.serviceName || data.path || "",
    sni: data.sni || "",
    alpn: splitList(data.alpn || ""),
    fp: data.fp || "",
    allowInsecure:
      data.allowInsecure === true || data.allowInsecure === 1 || data.allowInsecure === "1" ||
      data.verify_cert === false,
    headerType: String(data.type || "none").toLowerCase(),
    mode: data.mode || "",
    seed: data.seed || "",
    quicSecurity: data.quicSecurity || "",
    quicKey: data.key || "",
  });
  if (!stream) return null;
  const user = {
    id: String(data.id),
    alterId: Number(data.aid || data.alterId || 0) || 0,
    security: String(data.scy || data.security || "auto"),
    level: 0,
  };
  return baseOutbound("vmess", { vnext: [{ address: host, port, users: [user] }] }, stream);
}

function parseTrojan(url, name) {
  const params = url.searchParams;
  const password = safeDecode(url.username);
  if (!password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port) || 443;
  const network = (params.get("type") || params.get("net") || "tcp").toLowerCase();
  const security = (params.get("security") || "tls").toLowerCase();
  const stream = streamSettings({
    network,
    security: security === "none" ? "none" : security === "reality" ? "reality" : "tls",
    host: first(params.get("host") || ""),
    path: params.get("path") || params.get("serviceName") || "",
    serviceName: params.get("serviceName") || "",
    sni: params.get("sni") || params.get("peer") || "",
    alpn: splitList(params.get("alpn") || ""),
    fp: params.get("fp") || "",
    publicKey: params.get("pbk") || "",
    shortId: params.get("sid") || "",
    spiderX: params.get("spx") || "",
    allowInsecure: boolParam(params, "allowInsecure", "insecure"),
    headerType: (params.get("headerType") || "").toLowerCase(),
    mode: params.get("mode") || "",
    seed: params.get("seed") || "",
    quicSecurity: params.get("quicSecurity") || "",
    quicKey: params.get("key") || "",
  });
  if (!stream) return null;
  return baseOutbound("trojan", { servers: [{ address: host, port, password, level: 0 }] }, stream);
}

/** SIP002 and legacy `ss://` links. Links with SIP003 plugins are skipped: Xray does not run them. */
function parseShadowsocks(link, name) {
  let rest = link.slice("ss://".length);
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  const question = rest.indexOf("?");
  let query = "";
  if (question >= 0) {
    query = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }
  if (/(?:^|&)plugin=/.test(query)) return null; // v2ray-plugin/obfs-local are not Xray outbounds

  let authority = rest;
  let userinfo;
  let hostport;
  if (rest.includes("@")) {
    const cut = rest.lastIndexOf("@");
    userinfo = rest.slice(0, cut);
    hostport = rest.slice(cut + 1);
  } else {
    const decoded = decodeBase64Raw(rest);
    if (!decoded || !decoded.includes("@")) return null;
    const cut = decoded.lastIndexOf("@");
    userinfo = decoded.slice(0, cut);
    hostport = decoded.slice(cut + 1);
  }
  const target = splitHostPort(hostport);
  if (!target) return null;

  let method;
  let password;
  if (userinfo.includes(":")) {
    const cut = userinfo.indexOf(":");
    method = safeDecode(userinfo.slice(0, cut));
    password = safeDecode(userinfo.slice(cut + 1));
  } else {
    const decoded = decodeBase64Raw(userinfo);
    if (!decoded || !decoded.includes(":")) return null;
    const cut = decoded.indexOf(":");
    method = decoded.slice(0, cut);
    password = decoded.slice(cut + 1);
  }
  method = String(method || "").trim().toLowerCase();
  if (!method || !password) return null;
  return baseOutbound(
    "shadowsocks",
    { servers: [{ address: target.host, port: target.port, method, password, level: 0 }] },
    { network: "tcp", security: "none" },
  );
}

function parseLink(link) {
  const scheme = link.slice(0, link.indexOf("://")).toLowerCase();
  if (!SUPPORTED.has(scheme)) return null;
  // VMess and legacy Shadowsocks payloads are base64, not URL authorities.
  if (scheme === "vmess") return withName(parseVmess(link, nameFromFragment(link, true)), nameFromFragment(link, true));
  if (scheme === "ss") return withName(parseShadowsocks(link, nameFromFragment(link)), nameFromFragment(link));
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const name = safeDecode((url.hash || "").slice(1)) || "";
  if (scheme === "vless") return withName(parseVless(url, name), name);
  if (scheme === "trojan") return withName(parseTrojan(url, name), name);
  return null;
}

function nameFromFragment(link, raw = false) {
  const hash = link.indexOf("#");
  if (hash < 0) return "";
  let value = link.slice(hash + 1);
  if (raw) value = value.split("#")[0];
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Update fields that Xray removed since a node was cached. */
function sanitizeOutbound(outbound) {
  if (!outbound) return outbound;
  const copy = structuredClone(outbound);
  if (copy.streamSettings?.tlsSettings) delete copy.streamSettings.tlsSettings.allowInsecure;
  if (copy.streamSettings?.realitySettings) delete copy.streamSettings.realitySettings.allowInsecure;
  return copy;
}

function withName(outbound, name) {
  if (!outbound) return null;
  outbound = sanitizeOutbound(outbound);
  const server = outbound.settings?.vnext?.[0] || outbound.settings?.servers?.[0];
  const host = server?.address || "";
  const port = server?.port || "";
  return {
    outbound,
    name: name || `${outbound.protocol} ${host}:${port}`,
    protocol: outbound.protocol,
    host,
    port,
    key: outboundKey(outbound),
  };
}

function outboundKey(outbound) {
  const s = outbound.settings || {};
  const server = s.vnext?.[0] || s.servers?.[0] || {};
  const user = server.users?.[0] || server;
  const stream = outbound.streamSettings || {};
  return JSON.stringify([
    outbound.protocol,
    server.address,
    server.port,
    user.id || user.password || "",
    stream.network || "tcp",
    stream.security || "none",
    stream.wsSettings?.path || stream.grpcSettings?.serviceName || stream.httpSettings?.path || stream.xhttpSettings?.path || "",
    stream.wsSettings?.host || stream.wsSettings?.headers?.Host || stream.httpupgradeSettings?.host || stream.xhttpSettings?.host || "",
    stream.tlsSettings?.serverName || stream.realitySettings?.serverName || "",
  ]);
}

/** Full Xray configs (e.g. a subscription JSON that already contains outbounds). */
function extractConfigOutbounds(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return [];
  let data;
  try { data = JSON.parse(trimmed); } catch { return []; }
  const configs = Array.isArray(data) ? data : [data];
  const found = [];
  const builtin = new Set(["freedom", "blackhole", "dns", "direct", "block"]);
  for (const config of configs) {
    const outbounds = config?.outbounds;
    if (!Array.isArray(outbounds)) continue;
    for (const outbound of outbounds) {
      if (!outbound || builtin.has(outbound.protocol)) continue;
      if (!SUPPORTED.has(outbound.protocol)) continue;
      found.push(withName(structuredClone(outbound), outbound.tag || ""));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function loadSources() {
  let sources = [...DEFAULT_SOURCES];
  const file = opt.sourcesFile || (fs.existsSync(SOURCES_PATH) ? SOURCES_PATH : null);
  if (file) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed.sources;
    if (!Array.isArray(list)) throw new Error(`${file}: expected a sources array`);
    sources = list;
    if (!opt.sourcesFile) debug(`using sources from ${file}`);
  }
  return sources.concat(opt.sources);
}

async function fetchText(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/plain, application/json, */*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 64 * 1024 * 1024) throw new Error("response too large");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSource(source) {
  const started = Date.now();
  const body = await fetchText(source.url);
  const links = extractLinks(body);
  const configs = extractConfigOutbounds(body);
  const parsed = [];
  const unsupported = new Map();
  for (const link of links) {
    const scheme = link.slice(0, link.indexOf("://")).toLowerCase();
    if (!SUPPORTED.has(scheme)) {
      unsupported.set(scheme, (unsupported.get(scheme) || 0) + 1);
      continue;
    }
    const item = parseLink(link);
    if (item) parsed.push({ ...item, source: source.name });
    else unsupported.set(`${scheme}-invalid`, (unsupported.get(`${scheme}-invalid`) || 0) + 1);
  }
  for (const item of configs) parsed.push({ ...item, source: source.name });
  debug(
    `${source.name}: ${links.length} links, ${configs.length} config outbounds, ` +
      `${parsed.length} usable (${Date.now() - started}ms)`,
  );
  return {
    parsed,
    unsupported: Object.fromEntries([...unsupported].sort((a, b) => b[1] - a[1]).slice(0, 6)),
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function readState() {
  if (opt.refresh || !fs.existsSync(opt.state)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(opt.state, "utf8"));
    return Array.isArray(data.nodes) ? data.nodes.filter((node) => node?.key && node?.outbound) : [];
  } catch {
    return [];
  }
}

function mergeNodes(fresh, cached) {
  const byKey = new Map();
  for (const node of cached) {
    byKey.set(node.key, { ...node, outbound: sanitizeOutbound(node.outbound), cached: true });
  }
  for (const node of fresh) {
    const old = byKey.get(node.key);
    byKey.set(node.key, {
      ...node,
      lastOk: old?.lastOk,
      exitIp: old?.exitIp,
      zenOk: old?.zenOk,
    });
  }
  const nodes = [...byKey.values()];
  const rank = (node) => (node.zenOk ? 0 : node.lastOk && Date.now() - node.lastOk < 24 * 3600e3 ? 1 : 2);
  nodes.sort((a, b) => rank(a) - rank(b));
  return nodes;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

// ---------------------------------------------------------------------------
// Xray & OpenCode
// ---------------------------------------------------------------------------

function findOpencode() {
  if (process.env.OPENCODE_BIN && fs.existsSync(process.env.OPENCODE_BIN)) {
    return process.env.OPENCODE_BIN;
  }
  const isWin = process.platform === "win32";
  const exeNames = isWin ? ["opencode.exe", "opencode.cmd", "opencode.bat"] : ["opencode"];

  // 1. Check PATH
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const exe of exeNames) {
      const candidate = path.join(dir, exe);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // 2. Common platform install locations
  const candidatePaths = [];
  for (const exe of exeNames) {
    candidatePaths.push(
      path.join(HOME, ".opencode", "bin", exe),
      path.join(HOME, ".local", "bin", exe),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "opencode", exe),
      path.join(process.env.LOCALAPPDATA || "", "opencode", "bin", exe),
      path.join(process.env.USERPROFILE || "", ".opencode", "bin", exe),
      path.join(process.env.APPDATA || "", "npm", exe),
      path.join(process.env["ProgramFiles"] || "C:\\Program Files", "opencode", exe),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "opencode", exe),
      path.join(process.env.ProgramData || "C:\\ProgramData", "chocolatey", "bin", exe),
      path.join(process.env.USERPROFILE || "", "scoop", "shims", exe),
      `/usr/local/bin/${exe}`,
      `/usr/bin/${exe}`
    );
  }

  for (const candidate of candidatePaths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findXray() {
  const isWin = process.platform === "win32";
  const exeNames = isWin ? ["xray.exe", "xray"] : ["xray"];

  if (process.env.XRAY && fs.existsSync(process.env.XRAY)) {
    return process.env.XRAY;
  }

  // Check PATH
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of pathDirs) {
    for (const exe of exeNames) {
      const candidate = path.join(dir, exe);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Common platform paths
  const candidatePaths = [];
  for (const exe of exeNames) {
    candidatePaths.push(
      path.join(HOME, ".local", "share", "v2rayN", "bin", "xray", exe),
      path.join(HOME, ".local", "bin", exe),
      path.join(HOME, ".local", "share", "zen-proxy", exe),
      path.join(HOME, ".local", "share", "zen-proxy", "xray", exe),
      path.join(HOME, "v2rayN", "bin", "xray", exe),
      path.join(HOME, "Downloads", "v2rayN", "bin", "xray", exe),
      path.join(process.env.LOCALAPPDATA || "", "v2rayN", "bin", "xray", exe),
      path.join(process.env.APPDATA || "", "v2rayN", "bin", "xray", exe),
      path.join(process.env["ProgramFiles"] || "C:\\Program Files", "v2rayN", "bin", "xray", exe),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "v2rayN", "bin", "xray", exe),
      path.join(HOME, "scoop", "apps", "xray", "current", exe),
      `/usr/local/bin/${exe}`,
      `/usr/bin/${exe}`
    );
  }

  for (const candidate of candidatePaths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function testConfig(xray, outbounds, timeoutMs = 20000) {
  const config = {
    log: { loglevel: "error" },
    inbounds: [],
    outbounds: [
      ...outbounds.map((outbound, i) => ({ ...outbound, tag: `v${i}` })),
      { protocol: "freedom", tag: "direct" },
    ],
  };
  fs.mkdirSync(tmpDir(), { recursive: true, mode: 0o700 });
  const file = path.join(tmpDir(), "test.json");
  fs.writeFileSync(file, JSON.stringify(config));
  return new Promise((resolve) => {
    const child = spawn(xray, ["run", "-test", "-c", file], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ ok: false, error: "timeout" }); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, error: stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300) });
    });
  });
}

/** Filter out outbounds Xray rejects, using recursive bisection for large lists. */
async function validateOutbounds(xray, nodes) {
  if (!xray) {
    warn("xray not found; skipping config validation (set XRAY=/path/to/xray)");
    return nodes;
  }
  const check = async (items) => {
    if (items.length === 0) return [];
    const result = await testConfig(xray, items.map((item) => item.outbound));
    if (result.ok) return items;
    if (items.length === 1) {
      debug(`drop invalid ${items[0].protocol} ${items[0].host}:${items[0].port}: ${result.error}`);
      return [];
    }
    const mid = Math.floor(items.length / 2);
    return [...(await check(items.slice(0, mid))), ...(await check(items.slice(mid)))];
  };
  const valid = await check(nodes);
  log(`xray: ${valid.length}/${nodes.length} outbounds valid`);
  return valid;
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function waitForPort(port, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function runCurl(port, timeoutSec) {
  return new Promise((resolve) => {
    // Cloudflare's trace endpoint is on the same host as Zen and reports the
    // exit IP, so this checks the real destination instead of a third party.
    const isWin = process.platform === "win32";
    const curlBin = isWin ? "curl.exe" : "curl";
    const child = spawn(curlBin, [
      "-sS", "--max-time", String(timeoutSec),
      "--proxy", `http://127.0.0.1:${port}`,
      "-w", "\n%{http_code}",
      "https://opencode.ai/cdn-cgi/trace",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
      windowsHide: true,
      env: {
        ...process.env,
        NO_PROXY: "", no_proxy: "",
        HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "",
        ALL_PROXY: "", all_proxy: "",
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => resolve({ ok: false, error: `curl missing (${e.message})` }));
    child.on("close", (code) => {
      const lines = out.trimEnd().split("\n");
      const status = Number(lines.pop());
      const body = lines.join("\n");
      const ip = /(?:^|\n)ip=([0-9a-f:.]+)/i.exec(body)?.[1] || "";
      const reachable = code === 0 && Number.isInteger(status) && status >= 200 && status < 500;
      resolve({ ok: reachable, ip, error: err.trim().slice(0, 120) });
    });
  });
}

async function probeExits(xray, nodes, basePort, checkState = null) {
  if (!xray) {
    warn("xray not found; skipping connectivity probes");
    return nodes.map((node) => ({ ...node, lastOk: undefined, exitIp: undefined }));
  }
  if (!nodes.length) return nodes;
  const inbounds = [];
  const outbounds = [];
  const rules = [];
  nodes.forEach((node, i) => {
    const port = basePort + i;
    node.__probePort = port;
    inbounds.push({
      tag: `probe-${i}`,
      listen: "127.0.0.1",
      port,
      protocol: "http",
      settings: { auth: "noauth" },
    });
    outbounds.push({ ...node.outbound, tag: `probe-out-${i}` });
    rules.push({ type: "field", inboundTag: [`probe-${i}`], outboundTag: `probe-out-${i}` });
  });
  const config = {
    log: { loglevel: "error" },
    inbounds,
    outbounds: [...outbounds, { protocol: "freedom", tag: "direct" }],
    routing: { domainStrategy: "AsIs", rules },
  };
  fs.mkdirSync(tmpDir(), { recursive: true, mode: 0o700 });
  const file = path.join(tmpDir(), `probe-${basePort}.json`);
  fs.writeFileSync(file, JSON.stringify(config));
  debug(`starting probe xray on ${basePort}..${basePort + nodes.length - 1}`);
  const child = spawn(xray, ["run", "-c", file], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  const ready = await waitForPort(basePort);
  if (!ready) {
    await stopChild(child);
    try { fs.unlinkSync(file); } catch (_) {}
    warn("probe xray did not start:", stderr.trim().split("\n").slice(-3).join(" "));
    return nodes.map((node) => ({ ...node, lastOk: undefined }));
  }

  const results = new Array(nodes.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= nodes.length) return;
      const result = await runCurl(basePort + i, opt.timeout);
      results[i] = result;
      if (result.ok) debug(`live ${nodes[i].protocol} ${nodes[i].host}:${nodes[i].port} -> ${result.ip}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opt.concurrency, nodes.length) }, worker));
  const probed = nodes.map((node, i) => ({
    ...node,
    lastOk: results[i]?.ok ? Date.now() : undefined,
    lastCheck: Date.now(),
    exitIp: results[i]?.ok ? results[i].ip : undefined,
  }));
  // Zen checks must run while this probe instance is still listening.
  const withZen = opt.zenCheck
    ? await checkZen(probed, probed.map((node, i) => (node.lastOk ? i : -1)).filter((i) => i >= 0), checkState)
    : probed;
  await stopChild(child);
  try { fs.unlinkSync(file); } catch (_) {}
  withZen.forEach((node) => { delete node.__probePort; });
  return withZen;
}

async function checkZen(nodes, liveIndexes, checkState = null) {
  if (!opt.zenCheck || !liveIndexes.length) return nodes;
  const state = checkState || { foundOk: 0, targetZenOk: Number(process.env.ZEN_TARGET_OK || 3) };
  if (state.foundOk >= state.targetZenOk) return nodes;
  const opencode = findOpencode() || process.env.OPENCODE_BIN || "opencode";
  const checkModel = process.env.ZEN_CHECK_MODEL || "opencode/deepseek-v4.1-flash-free";
  const targetZenOk = state.targetZenOk;
  const concurrency = Number(process.env.ZEN_CHECK_CONCURRENCY || 6);
  const isWin = process.platform === "win32";
  const maxToCheck = Math.min(opt.zenCheck, liveIndexes.length);
  warn(`checking up to ${maxToCheck} exit(s) against Zen (${checkModel}) with concurrency ${concurrency} (target: ${targetZenOk} working exits, found: ${state.foundOk})`);
  
  let nextIdx = 0;
  
  const worker = async () => {
    while (nextIdx < maxToCheck && state.foundOk < targetZenOk) {
      const idx = nextIdx++;
      const nodeIndex = liveIndexes[idx];
      const node = nodes[nodeIndex];
      const port = node.__probePort;
      const env = {
        ...process.env,
        HTTPS_PROXY: `http://127.0.0.1:${port}`,
        HTTP_PROXY: `http://127.0.0.1:${port}`,
        ALL_PROXY: "",
        all_proxy: "",
        NO_PROXY: "localhost,127.0.0.1,::1",
        ZEN_RETRY_DISABLE: "1",
      };
      
      const result = await new Promise((resolve) => {
        const child = spawn(opencode, ["run", "--standalone", "--format", "json", "--model", checkModel, "say OK"], {
          cwd: os.tmpdir(),
          env,
          shell: isWin,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => { out += d.toString(); });
        child.stderr.on("data", (d) => { err += d.toString(); });
        const timer = setTimeout(() => {
          if (isWin) {
            try { require("node:child_process").execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" }); } catch (_) {}
          } else {
            child.kill("SIGKILL");
          }
          resolve({ ok: false, text: "timeout" });
        }, 18000);
        child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, text: error.message }); });
        child.on("close", () => {
          clearTimeout(timer);
          const text = `${out}\n${err}`;
          const isLimit = /FreeUsageLimit|FreeTierError|free usage limit|quota/i.test(text);
          const hasOk = /\bOK\b/.test(out) || /"text":\s*"[^"]*OK[^"]*"/i.test(out);
          const ok = hasOk && !isLimit;
          resolve({ ok, text: text.slice(-400) });
        });
      });

      node.zenOk = result.ok;
      node.zenChecked = Date.now();
      warn(`zen check [${node.protocol}] ${node.host}:${node.port} -> ${result.ok ? "SUCCESS (OK)" : "FAIL"}`);
      if (result.ok) {
        state.foundOk++;
        warn(`>>> Found working Zen exit (${state.foundOk}/${targetZenOk}): [${node.protocol}] ${node.host}:${node.port} <<<`);
      }
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, maxToCheck) }, () => worker());
  await Promise.all(pool);
  return nodes;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function buildConfig(nodes) {
  const verified = nodes.filter((n) => n.zenOk);
  const useNodes = verified.length > 0 ? verified : nodes;
  if (verified.length > 0) {
    warn(`building config using ${verified.length} verified Zen-capable exit(s)`);
  }
  const entries = [];
  useNodes.forEach((node, i) => {
    entries.push({ node, tag: `pub${i}` });
  });
  const tags = entries.map((entry) => entry.tag);
  const privateIps = [
    "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
    "169.254.0.0/16", "::1/128", "fc00::/7", "fe80::/10",
  ];
  return {
    // Written by zen-scrape.js. Keep this file private: outbounds contain credentials.
    log: { loglevel: "warning" },
    dns: {
      servers: [
        { address: "https://1.1.1.1/dns-query", tag: "remote-dns" },
        { address: "1.1.1.1" },
      ],
      queryStrategy: "UseIP",
    },
    inbounds: [
      {
        listen: "127.0.0.1",
        port: 10901,
        protocol: "mixed",
        settings: { auth: "noauth", udp: true },
        sniffing: { enabled: true, destOverride: ["http", "tls"], routeOnly: true },
        tag: "mixed-in",
      },
      {
        listen: "127.0.0.1",
        port: 10954,
        protocol: "dokodemo-door",
        settings: { address: "1.1.1.1", network: "tcp,udp", port: 53 },
        tag: "dns-in",
      },
    ],
    outbounds: [
      ...entries.map((entry) => ({ ...entry.node.outbound, tag: entry.tag })),
      { tag: "dns-out", protocol: "dns", settings: { rules: [{ action: "hijack" }] } },
      { tag: "direct", protocol: "freedom", settings: { domainStrategy: "UseIP" } },
      { tag: "block", protocol: "blackhole" },
    ],
    routing: {
      domainStrategy: "IPIfNonMatch",
      balancers: [{ tag: "zenbal", selector: tags, strategy: { type: "roundRobin" } }],
      rules: [
        { type: "field", inboundTag: ["mixed-in"], port: 53, outboundTag: "dns-out" },
        { type: "field", inboundTag: ["dns-in"], outboundTag: "dns-out" },
        { type: "field", domain: ["localhost"], outboundTag: "direct" },
        { type: "field", ip: privateIps, outboundTag: "direct" },
        { type: "field", network: "udp", outboundTag: "block" },
        { type: "field", network: "tcp", balancerTag: "zenbal" },
      ],
    },
    policy: {
      levels: {
        0: { connIdle: 60, handshake: 8, uplinkOnly: 5, downlinkOnly: 5 },
      },
    },
  };
}

function nodeMetadata(nodes) {
  return {
    generatedAt: new Date().toISOString(),
    count: nodes.length,
    nodes: nodes.map((node, i) => ({
      tag: `pub${i}`,
      key: node.key,
      protocol: node.protocol,
      host: node.host,
      port: node.port,
      name: node.name,
      source: node.source,
      outbound: node.outbound,
      lastOk: node.lastOk,
      lastCheck: node.lastCheck,
      exitIp: node.exitIp,
      zenOk: node.zenOk,
      zenChecked: node.zenChecked,
    })),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(path.dirname(opt.output), { recursive: true });
  fs.mkdirSync(tmpDir(), { recursive: true, mode: 0o700 });

  const sources = loadSources();
  log(`fetching ${sources.length} source(s)`);
  const fetched = await Promise.allSettled(sources.map(fetchSource));
  const perSource = [];
  const unsupported = {};
  fetched.forEach((result, i) => {
    if (result.status === "rejected") {
      warn(`source failed: ${sources[i].name}: ${result.reason?.message || result.reason}`);
      return;
    }
    perSource.push(result.value.parsed);
    for (const [scheme, count] of Object.entries(result.value.unsupported)) {
      unsupported[scheme] = (unsupported[scheme] || 0) + count;
    }
  });
  const fresh = interleave(perSource);
  if (Object.keys(unsupported).length) {
    debug("skipped:", Object.entries(unsupported).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
  }
  log(`converted ${fresh.length} candidate(s)`);

  const cached = readState();
  let nodes = mergeNodes(fresh, cached);
  if (!nodes.length) {
    warn("no usable nodes; keeping the existing config");
    return 1;
  }
  const isZenScan = opt.zenCheck > 0;
  if (!isZenScan) {
    nodes = nodes.slice(0, opt.limit);
  }
  log(`evaluating pool of ${nodes.length} candidate(s)${cached.length ? ` (${cached.length} cached)` : ""}`);

  if (opt.test) {
    const xray = findXray();
    if (!xray) {
      warn("xray not found; install Xray or set XRAY. Writing all candidates without probes.");
    } else {
      log(`xray: ${xray}`);
      const targetZenOk = Number(process.env.ZEN_TARGET_OK || 3);
      const batchSize = Math.max(30, Math.min(100, opt.limit || 100));
      const maxCandidates = isZenScan ? Math.min(nodes.length, Math.max(opt.limit, 1200)) : Math.min(nodes.length, opt.limit);
      const candidatesToScan = nodes.slice(0, maxCandidates);

      const checkState = { foundOk: 0, targetZenOk };
      const verifiedExits = [];
      const seenExitIps = new Set();
      let allReachable = [];

      for (let offset = 0; offset < candidatesToScan.length; offset += batchSize) {
        if (isZenScan && checkState.foundOk >= checkState.targetZenOk) break;

        const batch = candidatesToScan.slice(offset, offset + batchSize);
        log(`probing batch ${Math.floor(offset / batchSize) + 1} (${batch.length} candidates, offset ${offset})...`);

        const validBatch = await validateOutbounds(xray, batch);
        if (!validBatch.length) continue;

        const basePort = await freePortFor(validBatch.length);
        const probedBatch = await probeExits(xray, validBatch, basePort, isZenScan ? checkState : null);
        const liveBatch = probedBatch.filter((node) => node.lastOk);
        log(`probe batch result: ${liveBatch.length}/${validBatch.length} exit(s) reachable`);

        for (const node of liveBatch) {
          if (!node.exitIp || !seenExitIps.has(node.exitIp)) {
            if (node.exitIp) seenExitIps.add(node.exitIp);
            allReachable.push(node);
          }
          if (node.zenOk) {
            verifiedExits.push(node);
          }
        }

        if (isZenScan && checkState.foundOk >= checkState.targetZenOk) {
          log(`reached target of ${checkState.targetZenOk} verified Zen exit(s); stopping scan.`);
          break;
        }
      }

      if (isZenScan) {
        if (verifiedExits.length > 0) {
          log(`successfully verified ${verifiedExits.length} working Zen exit(s)`);
          nodes = verifiedExits;
        } else {
          warn("WARNING: None of the candidate exits passed OpenCode Zen verification.");
          const defaultConfigFile = path.join(__dirname, "..", "config", "zen-default.json");
          if (fs.existsSync(opt.output)) {
            warn(`Keeping existing config at ${opt.output} to avoid breaking proxy.`);
            return 0;
          } else if (fs.existsSync(defaultConfigFile)) {
            warn(`Falling back to bundled known-good config from ${defaultConfigFile}`);
            fs.copyFileSync(defaultConfigFile, opt.output);
            return 0;
          } else {
            warn("No fallback config available; keeping reachable exits as unverified fallback.");
            nodes = allReachable.length > 0 ? allReachable : nodes;
          }
        }
      } else {
        nodes = allReachable.length > 0 ? allReachable : nodes;
      }

      if (!nodes.length) {
        warn("no exit was reachable; keeping the existing config");
        return 1;
      }
    }
  } else {
    log("probes disabled (--no-test)");
  }

  const config = buildConfig(nodes);
  const state = nodeMetadata(nodes);
  if (opt.dryRun) {
    log(`dry run: would write ${nodes.length} outbounds to ${opt.output}`);
    log(`protocols: ${summarize(nodes)}`);
    return 0;
  }
  if (fs.existsSync(opt.output)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const backup = `${opt.output}.bak.${stamp}`;
    fs.copyFileSync(opt.output, backup);
    try { fs.chmodSync(backup, 0o600); } catch {}
  }
  writeAtomic(opt.output, JSON.stringify(config, null, 2) + "\n");
  writeAtomic(opt.state, JSON.stringify(state, null, 2) + "\n");
  log(`wrote ${nodes.length} outbound(s) to ${opt.output}`);
  log(`protocols: ${summarize(nodes)}`);
  log("restart the proxy to apply:  systemctl --user restart zen-proxy  (or start-zen-proxy.sh)");
  return 0;
}

function interleave(arrays) {
  const out = [];
  const lists = arrays.map((items) => shuffle([...items]));
  let index = 0;
  while (lists.some((list) => index < list.length)) {
    for (const list of lists) if (index < list.length) out.push(list[index]);
    index++;
  }
  return out;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function summarize(nodes) {
  const counts = {};
  for (const node of nodes) counts[node.protocol] = (counts[node.protocol] || 0) + 1;
  return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ");
}

/** Pick a contiguous port block that is free at the moment. */
async function freePortFor(count) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 20000);
    if (base + count >= 65000) continue;
    let ok = true;
    for (let i = 0; i < count; i++) {
      const free = await new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", () => resolve(false));
        server.listen(base + i, "127.0.0.1", () => server.close(() => resolve(true)));
      });
      if (!free) { ok = false; break; }
    }
    if (ok) return base;
  }
  throw new Error("could not find a free port block for probing");
}

main()
  .then((code) => {
    try { if (TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exit(code || 0);
  })
  .catch((error) => {
    warn(error?.stack || error?.message || String(error));
    try { if (TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exit(1);
  });
