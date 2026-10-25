# opencode-zen-proxy

Route **OpenCode Zen** model traffic through your own HTTP/SOCKS proxy — without
tripping Zen's client validation — and recover automatically when the current
exit is rate-limited.

If you've tried the obvious approaches (a local `baseURL` override pointing at a
little Node/Python forwarding proxy, `HTTP_PROXY` on a TLS-terminating bridge,
etc.) you may have hit this:

```
403 {"error":{"type":"FreeTierError",
     "message":"OpenCode's free tier can only be used from within OpenCode."}}
429 {"type":"error","error":{"type":"FreeUsageLimitError",
     "message":"Free usage limit reached. Subscribe to OpenCode Go to keep going."}}
```

…even though the exact same request from OpenCode itself (same IP, same headers,
same model) succeeds.

**Why:** Zen validates the *TLS client*. OpenCode is a Bun program, so its
requests use Bun's TLS stack (BoringSSL). Any local proxy that terminates TLS
with a different stack (`undici`/OpenSSL via Node, Python `ssl`, etc.) gets
rejected as "not from OpenCode" — regardless of exit IP or account. The fix is
to let OpenCode do its own TLS and point it at an HTTP CONNECT proxy instead.

Two further problems this repo solves:

- Free-tier allowance is per exit IP, and OpenCode keeps pooled CONNECT tunnels
  alive. A tunnel pinned to a spent exit returns 429 until it dies.
- OpenCode deliberately **does not retry** `FreeUsageLimitError` / `FreeTierError`.
  The session stops. The proxy cannot see the status because it only forwards
  encrypted bytes, so the retry has to be triggered from OpenCode.

## How it works

```
                         ┌──────────────────────────────┐
                         │ zen-retry OpenCode plugin    │
                         │ 403/429 → rotate tunnel      │
                         │        → retry on new exit   │
                         └──────────────┬───────────────┘
                                        │ POST /rotate (127.0.0.1:10902)
OpenCode ──HTTPS_PROXY──▶ zen-relay ────┘
         ──CONNECT──────▶ Xray (127.0.0.1:10901)
         ──TLS──────────▶ opencode.ai:443   (Bun does the handshake)
```

- `bin/zen-install.sh` installs the scripts, the retry plugin, and (if needed)
  Xray; scrapes public node feeds; writes OpenCode's service environment; and
  starts the proxy + relay as systemd user services (or autostart).
- `bin/zen-scrape.js` builds a dedicated Xray config from public repositories
  that publish Xray/V2Ray share links. It de-duplicates, validates with Xray,
  probes each exit, and writes `~/.config/zen-proxy/zen.json`.
- `bin/zen-relay.js` sits between OpenCode and Xray (10900 → 10901), rotating
  idle tunnels so spent exits don't pin you. It also exposes a tiny local
  control endpoint (`/rotate`, `/status`).
