'use strict';

// Safety helpers for a self-hosted load tester.
//
// Strom Fire is for testing systems YOU own or are explicitly authorised to test.
// These helpers are guardrails, not a substitute for the user's own judgement or
// for the law.

const { URL } = require('url');

// Well-known third-party hosts that must never be load-tested by accident.
// (Kept deliberately small; it is a tripwire, not a complete blocklist.)
const KNOWN_PUBLIC_HOSTS = [
  'google.com', 'www.google.com', 'bing.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'amazon.com', 'wikipedia.org', 'twitter.com', 'x.com',
  'linkedin.com', 'github.com', 'cloudflare.com', 'microsoft.com', 'apple.com',
  'netflix.com', 'reddit.com', 'tiktok.com', 'paypal.com', 'stripe.com',
  'openai.com', 'anthropic.com', 'baidu.com', 'yandex.com', 'whatsapp.com',
];

function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isBlockedIP(ip) {
  if (!ip) return false;
  // IPv4 literal (incl. mapped ::ffff:a.b.c.d)
  const v4 = ip.replace(/^::ffff:/i, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return isPrivateIPv4(v4);
  const low = ip.toLowerCase();
  // IPv6 loopback / link-local / unique-local / unspecified
  if (low === '::1' || low === '::' || low === '::ffff:127.0.0.1') return true;
  if (low.startsWith('fe80:') || low.startsWith('fec0:') || low.startsWith('fc00:') || low.startsWith('fd00:')) return true;
  return false;
}

/**
 * Validate a target string.
 * @returns {{ok:boolean, reason?:string, level:'ok'|'warn'|'block', host?:string, scheme?:string, kind?:string}}
 */
function validateTarget(target) {
  const t = String(target || '').trim();
  if (!t) return { ok: false, level: 'block', reason: 'Target is empty.' };
  if (!/^https?:\/\//i.test(t)) {
    return { ok: false, level: 'block', reason: 'Only http:// and https:// targets are supported.' };
  }
  let u;
  try {
    u = new URL(t);
  } catch (e) {
    return { ok: false, level: 'block', reason: 'Target is not a valid URL.' };
  }
  const host = u.hostname.toLowerCase();

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, level: 'block', reason: 'Only http and https are supported.' };
  }

  const bare = host.replace(/^www\./, '');
  if (KNOWN_PUBLIC_HOSTS.includes(host) || KNOWN_PUBLIC_HOSTS.includes(bare)) {
    return {
      ok: false,
      level: 'block',
      host,
      scheme: u.protocol,
      reason: `${host} is a well-known third-party site. Strom Fire will not test domains you do not own. Point it at your own host or a staging URL.`,
    };
  }

  const localhostNames = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
  const isLocal = localhostNames.includes(host) || host.endsWith('.local') || host.endsWith('.localhost');
  const isPrivate = isLocal || isPrivateIPv4(host);

  return {
    ok: true,
    level: 'ok',
    host,
    scheme: u.protocol,
    kind: isPrivate ? 'private' : 'public',
  };
}

function isMetadataIP(ip) {
  if (!ip) return false;
  const v4 = String(ip).replace(/^::ffff:/i, '');
  // Cloud instance-metadata + link-local: never valid load targets
  if (v4 === '169.254.169.254' || v4 === '169.254.169.253') return true;
  if (/^169\.254\./.test(v4)) return true;
  const low = String(ip).toLowerCase();
  if (low === '::' || low === '0.0.0.0') return true;
  if (low.startsWith('fe80:')) return true;
  return false;
}

/**
 * Async DNS-level validation (SSRF guard for DNS rebinding).
 * Policy: explicit literal private IPs (192.168.x, 10.x, loopback demo) are
 * ALLOWED — readme documents testing your own LAN. Hostnames that RESOLVE to
 * private/link-local/metadata are BLOCKED (rebinding). Metadata IP is always
 * blocked even as a literal.
 * Sync validateTarget() stays fast-path only; call this in /api/start.
 */
async function validateTargetResolved(target) {
  const base = validateTarget(target);
  if (!base.ok) return base;
  let hostname;
  try {
    hostname = new URL(String(target)).hostname;
  } catch (e) {
    return { ok: false, level: 'block', reason: 'Target is not a valid URL.' };
  }
  // Literal IP: allow explicit private/LAN (user chose it), block metadata only.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
    if (isMetadataIP(hostname)) {
      return { ok: false, level: 'block', host: hostname, reason: `${hostname} is cloud metadata/link-local and is never a valid load target.` };
    }
    return base;
  }
  try {
    const dns = require('dns').promises;
    const addrs = await dns.lookup(hostname, { all: true });
    const meta = addrs.find((a) => isMetadataIP(a.address));
    if (meta) {
      return { ok: false, level: 'block', host: hostname, reason: `${hostname} resolves to ${meta.address} (metadata/link-local). Blocked to prevent SSRF.` };
    }
    const priv = addrs.find((a) => isBlockedIP(a.address) && !isLoopbackAllowed(a.address));
    if (priv) {
      return { ok: false, level: 'block', host: hostname, reason: `${hostname} resolves to ${priv.address} (private network). Use the literal IP if you own it, or the demo target.` };
    }
  } catch (e) {
    return { ok: false, level: 'block', host: hostname, reason: `Could not resolve target host: ${e.code || e.message}` };
  }
  return base;
}

function isLoopbackAllowed(host) {
  // Loopback is the normal case for the built-in demo target; allow it here —
  // the sync check already labels it kind:'private'. Cloud metadata 169.254.x
  // is never allowed even though isPrivateIPv4() also matches it.
  const h = String(host).toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  return false;
}

/** Extract the host string from a target without throwing. */
function targetHost(target) {
  try {
    return new URL(String(target)).host;
  } catch (e) {
    return null;
  }
}

module.exports = { validateTarget, validateTargetResolved, targetHost, isPrivateIPv4, isBlockedIP, isMetadataIP, KNOWN_PUBLIC_HOSTS };
