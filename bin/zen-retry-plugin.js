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
 *   ZEN_REFETCH_URL         refetch URL (default control URL with /refetch)
 *   ZEN_RELAY_CONTROL_PORT  used when ZEN_RELAY_CONTROL is unset (default 10902)
 *   ZEN_RETRY_MAX           maximum forced retries (default 8)
 *   ZEN_RETRY_DELAY_MS      delay before a forced retry (default 750)
 *   ZEN_RETRY_LONG_MS       retry-after above this means quota reset; stop
 *                            retrying/refetching (default 300000)
 *   ZEN_RETRY_DEBUG         set to 1 for plugin log lines
 */
"use strict";

const CONTROL =
  process.env.ZEN_RELAY_CONTROL ||
  `http://127.0.0.1:${process.env.ZEN_RELAY_CONTROL_PORT || 10902}/rotate`;
const REFETCH =
  process.env.ZEN_REFETCH_URL ||
  CONTROL.replace(/\/rotate(?:\?.*)?$/, "/refetch");
const MAX_RETRIES = Number(process.env.ZEN_RETRY_MAX || 12);
const RETRY_DELAY_MS = Number(process.env.ZEN_RETRY_DELAY_MS || 500);
// Free-tier quota resets are hours away (usually next 00:00 UTC). Rotating
// exits cannot create quota, so stop instead of burning attempts/refetches.
const LONG_RETRY_MS = Number(process.env.ZEN_RETRY_LONG_MS || 300000);
const DEBUG = process.env.ZEN_RETRY_DEBUG === "0" ? false : true;
// Probe tools (zen-scrape --zen-check, zen-exit-check --sweep) want one answer
// per exit, not a retry storm through the same exit.
const DISABLED = process.env.ZEN_RETRY_DISABLE === "1";

const log = (...args) => {
  console.error("[zen-retry]", ...args);
};

const isZen = (event) => {
  if (typeof event.model === "string") {
    if (event.model.startsWith("opencode/") || event.model.includes("opencode")) return true;
  }
  if (event.model?.providerID) {
    if (event.model.providerID === "opencode") return true;
  }
  if (event.model?.id && typeof event.model.id === "string") {
    if (event.model.id.startsWith("opencode/") || event.model.id.includes("opencode")) return true;
  }
  const url = event.request?.url;
  if (typeof url === "string" && (url.includes("opencode.ai/") || url.includes("/zen/"))) {
    return true;
  }
  const errStr = `${event.error?.name || ""} ${event.error?.message || ""} ${event.error?.type || ""}`;
  if (/FreeTierError|FreeUsageLimit|QuotaExceeded|opencode\.ai/i.test(errStr)) {
    return true;
  }
  return false;
};

/** Retire the relay's current tunnel. Best effort: a missing relay must not break the retry. */
const rotate = async (reason) => {
  try {
    log("rotating relay tunnel:", reason);
    const res = await fetch(`${CONTROL}?all=1&reason=${encodeURIComponent(reason)}`, {
      method: "POST",
      signal: AbortSignal.timeout(1500),
    });
    log("rotated:", reason, await res.text());
  } catch (error) {
    log("rotate failed:", reason, error?.message || error);
  }
};

let lastRotate = 0;
const rotateOnce = async (reason) => {
  const now = Date.now();
  if (now - lastRotate < 500) return;
  lastRotate = now;
  await rotate(reason);
};

/** Ask the relay to fetch and validate a fresh pool. The relay owns the lock/cooldown. */
const refetch = async (reason) => {
  try {
    const res = await fetch(REFETCH, {
      method: "POST",
      signal: AbortSignal.timeout(2500),
    });
    if (DEBUG) log("refetch", reason, await res.text());
  } catch (error) {
    if (DEBUG) log("refetch failed", reason, error?.message || error);
  }
};

let lastSchedule = 0;
const refetchLater = async (delayMs, reason) => {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  if (Date.now() - lastSchedule < 60000) return;
  lastSchedule = Date.now();
  try {
    const url = `${REFETCH}${REFETCH.includes("?") ? "&" : "?"}delayMs=${Math.round(delayMs)}`;
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(2500),
    });
    if (DEBUG) log("refetch scheduled", reason, await res.text());
  } catch (error) {
    if (DEBUG) log("refetch schedule failed", reason, error?.message || error);
  }
};

/** Seconds or an HTTP date from a Retry-After header. */
const retryAfterMs = (value) => {
  if (value === null || value === undefined || value === "") return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
};

/** Free-tier and quota bodies that OpenCode deliberately refuses to retry. */
const retryableBody = (body) =>
  typeof body === "string" &&
  /FreeTierError|FreeUsageLimitError|free[_-]?limit|usage limit|rate.?limit|QuotaExceeded/i.test(body);

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

      const reset = retryAfterMs(event.response.headers.get("retry-after"));
      if (reset > LONG_RETRY_MS) {
        log(
          "free-tier quota resets in",
          `${Math.round(reset / 60000)}m`,
          "at",
          new Date(Date.now() + reset).toISOString(),
          "- not rotating",
        );
        void refetchLater(reset, "http reset");
        return;
      }
      try {
        event.response.headers.set("x-should-retry", "true");
      } catch {
        // A response with immutable headers is still handled by the retry hook.
      }
    });

    // Force the retry even though OpenCode classifies free-tier responses as
    // quota/auth errors. Rotate first so the next attempt uses a new exit.
    await ctx.session.hook("retry", async (event) => {
      console.error("[zen-retry] RETRY HOOK FIRED!", {
        error: event.error?.message,
        type: event.error?.type,
        status: event.error?.status,
        model: event.model,
        keys: Object.keys(event)
      });
      const status = event.error?.status;
      const body = event.error?.response?.body;
      const type = event.error?.type;
      const errName = event.error?.name;
      const message = event.error?.message || "";
      const reset = Number(event.error?.retryAfterMs) || 0;
      const quota =
        status === 403 ||
        status === 429 ||
        type === "provider.free-limit" ||
        type === "provider.rate-limit" ||
        errName === "QuotaExceeded" ||
        retryableBody(body) ||
        retryableBody(message) ||
        retryableBody(String(event.error));
      if (quota && reset > LONG_RETRY_MS) {
        log(
          "free-tier quota resets in",
          `${Math.round(reset / 60000)}m`,
          "at",
          new Date(Date.now() + reset).toISOString(),
          "- stopping",
        );
        void refetchLater(reset, "retry reset");
        event.decision = { retry: false };
        return;
      }
      // A dead pool shows up as repeated transport failures, not 429s.
      const transport =
        type === "provider.transport" ||
        /ECONNRESET|ECONNREFUSED|socket connection|transport error/i.test(`${message}\n${body ?? ""}`);
      if (!quota && !transport) return;
      if (!isZen(event)) return;
      if (event.attempt > MAX_RETRIES) {
        log("retry budget exhausted; refetching", event.attempt);
        void refetch(`exhausted ${status ?? type}`);
        event.decision = { retry: false };
        return;
      }
      await rotateOnce(`retry ${status ?? type}`);
      const delay = reset > 0 ? Math.min(Math.max(reset, RETRY_DELAY_MS), 60000) : RETRY_DELAY_MS;
      event.decision = { retry: true, delay };
      log("forcing retry", event.attempt, status ?? type, `in ${delay}ms`);
    });
  },
};
