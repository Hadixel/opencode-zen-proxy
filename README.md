# opencode-zen-proxy

Route **OpenCode Zen** model traffic through diverse public or private proxies — with **automatic 403/429 failover** and a **built-in public node scraper**.

## Key Features

1. **Automatic 403 / 429 Failover:** When an exit IP hits free-tier quota limits (429) or gets blocked by Cloudflare/Zen (403), `zen-relay` catches the error before OpenCode sees it, switches to another proxy from the pool, and retries the turn immediately. OpenCode sessions no longer stop midway with `Free usage limit reached`!
2. **Built-in Public Node Scraper:** No need to supply your own servers or configure v2rayN manually. The built-in scraper (`bin/zen-scrape.js`) fetches, tests, and configures live public VLESS (Reality, TLS, WS, gRPC) and Trojan nodes from GitHub automatically.
3. **Turnkey Zero-Config Setup:** Run `./bin/zen-setup.sh` and everything is ready.

## How it works

```
OpenCode ──HTTPS_PROXY──▶ zen-relay (127.0.0.1:10900)
         ──CONNECT──────▶ Xray Balancer (127.0.0.1:10901)
         ──TLS/H2───────▶ opencode.ai:443   (Auto-retry on 403/429)
```

- `bin/zen-setup.sh` generates local interception certs, scrapes public proxies if needed, and writes proxy environment variables into OpenCode's `service.json`.
- `bin/zen-scrape.js` scrapes public GitHub repositories, performs TCP pre-checks, and builds a validated `~/.config/zen-proxy/zen.json` with a random balancer.
- `bin/start-zen-proxy.sh` runs Xray on port 10901 with auto-detected binary and asset paths.
- `bin/zen-relay.js` sits between OpenCode and Xray (10900 → 10901), providing transparent failover on 403/429 for `opencode.ai` and transparent raw TCP passthrough for all other domains.
- `bin/zen-exit-check.sh` tests connectivity, sweeps profiles, or refreshes public nodes on demand (`--scrape`).

## Quick Start (Zero-Config)

### 1. Run Setup
```bash
./bin/zen-setup.sh
```
This automatically:
- Scrapes live public nodes into `~/.config/zen-proxy/zen.json`.
- Generates interception certificates for `opencode.ai`.
- Configures OpenCode's service environment (`service.json`).

### 2. Start the Proxy and Relay
```bash
./bin/start-zen-proxy.sh &    # Xray balancer on 127.0.0.1:10901
./bin/start-zen-relay.sh &    # Smart relay on 127.0.0.1:10900
opencode service restart
```

### 3. Verify
```bash
./bin/zen-exit-check.sh
```
Then try a free model in OpenCode:
```bash
opencode run --model opencode/big-pickle "say OK"
```

## Refreshing Public Proxies
To fetch fresh public proxies at any time:
```bash
./bin/zen-exit-check.sh --scrape
# or directly:
node ./bin/zen-scrape.js --max 30
```

## Autostart (GNOME / KDE)
Copy the autostart files from `config/autostart/` into `~/.config/autostart/`:
```bash
cp config/autostart/*.desktop ~/.config/autostart/
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `ZEN_RELAY_PORT` | `10900` | Relay listen port |
| `ZEN_PROXY_PORT` | `10901` | Upstream Xray proxy port |
| `ZEN_MAX_RETRIES` | `8` | Number of proxy retries on 403/429 before returning error |
| `ZEN_PROXY_CONFIG` | `~/.config/zen-proxy/zen.json` | Xray configuration path |
| `XRAY` | `auto` | Path to xray binary |
| `XRAY_LOCATION_ASSET` | `auto` | Directory containing `geosite.dat`/`geoip.dat` |

## License

MIT — see [LICENSE](LICENSE).
