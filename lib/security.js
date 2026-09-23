'use strict';

/**
 * Passive security scan — read-only checks against a target you own.
 * Makes a single GET (following up to 3 redirects) and inspects:
 *   - TLS certificate + protocol (https only)
 *   - security response headers
 *   - cookie flags
 *   - information disclosure via Server / X-Powered-By
 * No crawling, no fuzzing, no payloads — purely observational.
 */

const http = require('http');
const https = require('https');

const MAX_REDIRECTS = 3;

function fetchOnce(targetUrl, timeoutMs, tlsVerify) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return resolve({ error: 'BAD_URL' }); }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: (u.pathname || '/') + (u.search || ''),
      method: 'GET',
      headers: { 'user-agent': 'StromFire/1.0 (+self-hosted security scan)', accept: 'text/html,*/*' },
      timeout: timeoutMs,
      rejectUnauthorized: tlsVerify,
    }, (res) => {
      let tls = null;
      const sock = req.socket;
      if (sock && sock.getPeerCertificate) {
        try {
          const cert = sock.getPeerCertificate(true);
          if (cert && Object.keys(cert).length) {
            tls = {
              protocol: sock.getProtocol ? sock.getProtocol() : null,
              cipher: sock.getCipher ? (sock.getCipher() || {}).name || null : null,
              subject: cert.subject,
              issuer: (cert.issuer || {}).CN || null,
              validFrom: cert.valid_from,
              validTo: cert.valid_to,
            };
          }
        } catch (e) { /* ignore */ }
      }
      res.resume();
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers || {},
        tls,
        url: targetUrl,
      }));
      res.on('error', (e) => resolve({ error: (e && e.code) || 'RES_ERR' }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ error: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ error: (e && e.code) || 'ERR' }));
    req.end();
  });
}

async function fetchWithRedirects(targetUrl, timeoutMs, tlsVerify) {
  let url = targetUrl;
  let last = null;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    last = await fetchOnce(url, timeoutMs, tlsVerify);
    if (last.error) return last;
    const loc = last.headers.location;
    if (last.status >= 300 && last.status < 400 && loc) {
      try { url = new URL(loc, url).toString(); } catch (e) { break; }
      continue;
    }
    break;
  }
  if (last) last.finalUrl = url;
  return last;
}

function check(name, title, severity, passed, detail, recommendation) {
  return { id: name, title, severity, passed: !!passed, detail, recommendation };
}

function daysUntil(dateStr) {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 86400000);
}

