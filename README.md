# opencode-zen-proxy

Route **OpenCode Zen** model traffic through your own HTTP/SOCKS proxy — without
tripping Zen's client validation.

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

A second issue: OpenCode keeps pooled CONNECT tunnels alive. Your proxy picks
an upstream exit once per tunnel, and free-tier allowance is scoped per exit IP.
A tunnel pinned to a spent exit makes every subsequent request return 429 until
the tunnel dies. This repo includes a transparent TCP relay that rotates idle
tunnels so each request can land on a fresh exit.

## How it works

```
OpenCode ──HTTPS_PROXY──▶ zen-relay (127.0.0.1:10900)
         ──CONNECT──────▶ Xray / v2ray / any proxy (127.0.0.1:10901)
         ──TLS──────────▶ opencode.ai:443   (Bun does the handshake)
```

- `bin/zen-setup.sh` writes `HTTPS_PROXY` into OpenCode's service environment
  (so the background server uses it). No env vars in your shell needed.
- `bin/start-zen-proxy.sh` runs a dedicated Xray instance on port 10901 with a
  random balancer over several upstream servers (diverse exits).
- `bin/zen-relay.js` sits between OpenCode and the proxy (port 10900 → 10901),
  rotating idle tunnels so spent exits don't pin you.
- `bin/zen-exit-check.sh` probes whether the current exit still has free-tier
  quota, sweeps all your profiles to find live ones, and hot-swaps the config.
- `config/xray-balancer.example.json` is a template — copy it to
  `~/.config/zen-proxy/zen.json` and add your servers.

## Quick start

### 1. Set up the proxy config

```bash
mkdir -p ~/.config/zen-proxy
cp config/xray-balancer.example.json ~/.config/zen-proxy/zen.json
# Edit zen.json: replace placeholder addresses/ids with your real servers.
# If your configs use geosite:/geoip: rules, set XRAY_LOCATION_ASSET:
export XRAY_LOCATION_ASSET=~/.local/share/v2rayN/bin   # wherever your .dat files are
```

### 2. Point OpenCode at the relay

```bash
./bin/zen-setup.sh --proxy http://127.0.0.1:10900
opencode service restart
```

This writes `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY=localhost,127.0.0.1,::1`
into `~/.config/opencode/service.json`. Local traffic (e.g. a `9router` provider
on `127.0.0.1`) stays direct.

### 3. Start the proxy and relay

```bash
./bin/start-zen-proxy.sh &    # Xray on 127.0.0.1:10901
./bin/start-zen-relay.sh &    # Relay on 127.0.0.1:10900 → 10901
```

For persistence, copy the `.desktop` files from `config/autostart/` into
`~/.config/autostart/` (GNOME/KDE) or wire them into your init system.

### 4. Verify

```bash
./bin/zen-exit-check.sh
# Expected output:
#   exit: <some-ip>
#   zen:  OK
```

Then try a free model:

```bash
opencode run --model opencode/big-pickle "say OK"
# Expected: OK
```

## Autostart (GNOME / KDE)

```bash
cp config/autostart/*.desktop ~/.config/autostart/
```

Or create them manually — see the example files in `config/autostart/`.

## Switching exits when one is spent

Free-tier allowance is per exit IP. When you get 429s, the current exit pool is
likely drained. Sweep your v2rayN/Xray profiles to find live ones:

```bash
./bin/zen-exit-check.sh --sweep ~/.local/share/v2rayN/guiConfigs/
```

Switch to a specific profile:

```bash
./bin/zen-exit-check.sh --use <profile-id-or-config-path>
```

The relay automatically rotates tunnels every ~3 minutes (idle) so you don't
stay pinned to one exit for long.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `403 FreeTierError` | A local forwarder terminated TLS (Node/Python/curl bridge). Zen saw a non-Bun client. | Remove the `baseURL` override. Use `zen-setup.sh` to proxy at the fetch layer instead. |
| `429 FreeUsageLimitError` | Exit IP's free allowance is spent, or burst too fast. | Run `zen-exit-check.sh --sweep` to find a live exit. The relay handles rotation automatically. |
| `ECONNRESET` | Proxy dropped the connection mid-stream. | Normal under heavy rotation; OpenCode retries. Check `zen-proxy.log` for upstream errors. |
| DNS errors in proxy log (`record not found`, `context deadline exceeded`) | Xray couldn't resolve domains (missing `geosite.dat` or unreachable DoH). | Set `XRAY_LOCATION_ASSET` to the directory containing `geosite.dat`/`geoip.dat`. Ensure the proxy's DNS outbound works. |
| `402 Insufficient account funds` on `/responses` | OpenCode's session-title model is a paid Zen model, unrelated to free-tier routing. | Set `"small_model": "your-local-provider/model"` in `opencode.json` to route title generation elsewhere. |
| Free models work via `--standalone` but fail through the TUI | Service process didn't pick up the env vars. | Run `opencode service restart` after `zen-setup.sh`. |

## Important notes

- **Do NOT set `provider.opencode.options.baseURL` to a local proxy.** The
  gateway rejects requests whose TLS client isn't OpenCode's own. Keep the
  baseURL as the real origin (or omit it entirely) and use `HTTPS_PROXY`.
- `HTTPS_PROXY` affects all of OpenCode's non-local traffic (models.dev, MCP,
  updates). Local hosts stay direct via `NO_PROXY`. A strictly per-provider
  split is not possible while satisfying Zen's client check.
- Free-tier access works without an account (anonymous), so logging out of the
  `opencode` provider does not by itself change quota behaviour.
- `docs/findings.md` contains the measurements behind the claims above.

## License

MIT — see [LICENSE](LICENSE).
