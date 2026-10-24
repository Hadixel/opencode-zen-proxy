# opencode-zen-proxy

Route **OpenCode Zen** model traffic through your own HTTP/SOCKS proxy — without
tripping Zen's client validation.

If you've tried the obvious approaches (a local `baseURL` override pointing at a
little Node/Python forwarding proxy, `HTTP_PROXY` on a TLS-terminating bridge,
etc.) you may have hit this:

```
403 {"error":{"type":"FreeTierError",
     "message":"OpenCode's free tier can only be used from within OpenCode."}}
429 {"type":"error","error":{"type":"FreeTierError",
     "message":"Free usage limit reached. Subscribe to OpenCode Go to keep going."}}
```

…even though the exact same request from OpenCode itself (same IP, same headers,
same model) succeeds.

**Why:** Zen validates the *TLS client*. OpenCode is a Bun program, so its
requests use Bun's TLS stack (BoringSSL). Any local proxy that terminates TLS
with a different stack (`undici`/OpenSSL via Node, Python `requests`, `curl`,
…) is accepted by the network but rejected by the gateway — you get
`403 FreeTierError` and/or `429 FreeUsageLimitError`, regardless of which exit
IP you use. This is why "no matter what proxy/IP I try" happens.

**Fix:** don't terminate TLS yourself. Keep OpenCode's own TLS and proxy at the
*fetch* layer, using the standard proxy environment variables that Bun supports.
Zen then sees a genuine OpenCode client while the TCP traffic still egresses
through your proxy.

```
opencode (Bun fetch + Bun TLS)
   └─ CONNECT via HTTPS_PROXY ──► your proxy ──► opencode.ai:443
```

---

## Quick start

### 1. Have an HTTP proxy listening locally

Anything that speaks HTTP `CONNECT` works — e.g. an Xray/V2Ray `mixed` inbound,
`socks2http`, Clash's mixed port, `gost`, corporate proxy, …

If you already run Xray for your VPN, the `mixed` inbound is enough; note its
port (this guide uses `127.0.0.1:10900`).

<details>
<summary>Optional: dedicated Xray instance + exit rotation (recommended)</summary>

Free-tier allowance is also limited **per exit IP**, and shared/datacenter exits
are frequently spent. If your provider gives you several servers, run a dedicated
Xray instance that load-balances across them so each request can use a different
exit:

```bash
cp config/xray-balancer.example.json ~/.config/zen-proxy/zen.json
$EDITOR ~/.config/zen-proxy/zen.json        # add your own server entries
./bin/start-zen-proxy.sh                    # serves 127.0.0.1:10900
```

See `config/xray-balancer.example.json` for the shape of a `balancers` block
plus `bin/start-zen-proxy.sh` for how it's launched.
</details>

### 2. Point OpenCode at it (fetch layer, not a baseURL override)

```bash
./bin/zen-setup.sh --proxy http://127.0.0.1:10900
opencode service restart
```

`zen-setup.sh` writes the proxy into OpenCode's service environment
(`~/.config/opencode/service.json`) so the background server uses it:

```json
"env": {
  "HTTPS_PROXY": "http://127.0.0.1:10900",
  "HTTP_PROXY":  "http://127.0.0.1:10900",
  "NO_PROXY":    "localhost,127.0.0.1,::1"
}
```

`NO_PROXY` is required: it keeps the local server and any local model gateway
(e.g. one on `127.0.0.1:20128`) out of the proxy, avoiding routing loops.

> **Do not** set `provider.opencode.options.baseURL` to a local forwarding
> proxy. That reintroduces the TLS-client problem. Leave the `opencode`
> provider at its real origin.

Add the same variables to your shell profile if you also launch OpenCode
outside the service:

```bash
./bin/zen-setup.sh --proxy http://127.0.0.1:10900 --print-shell-env
```

### 3. Verify

```bash
./bin/zen-exit-check.sh
```

```
zen-proxy exit: 203.0.113.10
zen free model: OK
```

Then use a free model normally, e.g. `opencode run --model opencode/big-pickle "hi"`.

---

## `zen-exit-check.sh`

Checks whether a proxy exit currently has free-tier allowance, and helps you
switch when it doesn't. Free-tier quota is scoped **per exit IP**, and shared
exits get spent — so this is the tool you'll reach for most.

```bash
zen-exit-check.sh                    # probe the configured proxy
zen-exit-check.sh --proxy http://127.0.0.1:10900
zen-exit-check.sh --sweep <dir>      # test every Xray config in a directory
zen-exit-check.sh --use <config>     # switch the dedicated proxy to a config
```

`--sweep` starts each config on a spare port, prints its exit IP and whether a
free model works, then tears it down (it never touches your running proxy).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `403 FreeTierError` ("can only be used from within OpenCode") | The request's TLS client is not OpenCode's. You are still going through a local TLS-terminating proxy — remove any `baseURL` override and proxy via `HTTPS_PROXY` instead. |
| `429 FreeUsageLimitError` ("Free usage limit reached") | That exit IP has no free allowance left (shared/datacenter exits often don't). `zen-exit-check.sh --sweep` and switch, or use a residential-class exit. |
| Bursty 429s during long agent runs | Free tier is also rate-limited in short windows. Space out requests; use a paid/Go model or a different provider for heavy loops. |
| Session-title calls failing with `402 Insufficient account funds` | Titles use a paid small model. Point them elsewhere, e.g. `"small_model": "<your-provider>/<model>"`. |
| Local gateway (e.g. 9router) broken/stalls | Its host is missing from `NO_PROXY`. |
| Nothing goes through the proxy | The service needs a restart after env changes: `opencode service restart`. |

Sanity check what the gateway actually sees — request one page through your
proxy with OpenCode's identity headers intact and confirm a `200`:

```bash
HTTPS_PROXY=http://127.0.0.1:10900 NO_PROXY=localhost,127.0.0.1,::1 \
  opencode run --standalone --model opencode/big-pickle "say OK"
```

---

## Notes

- Proxying via environment variables is **process-wide**: all of OpenCode's
  non-local traffic (model registry, MCP, updates) uses the proxy too. Local
  hosts stay direct via `NO_PROXY`. A strictly per-provider split is not
  possible while satisfying Zen's client check.
- Free-tier access works without an account (anonymous), so logging out of the
  `opencode` provider does not by itself change quota behaviour.
- `docs/findings.md` contains the measurements behind the claims above.

## License

MIT — see [LICENSE](LICENSE).