async function runSecurityScan(targetUrl, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15000;
  const tlsVerify = opts.tlsVerify !== false;
  const started = Date.now();
  const res = await fetchWithRedirects(targetUrl, timeoutMs, tlsVerify);
  const findings = [];

  if (res.error || !res.status) {
    return {
      ok: false, url: targetUrl, ms: Date.now() - started,
      error: res.error || 'NO_RESPONSE',
      findings: [check('reachable', 'Target reachable', 'high', false,
        `Scan could not fetch the target (${res.error || 'no response'}).`,
        'Make sure the URL is correct and the site is up, then re-run.')],
      score: 0,
    };
  }

  const isHttps = new URL(res.finalUrl || targetUrl).protocol === 'https:';
  const h = {};
  for (const [k, v] of Object.entries(res.headers || {})) h[k.toLowerCase()] = v;

  findings.push(check('reachable', 'Target reachable', 'info', true,
    `HTTP ${res.status} from ${res.finalUrl || targetUrl} in ${Date.now() - started} ms.`,
    null));

  // ---- TLS ----
  if (isHttps) {
    if (res.tls) {
      const proto = res.tls.protocol || '';
      const weakProto = /TLSv1(\.0)?$/.test(proto) || proto === 'SSLv3' || proto === '';
      findings.push(check('tls-protocol', 'TLS protocol version', weakProto ? 'high' : 'info', !weakProto,
        `Negotiated ${proto || 'unknown'} with ${res.tls.cipher || 'unknown cipher'}.`,
        weakProto ? 'Disable TLS 1.0/1.1 on the server; use TLS 1.2+ (1.3 preferred).' : null));
      const days = daysUntil(res.tls.validTo);
      const expiring = days === null || days < 0;
      const soon = !expiring && days < 30;
      findings.push(check('tls-cert', 'Certificate validity', expiring ? 'high' : (soon ? 'medium' : 'info'),
        !expiring,
        expiring ? `Certificate EXPIRED (${res.tls.validTo}).`
          : `Valid until ${res.tls.validTo} (${days} days left), issued by ${res.tls.issuer || 'unknown'}.`,
        expiring ? 'Renew the certificate immediately.' : (soon ? 'Renew the certificate soon.' : null)));
    } else {
      findings.push(check('tls-cert', 'Certificate details', 'low', true,
        'Certificate details unavailable (connection reused or no peer cert exposed).', null));
    }
    const hsts = h['strict-transport-security'];
    findings.push(check('hsts', 'HSTS header', hsts ? 'info' : 'medium', !!hsts,
      hsts ? `Present: ${hsts}` : 'Missing Strict-Transport-Security.',
      hsts ? null : 'Add: Strict-Transport-Security: max-age=31536000; includeSubDomains'));
  }

  // ---- security headers ----
  const csp = h['content-security-policy'];
  findings.push(check('csp', 'Content-Security-Policy', csp ? 'info' : 'medium', !!csp,
    csp ? 'Present.' : 'Missing — the page has no CSP, raising XSS/clickjacking risk.',
    csp ? null : 'Add a Content-Security-Policy appropriate for the app.'));
  const xfo = h['x-frame-options'] || (csp && /frame-ancestors/.test(csp) ? 'via-csp' : null);
  findings.push(check('x-frame-options', 'Clickjacking protection', xfo ? 'info' : 'low', !!xfo,
    xfo ? `Protected (${xfo === 'via-csp' ? 'frame-ancestors in CSP' : xfo}).` : 'Missing X-Frame-Options and no frame-ancestors in CSP.',
    xfo ? null : 'Add X-Frame-Options: SAMEORIGIN (or frame-ancestors in CSP).'));
  const xcto = h['x-content-type-options'];
  findings.push(check('x-content-type-options', 'MIME sniffing protection', xcto ? 'info' : 'low', !!xcto,
    xcto ? `Present: ${xcto}` : 'Missing X-Content-Type-Options.',
    xcto ? null : 'Add X-Content-Type-Options: nosniff.'));
  const rp = h['referrer-policy'];
  findings.push(check('referrer-policy', 'Referrer policy', rp ? 'info' : 'low', !!rp,
    rp ? `Present: ${rp}` : 'Missing Referrer-Policy (browser default may leak full URLs).',
    rp ? null : 'Add Referrer-Policy: strict-origin-when-cross-origin (or stricter).'));

  // ---- cookies ----
  const setCookies = res.headers['set-cookie'] || [];
  if (setCookies.length) {
    const weak = [];
    for (const c of setCookies) {
      const parts = c.split(';').map((s) => s.trim().toLowerCase());
      const name = c.split('=')[0];
      const flags = [];
      if (isHttps && !parts.includes('secure')) flags.push('Secure');
      if (!parts.includes('httponly')) flags.push('HttpOnly');
      if (!parts.some((p) => p.startsWith('samesite'))) flags.push('SameSite');
      if (flags.length) weak.push(`${name} (missing: ${flags.join(', ')})`);
    }
    findings.push(check('cookie-flags', 'Cookie flags', weak.length ? 'low' : 'info', !weak.length,
      weak.length ? `${setCookies.length} cookie(s); weak flags on: ${weak.join('; ')}` : `${setCookies.length} cookie(s), all carry Secure/HttpOnly/SameSite.`,
      weak.length ? 'Set Secure, HttpOnly and SameSite on session cookies.' : null));
  } else {
    findings.push(check('cookie-flags', 'Cookie flags', 'info', true, 'No cookies set on this response.', null));
  }

  // ---- info disclosure ----
  const server = h['server'];
  const powered = h['x-powered-by'];
  findings.push(check('server-disclosure', 'Server banner disclosure',
    (server || powered) ? 'low' : 'info', !(server || powered),
    (server || powered) ? `Reveals: ${[server && `Server: ${server}`, powered && `X-Powered-By: ${powered}`].filter(Boolean).join(', ')}` : 'No server banner disclosed.',
    (server || powered) ? 'Hide or genericise the Server / X-Powered-By headers.' : null));

  const weights = { high: 25, medium: 10, low: 4, info: 0 };
  let score = 100;
  for (const f of findings) if (!f.passed) score -= (weights[f.severity] || 0);
  score = Math.max(0, score);

  return {
    ok: true, url: targetUrl, finalUrl: res.finalUrl || targetUrl,
    status: res.status, ms: Date.now() - started, score, findings,
  };
}

module.exports = { runSecurityScan };