- `bin/zen-retry-plugin.js` is an OpenCode v2 plugin. On a Zen 403/429 it adds
  `x-should-retry: true` (which OpenCode's error classifier honours), forces the
  retry, and asks the relay to retire the failed tunnel first.
- `bin/zen-exit-check.sh` probes whether the current exit still has free-tier
  quota, sweeps your own profiles, and hot-swaps a config.
- `config/sources.example.json` lists the default public feeds; `bin/zen-scrape.sh`
  has the same list built in and can read `~/.config/zen-proxy/sources.json`.

## Setup Guide

Choose your operating system below for quick setup instructions:

---

### 🐧 Linux Setup

#### Prerequisites
- Node.js 18+ (`node -v`)
- Python 3 (`python3 --version`)
- `curl`
- OpenCode v2.1+ (`opencode --version`)  
*(Xray is detected automatically or downloaded by the installer if missing).*

#### Quick Install (One Command)

```bash
git clone https://github.com/Hadixel/opencode-zen-proxy.git
cd opencode-zen-proxy
./bin/zen-install.sh
```

The installer:
1. Detects or downloads Xray into `~/.local/share/zen-proxy/` and links it to `~/.local/bin/xray`.
2. Scrapes and validates working public exit nodes directly against Zen into `~/.config/zen-proxy/zen.json`.
3. Installs the automatic retry plugin into `~/.config/opencode/plugin/zen-retry.js`.
4. Writes `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` into OpenCode's `service.json`.
5. Starts both Xray (10901) and `zen-relay` (10900) in the background.

Useful install flags:
```bash
./bin/zen-install.sh --refresh            # re-scrape even if a config exists
./bin/zen-install.sh --limit 200          # more candidate exits (slower)
./bin/zen-install.sh --zen-check 5        # verify 5 live exits against Zen
./bin/zen-install.sh --no-service         # install files only
./bin/zen-install.sh --no-verify          # skip the final exit check
./bin/zen-install.sh --no-restart         # install/start proxy, leave OpenCode running
```

#### Service Management on Linux

```bash
./bin/zen-service.sh status     # Check status and recent relay logs
./bin/zen-service.sh restart    # Restart proxy and relay services
./bin/zen-service.sh stop       # Stop background services cleanly
./bin/zen-service.sh start      # Start background services
./bin/zen-service.sh scrape     # Re-scrape and validate fresh exits
./bin/zen-exit-check.sh         # Test active exit against Zen free tier
./run.sh                        # Run interactively in the foreground (Ctrl+C stops)
```

#### Manual Setup with Your Own VPS / Private Config on Linux

```bash
# Switch active proxy to your own Xray/V2Ray config:
./bin/zen-exit-check.sh --use /path/to/your-config.json

# Or configure OpenCode manually:
./bin/zen-setup.sh --proxy http://127.0.0.1:10900
opencode service restart
./bin/zen-service.sh restart
```

---

### 🪟 Windows Setup (PowerShell)

#### Prerequisites
- Windows 10 or 11
- PowerShell 5.1+ (built-in Windows PowerShell) or PowerShell 7+ (`pwsh`)
- Node.js 18+ (download from [nodejs.org](https://nodejs.org) or install via `winget install OpenJS.NodeJS.LTS`)
- OpenCode v2.1+  
*(Xray for Windows is automatically downloaded and extracted if not found).*

#### Quick Install (One Command)

Open PowerShell (as your normal user) and run the one-line web installer:

```powershell
irm https://raw.githubusercontent.com/Hadixel/opencode-zen-proxy/main/bin/zen-install.ps1 | iex
```

Or clone and run locally:

```powershell
git clone https://github.com/Hadixel/opencode-zen-proxy.git
cd opencode-zen-proxy
.\bin\zen-install.ps1
```

The installer:
1. Verifies Node.js is present.
2. Downloads official 64-bit Windows Xray release (`Xray-windows-64.zip`) into `$HOME\.local\share\zen-proxy\` if missing.
3. Installs the retry plugin into `$HOME\.config\opencode\plugin\zen-retry.js`.
4. Configures OpenCode's `$HOME\.config\opencode\service.json` with the proxy settings.
5. Scrapes and validates working exits directly against Zen into `$HOME\.config\zen-proxy\zen.json`.
6. Starts Xray (10901) and `zen-relay` (10900) in the background.

#### Service Management on Windows

```powershell
.\bin\zen-service.ps1 status    # Check status and recent relay logs
.\bin\zen-service.ps1 restart   # Restart proxy and relay services
.\bin\zen-service.ps1 stop      # Stop background services cleanly
.\bin\zen-service.ps1 start     # Start background services
.\bin\zen-service.ps1 scrape    # Re-scrape and validate fresh exits
.\bin\zen-exit-check.ps1        # Test active exit against Zen free tier
.\run.ps1                       # One-click interactive foreground runner (Ctrl+C stops)
```

#### Manual Setup with Your Own VPS or v2rayN on Windows

```powershell
# Switch active proxy to your own config:
.\bin\zen-exit-check.ps1 -Use "C:\path\to\your-config.json"

# Or sweep a directory of v2rayN configs to find which ones work with Zen:
.\bin\zen-exit-check.ps1 -Sweep "$env:APPDATA\v2rayN\guiConfigs"
```

---

### 🧪 Verify Your Setup (Linux & Windows)

Test that OpenCode answers free-tier queries through the proxy:

```bash
opencode run --model opencode/deepseek-v4.1-flash-free "Hello! Reply with SUCCESS."
```

---

> **Public nodes are shared and untrusted.** Their operators can observe the
> traffic that passes through them. Do not use them for credentials, private
> source code, or anything sensitive. Prefer your own VPS or a trusted provider
> for real work. Public feeds can disappear or change format at any time.

## Automatic 403/429 recovery

The relay never terminates TLS — that is what keeps Zen's client validation
happy — so it cannot read the HTTP status line. OpenCode can. The retry plugin
uses two OpenCode v2 hooks:

| Hook | What it does |
|---|---|
| `session.http.response` | On a Zen 403/429, sets `x-should-retry: true` so OpenCode's classifier treats it as retryable. |
| `session.retry` | On `provider.free-limit`, `provider.rate-limit`, 403, or 429, calls the relay's `/rotate`, then forces `{ retry: true, delay: 750 }`. |

`POST /rotate` marks every tunnel for retirement and closes the ones that are
idle; a tunnel that is still streaming is left alone until it goes quiet. The
retry therefore opens a **new** tunnel, and Xray's random balancer picks a
**different exit**. With a pool of live exits this usually recovers on the first
or second retry.

Defaults and tuning:

```bash
ZEN_RETRY_MAX=8          # forced retries before giving up (default 8)
ZEN_RETRY_DELAY_MS=750   # delay before each forced retry
ZEN_RETRY_DEBUG=1        # log rotations/retries to stderr
ZEN_RETRY_DISABLE=1      # one-shot mode for sweep/probe tools
ZEN_RELAY_CONTROL=http://127.0.0.1:10902/rotate
ZEN_RELAY_CONTROL_PORT=10902
```

To check that the plugin loaded:

```bash
ZEN_RETRY_DEBUG=1 opencode run --standalone --model opencode/big-pickle "say OK"
# look for: [zen-retry] plugin loaded ...
```

If you use the manual setup below instead of `zen-install.sh`, run
`zen-setup.sh` from this repo: when `zen-retry-plugin.js` sits next to it, it
installs the plugin automatically.

## Scraping public exits

```bash
./bin/zen-scrape.sh                       # fetch, probe, write ~/.config/zen-proxy/zen.json
./bin/zen-scrape.sh --no-test --limit 100 # convert only, no network probes
./bin/zen-scrape.sh --zen-check 5         # also test the first 5 live exits against Zen
./bin/zen-scrape.sh --dry-run --verbose   # report counts without writing
./bin/zen-scrape.sh --refresh             # ignore the cached node list
```

The scraper understands the formats these feeds use: plain lines of
`vmess://`/`vless://`/`trojan://`/`ss://` links, whole-body base64
subscriptions, per-line base64, and JSON arrays of full Xray configs. It skips
protocols Xray does not run (`hysteria2`, `tuic`, `anytls`, SSR, SIP003
Shadowsocks plugins).

Built-in sources include
[Barabama/FreeNodes](https://github.com/Barabama/FreeNodes),
[snakem982/proxypool](https://github.com/snakem982/proxypool),
[Pawdroid/Free-servers](https://github.com/Pawdroid/Free-servers),
[ripaojiedian/freenode](https://github.com/ripaojiedian/freenode),
[zengfr/free-vpn-subscribe](https://github.com/zengfr/free-vpn-subscribe),
[freefq/free](https://github.com/freefq/free), and
[awesome-vpn/awesome-vpn](https://github.com/awesome-vpn/awesome-vpn). Copy
`config/sources.example.json` to `~/.config/zen-proxy/sources.json` to replace
the list with your own.

What it writes:

- `~/.config/zen-proxy/zen.json` — a complete Xray config with a random
  balancer over the probed exits. The previous config is backed up next to it.
- `~/.config/zen-proxy/nodes.json` — the candidate cache (protocols, names,
  probe results, last exit IP). Reused on the next run so transient feed
  failures don't wipe a working pool.

Xray is used to validate each outbound (`xray run -test`), and a single throwaway
Xray instance probes all candidates in parallel through per-candidate local
inbounds. Reachability is measured against `opencode.ai/cdn-cgi/trace`, so a
node that cannot reach Zen is not kept just because it can reach the wider
internet. When probing is enabled, only reachable exits make it into the
config, and exits that passed the Zen check are duplicated in the balancer so
they are picked more often than unverified ones. Both files are written with
mode `0600` because they contain server credentials.

## Manual setup (your own servers)

If you already have your own Xray/V2Ray servers and do not want public nodes:

```bash
mkdir -p ~/.config/zen-proxy
cp config/xray-balancer.example.json ~/.config/zen-proxy/zen.json
# Edit zen.json: replace placeholder addresses/ids with your real servers.
export XRAY_LOCATION_ASSET=~/.local/share/v2rayN/bin   # if your rules use geosite:/geoip:
./bin/zen-setup.sh --proxy http://127.0.0.1:10900      # also installs the retry plugin
opencode service restart
./bin/start-zen-proxy.sh &    # Xray on 127.0.0.1:10901
./bin/start-zen-relay.sh &    # Relay on 127.0.0.1:10900 → 10901
```

Verify:

```bash
./bin/zen-exit-check.sh
#   exit: <some-ip>
#   zen:  OK
```

For persistence, the installer creates systemd user units. For a manual setup,
copy `config/autostart/*.desktop` into `~/.config/autostart/` (GNOME/KDE) or
wire the scripts into your init system.

## Switching exits manually

Free-tier allowance is per exit IP. The relay rotates idle tunnels every ~3
minutes, and the plugin rotates on a failed request. If you want to check or
switch manually:

```bash
./bin/zen-exit-check.sh                          # probe the configured proxy
./bin/zen-exit-check.sh --proxy http://host:port # probe a specific proxy
./bin/zen-exit-check.sh --sweep <dir>            # test every Xray config in a dir
./bin/zen-exit-check.sh --use <config.json>      # switch the dedicated proxy
```

`--sweep` is the slow, definitive test: it runs a free model through each
profile. Use the scraper when you want a large pool without owning servers.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `403 FreeTierError` | A local forwarder terminated TLS (Node/Python/curl bridge). Zen saw a non-Bun client. | Remove the `baseURL` override. Use `zen-setup.sh` to proxy at the fetch layer instead. |
| `429 FreeUsageLimitError` | Exit IP's free allowance is spent, or burst too fast. | The plugin rotates and retries automatically. If it exhausts the pool, run `zen-scrape.sh --refresh` for fresh exits. |
| 403/429 still stops the session | Plugin not loaded, or OpenCode older than v2. | Run `ZEN_RETRY_DEBUG=1 opencode ...`; confirm `[zen-retry] plugin loaded`. Update OpenCode. |
| Plugin loaded but no rotation | Relay control port not listening. | `curl http://127.0.0.1:10902/status`; check `zen-relay` logs. |
| `ECONNRESET` | Proxy dropped the connection mid-stream. | Normal under heavy rotation; OpenCode retries. Check `zen-proxy.log` for upstream errors. |
| DNS errors in proxy log (`record not found`, `context deadline exceeded`) | Xray couldn't resolve domains (missing `geosite.dat` or unreachable DoH). | The generated config avoids geo assets. For your own config, set `XRAY_LOCATION_ASSET` or use the generated one. |
| `402 Insufficient account funds` on `/responses` | OpenCode's session-title model is a paid Zen model, unrelated to free-tier routing. | Set `"small_model": "your-local-provider/model"` in `opencode.json` to route title generation elsewhere. |
| Free models work via `--standalone` but fail through the TUI | Service process didn't pick up the env vars or plugin. | Run `opencode service restart` after `zen-setup.sh`. |
| `systemctl --user status zen-proxy` is failed | No `zen.json`, invalid config, or port in use. | Check `journalctl --user -u zen-proxy -n 50`; run `zen-scrape.sh --refresh`. |

## Important notes

- **Do NOT set `provider.opencode.options.baseURL` to a local TLS-terminating
  proxy.** The gateway rejects requests whose TLS client isn't OpenCode's own.
  Keep the baseURL as the real origin (or omit it entirely) and use
  `HTTPS_PROXY`.
- `HTTPS_PROXY` affects all of OpenCode's non-local traffic (models.dev, MCP,
  updates). Local hosts stay direct via `NO_PROXY`. A strictly per-provider
  split is not possible while satisfying Zen's client check.
- Free-tier access works without an account (anonymous), so logging out of the
  `opencode` provider does not by itself change quota behaviour.
- The retry plugin requires OpenCode v2 (the `session.http.response` and
  `session.retry` hooks). The repo is tested with v2.1.4.
- Public scraped nodes are a convenience, not a security boundary. See the
  warning above.
- `docs/findings.md` contains the measurements behind the claims above.

## License

MIT — see [LICENSE](LICENSE).
