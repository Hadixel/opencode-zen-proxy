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
