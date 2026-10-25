# Findings

Measurements behind the claims in the README. All on OpenCode `v2.1.4`
(Bun 1.4.2), Zen free model `opencode/big-pickle`, October 2026.

## 1. A local TLS-terminating proxy gets rejected; OpenCode's own client does not

Same machine, same proxy exit, same model, same minute. The only difference is
who performs the TLS handshake to `opencode.ai`.

| Path | TLS client | Result |
|---|---|---|
| Local Node forwarder, `baseURL` → `http://127.0.0.1:<bridge>` | Node/undici (OpenSSL) | `403 FreeTierError` / `429` (10 fresh tunnels, 0 successes) |
| OpenCode → `https://opencode.ai/...` via `HTTPS_PROXY` | Bun (BoringSSL) | `200 OK` |
| OpenCode → direct, no proxy | Bun (BoringSSL) | `200 OK` |

Responses seen on the Node path:

```json
403 {"error":{"type":"FreeTierError",
     "message":"OpenCode's free tier can only be used from within OpenCode."}}
429 {"type":"error","error":{"type":"FreeUsageLimitError",
     "message":"Free usage limit reached. Subscribe to OpenCode Go to keep going."}}
```

The retry pattern alternates `403`/`429`, i.e. the gateway evaluates the client
and refuses free-tier usage. Rotating exit IPs (10 different servers behind a
random balancer, ~40 fresh tunnels) did not change it — the failure followed the
client, not the IP.

The request headers were identical in every case (verified on the wire):

```
user-agent: opencode/latest/2.1.4/cli
x-opencode-client: cli
x-opencode-org-id: wrk_…        (when authenticated)
x-opencode-project/session…
```

So the differentiator is not headers, not credentials, not the account — it is
the TLS client.

## 2. It is not account-scoped

| Credentials | Path | Result |
|---|---|---|
| account API key | direct | OK |
| none (fresh state dir, no `auth.json`) | direct | OK |
| none | via proxy | same behaviour as authenticated via proxy |

Anonymous requests work, so free-tier access does not depend on being logged in.
Logging out does not change quota behaviour by itself.

## 3. Free-tier allowance is also per exit IP

Simultaneously, through different servers from the same provider:

| Server (exit IP) | free model |
|---|---|
| A (`91.99.222.109`) | OK |
| B (`178.17.48.78`) | OK |
| C (`150.241.123.99`) | `429` |
| D (`185.233.81.147`) | `429` |
| E (`5.75.182.89`) | `429` |

Different exits, same instant → the allowance/refusal is per exit IP.
Shared/datacenter exits are frequently spent; that is why a single proxy often
"never works" while another works immediately. `zen-exit-check.sh --sweep`
automates finding a live one.

### Per-tunnel exit pinning (the real reason a single proxy "sometimes works")

Exits rotate **per TCP tunnel**, not per request. Bun keeps pooled CONNECT
tunnels; the proxy picks the upstream exit once when the tunnel opens and
reuses it. Once a tunnel's exit is spent, *every* request on that tunnel 429s
until the tunnel is dropped — confirmed empirically: dropping the proxy's
tunnels (not restarting OpenCode) made the next request succeed immediately.

So even with a balancer, a single long-lived tunnel stays pinned to one exit,
which is why "the same server" can show OK for a moment and 429 the next.

### Fix: rotate idle tunnels (zen-relay.js)

A transparent TCP relay between OpenCode (port 10900) and the proxy (port 10901)
closes tunnels after ~3 min of age, but only when momentarily quiet (so an
in-flight stream is never cut). Each new tunnel lets the proxy pick a fresh exit.
Verified live: a request before rotation and a request after both returned
`OK`, hitting different exits; the relay logged `rotated after Ns`.

The relay also accepts `POST /rotate` on `127.0.0.1:10902`. It marks all tunnels
for retirement and closes idle ones immediately; busy tunnels close once their
current stream goes quiet. This is what the OpenCode plugin calls after a
403/429. `POST /rotate?all=1` closes everything immediately, and
`GET /status` reports active/idle counts.

## 4. There is a short burst limit as well

