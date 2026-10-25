/**
 * zen-retry — an OpenCode v2 plugin that turns Zen free-tier 403/429 responses
 * into retries on a fresh proxy exit.
 *
 * Why this lives in OpenCode rather than in the proxy: OpenCode (Bun) must do
 * the TLS handshake with Zen itself, so the proxy only sees encrypted bytes and
 * cannot read the status line. OpenCode, on the other hand, sees the response
 * and exposes two hooks we can use:
 *
 *   - session `http.response` — mark a 403/429 as retryable via the
 *     `x-should-retry` header that OpenCode's error classifier honours.
 *   - session `retry` — force a retry even when OpenCode classified the error
 *     as a quota/authentication failure (FreeUsageLimitError / FreeTierError).
 *
 * Before each retry, POST to the relay's local control endpoint. The relay
 * closes the tunnel that just served the failed request, so the retry opens a
 * new tunnel and Xray picks another exit.
 *
 * Installed by `zen-install.sh` as `~/.config/opencode/plugin/zen-retry.js`.
 * No imports: OpenCode treats a `{ id, setup }` default export as a Promise
 * plugin, so this file needs no package resolution.
 *
 * Env:
 *   ZEN_RELAY_CONTROL       control URL (default http://127.0.0.1:10902/rotate)
 *   ZEN_RELAY_CONTROL_PORT  used when ZEN_RELAY_CONTROL is unset (default 10902)
 *   ZEN_RETRY_MAX           maximum forced retries (default 8)
 *   ZEN_RETRY_DELAY_MS      delay before a forced retry (default 750)
 *   ZEN_RETRY_DEBUG         set to 1 for plugin log lines
 */
"use strict";

const CONTROL =
  process.env.ZEN_RELAY_CONTROL ||
  `http://127.0.0.1:${process.env.ZEN_RELAY_CONTROL_PORT || 10902}/rotate`;
const MAX_RETRIES = Number(process.env.ZEN_RETRY_MAX || 8);
const RETRY_DELAY_MS = Number(process.env.ZEN_RETRY_DELAY_MS || 750);
const DEBUG = process.env.ZEN_RETRY_DEBUG === "1";
// Probe tools (zen-scrape --zen-check, zen-exit-check --sweep) want one answer
// per exit, not a retry storm through the same exit.
const DISABLED = process.env.ZEN_RETRY_DISABLE === "1";

const log = (...args) => {
  if (DEBUG) console.error("[zen-retry]", ...args);
};

const isZen = (event) => {
  if (event.model?.providerID) return event.model.providerID === "opencode";
  const url = event.request?.url;
  return typeof url === "string" && url.includes("opencode.ai/");
};

/** Retire the relay's current tunnel. Best effort: a missing relay must not break the retry. */
const rotate = async (reason) => {
  try {
    const res = await fetch(CONTROL, {
      method: "POST",
      signal: AbortSignal.timeout(1500),
    });
    if (DEBUG) log("rotated", reason, await res.text());
  } catch (error) {
    if (DEBUG) log("rotate failed", reason, error?.message || error);
  }
};

let lastRotate = 0;
const rotateOnce = async (reason) => {
  const now = Date.now();
  if (now - lastRotate < 500) return;
  lastRotate = now;
  await rotate(reason);
};

/** Free-tier and quota bodies that OpenCode deliberately refuses to retry. */
const retryableBody = (body) =>
  typeof body === "string" &&
  /FreeTierError|FreeUsageLimitError|free[_-]?limit|usage limit|rate.?limit/i.test(body);

export default {
  id: "zen.retry",
  setup: async (ctx) => {
    if (DISABLED) {
      log("plugin disabled by ZEN_RETRY_DISABLE");
      return;
    }
    log("plugin loaded", CONTROL);
    // Tell OpenCode's classifier that a Zen 403/429 is worth another attempt.
    await ctx.session.hook("http.response", async (event) => {
      const status = event.response.status;
      if (status !== 403 && status !== 429) return;
      if (!isZen(event)) return;
      try {
        event.response.headers.set("x-should-retry", "true");
      } catch {
        // A response with immutable headers is still handled by the retry hook.
      }
      // Do not block the response body on the rotation request.
      void rotateOnce(`http ${status}`);
    });

    // Force the retry even though OpenCode classifies free-tier responses as
    // quota/auth errors. Rotate first so the next attempt uses a new exit.
    await ctx.session.hook("retry", async (event) => {
      const status = event.error?.status;
      const body = event.error?.response?.body;
      const type = event.error?.type;
      const quota =
        status === 403 ||
        status === 429 ||
        type === "provider.free-limit" ||
        type === "provider.rate-limit" ||
        retryableBody(body) ||
        retryableBody(event.error?.message);
      if (!quota) return;
      if (!isZen(event)) return;
      if (event.attempt > MAX_RETRIES) {
        log("retry budget exhausted", event.attempt);
        event.decision = { retry: false };
        return;
      }
      await rotateOnce(`retry ${status ?? type}`);
      event.decision = { retry: true, delay: RETRY_DELAY_MS };
      log("forcing retry", event.attempt, status ?? type);
    });
  },
};
