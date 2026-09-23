'use strict';

// Small shared helpers. No dependencies.

/** Monotonic clock in milliseconds (immune to wall-clock jumps / NTP). */
function hrNow() {
  return Number(process.hrtime.bigint()) / 1e6;
}

/** Promise-based sleep. */
function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Clamp a number into [min, max], falling back to def when not finite. */
function clampNumber(v, min, max, def) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Format a byte count into a human string. */
function fmtBytes(n) {
  if (!isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Strip credentials from a proxy URL (http://user:pass@host → http://***@host).
 * Anything persisted (reports), streamed (SSE), or displayed (dashboard, logs)
 * must use this — never the raw URL. Connection paths keep the full URL.
 */
function redactProxyUrl(proxy) {
  try {
    const u = new URL(proxy);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
      return u.toString();
    }
    return proxy;
  } catch (_) {
    return proxy;
  }
}

module.exports = { hrNow, sleep, clampNumber, fmtBytes, redactProxyUrl };