Paced single requests at ~20 s intervals: 3/3 direct `OK`, 3/3 proxied `OK`.
Back-to-back agent runs (several requests per turn) trip `429`s; the
`retry-after` header points at the next 00:00 UTC but recovery actually happens
within seconds. Durable workarounds: don't run heavy parallel loops on free
models, or use a paid/Go model for them.

## 5. Endpoints

`models.dev` currently advertises the `opencode` provider at
`https://opencode.ai/inference/openai/v1` (it used to be `/inference/v1`).
If you override `baseURL` anywhere, keep it in sync with that — but note that
the recommended setup does **not** override `baseURL` at all.

## 6. OpenCode does not retry free-tier errors by itself

OpenCode v2 classifies the Zen free-tier response as `QuotaExceeded`:
`FreeUsageLimitError` becomes `provider.free-limit`, and `FreeTierError` (403)
becomes `Authentication`. Its retry predicate deliberately returns `false` for
both (`packages/ai/src/provider-error.ts`, `isRetryable`), so the session stops
instead of retrying.

There is an escape hatch in the same predicate:

```ts
const override = error.reason.http?.headers["x-should-retry"]
if (override === "true") return true
if (override === "false") return false
```

OpenCode v2 also exposes `session.http.response` and `session.retry` plugin
hooks. The plugin in `bin/zen-retry-plugin.js` uses them to:

1. add `x-should-retry: true` to a Zen 403/429 response, and
2. force `{ retry: true, delay: 750 }` in the retry hook, after calling the
   relay's `/rotate`.

Measured on OpenCode `v2.1.4` with a deliberately spent, reachable exit:

```
[zen-retry] rotated http 429 {"closed":1,"retired":2,"active":1}
[zen-retry] forcing retry 3 429
[zen-retry] rotated http 429 {"closed":0,"retired":1,"active":1}
[zen-retry] retry budget exhausted 4
Error: Free usage limit reached.
```

With a pool of exits, the rotated tunnel lands on a different exit. The plugin
caps retries (`ZEN_RETRY_MAX`, default 8) so a fully spent pool still fails
clearly instead of looping forever.

A 429 also carries the allowance reset:

```http
HTTP/2 429
retry-after: 20707
{"type":"error","error":{"type":"FreeUsageLimitError", ...}}
```

`20707` seconds is next 00:00 UTC. When `Retry-After` is longer than
`ZEN_RETRY_LONG_MS` (5 minutes), rotating exits cannot help: the plugin stops,
and asks the relay to schedule a refetch at the reset time. This avoids a retry
storm against an exhausted allowance.

`--zen-only` was added after the first top100 run: of 45 reachable exits, all
45 returned `FreeUsageLimitError` at 18:15 UTC, including the direct connection.
The pool was not "dead" at the network level; it was out of quota. The scraper
now treats the Zen request as part of health and refuses to write a pool with
zero quota-healthy exits.

## 7. Public feed scraper and validator

The default feed is
[0xRadikal/Free-v2ray-Configs](https://github.com/0xRadikal/Free-v2ray-Configs)
(`top100.txt`). It is a plain subscription file with comments and raw
`vmess://`/`vless://`/`ss://` lines. Measured on 2026-10-25:

| Stage | Count |
|---|---:|
| links in `top100.txt` | 100 |
| converted to supported outbounds | 97 |
| unique outbounds after de-duplication | 71 |
| accepted by `xray run -test` | 71 |
| reachable through `opencode.ai/cdn-cgi/trace` | 62 |
| unique exit IPs after de-duplication | 39 |

So roughly 60% of the published "top" nodes survive all three checks on this
host. The scraper never writes an exit that failed validation or the HTTPS
probe. `zen-validate.sh` applies the same checks to the active config and prunes
dead entries; it leaves the config untouched if nothing survives.

The funnel is why the relay's rotation and the plugin's retry matter: a pool of
39 exits has enough fresh IPs to make a 429 recoverable, while a single pinned
exit usually does not. When the retry budget is exhausted, the plugin calls the
relay's `/refetch`; the relay runs `zen-refetch.sh` (fetch + validate + probe),
writes a new config, and restarts Xray. A 10-minute cooldown prevents a
refetch loop when the entire free tier is exhausted.
