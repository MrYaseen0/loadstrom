'use strict';

const http = require('http');
const https = require('https');
const http2 = require('http2');
const tls = require('tls');
const net = require('net');
const dns = require('dns');
const { URL } = require('url');
const { Metrics } = require('./metrics');
const { evaluate } = require('./verdict');
const { hrNow, sleep, clampNumber, redactProxyUrl } = require('./util');

const DEFAULT_HEADERS = {
  'user-agent': 'StromFire/1.0 (+self-hosted load test)',
  accept: '*/*',
  'accept-encoding': 'gzip, deflate, br',
};

/** Header fingerprint profiles for anonymity */
const HEADER_PROFILES = {
  'desktop-chrome': {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  },
  'desktop-firefox': {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.5',
    'accept-encoding': 'gzip, deflate, br',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
  },
  'desktop-safari': {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
  },
  'mobile-chrome': {
    'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
  },
  'api-client': {
  'user-agent': 'StromFire/1.0 (+self-hosted load test)',
    accept: 'application/json, text/plain, */*',
    'accept-encoding': 'gzip, deflate, br',
  },
  'minimal': {
    'user-agent': 'Mozilla/5.0 (compatible; StromFire/1.0)',
    accept: '*/*',
    'accept-encoding': 'gzip, deflate',
  },
};

/** TLS fingerprint profiles for ClientHello spoofing */
const TLS_FINGERPRINTS = {
  'chrome120': {
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-RSA-AES128-SHA',
      'ECDHE-RSA-AES256-SHA',
      'AES128-GCM-SHA256',
      'AES256-GCM-SHA384',
      'AES128-SHA',
      'AES256-SHA',
    ],
    sigAlgs: ['ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256', 'rsa_pkcs1_sha384', 'rsa_pkcs1_sha512'],
    curves: ['X25519', 'P-256', 'P-384'],
  },
  'firefox121': {
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES128-SHA',
      'ECDHE-RSA-AES256-SHA',
    ],
    sigAlgs: ['ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256'],
    curves: ['X25519', 'P-256', 'P-384', 'P-521'],
  },
  'safari17': {
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-RSA-AES256-SHA',
      'ECDHE-RSA-AES128-SHA',
    ],
    sigAlgs: ['ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256', 'rsa_pkcs1_sha384'],
    curves: ['X25519', 'P-256', 'P-384'],
  },
  'ios17': {
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES128-GCM-SHA256',
    ],
    sigAlgs: ['ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256'],
    curves: ['X25519', 'P-256'],
  },
};

function getTlsFingerprint(profileName) {
  return TLS_FINGERPRINTS[profileName] || TLS_FINGERPRINTS['chrome120'];
}

/**
 * Build Node tls.connect options from a fingerprint profile.
 * Node separates TLS1.3 ciphersuites from TLS1.2 ciphers and uses `groups`
 * (alias `curves` on older versions) — passing TLS_AES_* via `ciphers` is a no-op.
 */
function tlsOptionsForFingerprint(profileName, extra = {}) {
  const fp = getTlsFingerprint(profileName);
  const ciphers13 = (fp.ciphers || []).filter((c) => c.startsWith('TLS_'));
  const ciphers12 = (fp.ciphers || []).filter((c) => !c.startsWith('TLS_'));
  const opts = Object.assign(
    {
      rejectUnauthorized: true,
      minVersion: fp.minVersion,
      maxVersion: fp.maxVersion,
    },
    extra
  );
  if (ciphers12.length) opts.ciphers = ciphers12.join(':');
  if (ciphers13.length) opts.ciphersuites = ciphers13.join(':');
  if (fp.sigAlgs && fp.sigAlgs.length) opts.sigalgs = fp.sigAlgs.join(':');
  if (fp.curves && fp.curves.length) {
    opts.groups = fp.curves.join(':');
    opts.curves = fp.curves.join(':'); // compat alias for older Node
  }
  return opts;
}

function proxyAuthHeader(proxyUser, proxyPass) {
  if (!proxyUser) return null;
  return `Basic ${Buffer.from(`${proxyUser}:${proxyPass || ''}`).toString('base64')}`;
}

function buildConnectHeaders(proxyUser, proxyPass) {
  const h = { 'User-Agent': 'StromFire/1.0' };
  const auth = proxyAuthHeader(proxyUser, proxyPass);
  if (auth) h['Proxy-Authorization'] = auth;
  return h;
}

/**
 * Shared HTTP(S)-proxy (CONNECT) agent factory — single implementation used by
 * both _createAgent() and _createProxyAgent() (was duplicated 2×).
 * NOTE: the hook MUST be assigned as agent.createConnection (method override).
 * Passing createConnection inside the Agent constructor options is silently
 * ignored on modern Node (verified v26: custom fn never called, requests go
 * DIRECT with no error) — which would bypass the proxy entirely.
 */
function createHttpProxyAgent(mod, o) {
  const agent = new mod.Agent({
    keepAlive: o.keepAlive,
    keepAliveMsecs: 30000,
    maxSockets: o.maxSockets,
    maxFreeSockets: 256,
    timeout: o.timeoutMs,
    scheduling: 'fifo',
    noDelay: true,
  });
  agent.createConnection = (opts, cb) => {
      const isTargetHttps = opts.protocol === 'https:';
      const connectHost = opts.hostname;
      const connectPort = opts.port || (isTargetHttps ? 443 : 80);
      const connectReq = http.request({
        hostname: o.proxyHost,
        port: o.proxyPort,
        method: 'CONNECT',
        path: `${connectHost}:${connectPort}`,
        headers: buildConnectHeaders(o.proxyUser, o.proxyPass),
        agent: false,
        timeout: o.timeoutMs,
      });
      let settled = false;
      const done = (fn) => (...a) => { if (settled) return; settled = true; fn(...a); };
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          try { socket.destroy(); } catch (_) {}
          return cb(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
        }
        if (isTargetHttps) {
          const tlsSocket = tls.connect(tlsOptionsForFingerprint(o.tlsFingerprint, {
            socket,
            servername: connectHost,
            rejectUnauthorized: o.tlsVerify,
          }), done(() => cb(null, tlsSocket)));
          tlsSocket.on('error', done(cb));
          tlsSocket.setTimeout(o.timeoutMs, () => { try { tlsSocket.destroy(); } catch (_) {} done(cb)(new Error('Proxy TLS timeout')); });
        } else {
          cb(null, socket);
        }
      });
      connectReq.on('error', done(cb));
      connectReq.on('timeout', () => { try { connectReq.destroy(); } catch (_) {} done(cb)(new Error('Proxy connection timeout')); });
      connectReq.end();
  };
  return agent;
}

/**
 * Shared SOCKS5 agent factory — single implementation used by both agent paths.
 * Same method-override requirement as above: constructor-option
 * createConnection is silently ignored (proxy silently bypassed).
 */
function createSocksAgent(mod, o) {
  const agent = new mod.Agent({
    keepAlive: o.keepAlive,
    keepAliveMsecs: 30000,
    maxSockets: o.maxSockets,
    maxFreeSockets: 256,
    timeout: o.timeoutMs,
    scheduling: 'fifo',
    noDelay: true,
  });
  agent.createConnection = (opts, cb) => {
      const isTargetHttps = opts.protocol === 'https:';
      const targetHost = opts.hostname;
      const targetPort = opts.port || (isTargetHttps ? 443 : 80);
      let settled = false;
      const done = (e, s) => { if (settled) return; settled = true; cb(e, s); };
      const socket = net.createConnection({ host: o.proxyHost, port: o.proxyPort }, () => {
        const authMethods = o.proxyUser ? [0x00, 0x02] : [0x00];
        socket.write(Buffer.from([0x05, authMethods.length, ...authMethods]));
        socket.once('data', (handshakeResp) => {
          if (!handshakeResp || handshakeResp[1] === 0xff) {
            try { socket.destroy(); } catch (_) {}
            return done(new Error('SOCKS5: no acceptable auth method'));
          }
          if (handshakeResp[1] === 0x02 && o.proxyUser) {
            const userBuf = Buffer.from(o.proxyUser);
            const passBuf = Buffer.from(o.proxyPass || '');
            socket.write(Buffer.concat([Buffer.from([0x01, userBuf.length]), userBuf, Buffer.from([passBuf.length]), passBuf]));
            socket.once('data', (authResp) => {
              if (!authResp || authResp[1] !== 0x00) {
                try { socket.destroy(); } catch (_) {}
                return done(new Error('SOCKS5 auth failed'));
              }
              doSocksConnect();
            });
          } else {
            doSocksConnect();
          }
        });
        const doSocksConnect = () => {
          const hostBuf = Buffer.from(targetHost);
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(targetPort, 0);
          socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf]));
          socket.once('data', (connectResp) => {
            if (!connectResp || connectResp[1] !== 0x00) {
              try { socket.destroy(); } catch (_) {}
              return done(new Error(`SOCKS5 connect failed: ${connectResp && connectResp[1]}`));
            }
            if (isTargetHttps) {
              const tlsSocket = tls.connect(tlsOptionsForFingerprint(o.tlsFingerprint, {
                socket,
                servername: targetHost,
                rejectUnauthorized: o.tlsVerify,
              }), () => done(null, tlsSocket));
              tlsSocket.on('error', done);
              tlsSocket.setTimeout(o.timeoutMs, () => { try { tlsSocket.destroy(); } catch (_) {} done(new Error('SOCKS5 TLS timeout')); });
            } else {
              done(null, socket);
            }
          });
        };
      });
      socket.on('error', done);
      socket.setTimeout(o.timeoutMs, () => { try { socket.destroy(); } catch (_) {} done(new Error('SOCKS5 connection timeout')); });
  };
  return agent;
}

function getHeaderProfile(profileName) {
  return HEADER_PROFILES[profileName] || HEADER_PROFILES['desktop-chrome'];
}

function rotateHeaders(baseHeaders, profileName) {
  const profile = getHeaderProfile(profileName);
  const out = { ...DEFAULT_HEADERS };
  Object.assign(out, profile);
  Object.assign(out, baseHeaders);
  if (out['accept-language']) {
    const langs = out['accept-language'].split(',');
    if (langs.length > 1 && Math.random() < 0.3) {
      out['accept-language'] = langs.sort(() => Math.random() - 0.5).join(',');
    }
  }
  return out;
}

const CONNECTION_PHASES = ['dns', 'tcp', 'tls', 'ttfb', 'download'];

function normalizeHeaders(h, rotate = true, profile = 'desktop-chrome') {
  if (!h) return rotate ? getHeaderProfile(profile) : Object.assign({}, DEFAULT_HEADERS);
  let obj = h;
  if (typeof h === 'string') {
    const t = h.trim();
    if (!t) return rotate ? getHeaderProfile(profile) : Object.assign({}, DEFAULT_HEADERS);
    try {
      obj = JSON.parse(t);
    } catch (e) {
      throw new Error('Headers must be a JSON object, e.g. {"Authorization":"Bearer x"}');
    }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Headers must be a JSON object');
  }
  if (rotate) {
    return rotateHeaders(obj, profile);
  }
  const out = Object.assign({}, DEFAULT_HEADERS);
  for (const [k, v] of Object.entries(obj)) {
    out[String(k)] = String(v);
  }
  return out;
}

/**
 * Validate + normalize a raw config coming from the API/UI.
 * Throws Error with a user-friendly message on invalid input.
 */
function normalizeConfig(raw = {}) {
  const target = String(raw.url || raw.target || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('Target must be a full URL starting with http:// or https:// (e.g. https://example.com or http://192.168.1.10:8080).');
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    throw new Error('Invalid target URL.');
  }
  if (!parsed.hostname) throw new Error('Invalid target host.');

  const mode = raw.mode === 'stress' ? 'stress' : 'load';
  const rotateHeaders = raw.rotateHeaders !== false;
  const headerProfile = raw.headerProfile || 'desktop-chrome';

  const cfg = {
    url: target,
    host: parsed.host,
    method: String(raw.method || 'GET').toUpperCase(),
    headers: normalizeHeaders(raw.headers, rotateHeaders, headerProfile),
    body: raw.body != null && raw.body !== '' ? String(raw.body) : null,
    mode,
    concurrency: Math.round(clampNumber(raw.concurrency, 1, 10000, 100)),
    rps: Math.max(0, Math.round(clampNumber(raw.rps, 0, 500000, 0))),
    durationSec: raw.durationSec === 0 ? 0 : clampNumber(raw.durationSec, 1, 7200, 30), // 0 = unlimited
    rampUpSec: clampNumber(raw.rampUpSec, 0, 3600, 0),
    timeoutMs: clampNumber(raw.timeoutMs, 100, 120000, 15000),
    tlsVerify: raw.tlsVerify !== false,
    followRedirects: raw.followRedirects !== false,
    maxRedirects: Math.round(clampNumber(raw.maxRedirects, 0, 10, 5)),
    sampleCap: Math.round(clampNumber(raw.sampleCap, 1000, 2000000, 200000)),
    abortOnErrorRatePct: clampNumber(raw.abortOnErrorRatePct, 0, 100, 10),
    httpVersion: raw.httpVersion === '2' ? '2' : '1.1',
    trackPhases: raw.trackPhases !== false,
    pacing: raw.pacing === 'precise' ? 'precise' : 'standard',
    // Anonymity / proxy - enhanced
    proxy: raw.proxy ? String(raw.proxy).trim() : null,           // http://user:pass@host:port or socks5://host:port
    proxyList: Array.isArray(raw.proxyList) ? raw.proxyList.filter(Boolean) : [], // multiple proxies for rotation
    proxyAuth: raw.proxyAuth ? String(raw.proxyAuth).trim() : null,
    rotateHeaders: raw.rotateHeaders !== false,
    headerProfile: raw.headerProfile || 'desktop-chrome',
    requestJitterMs: clampNumber(raw.requestJitterMs, 0, 5000, 0),
    // Enhanced anonymity
    isolateCookies: raw.isolateCookies !== false,        // separate cookie jar per virtual user
    simulateUserSession: raw.simulateUserSession === true, // opt-in: adds 500-3500ms think time, kills RPS if left on
    tlsFingerprint: raw.tlsFingerprint || 'chrome120',   // TLS client hello fingerprint
    reuseConnections: raw.reuseConnections !== false,    // HTTP keep-alive like real browsers
    requestOrderRandomization: raw.requestOrderRandomization !== false, // shuffle request order
    cookieStorePath: raw.cookieStorePath ? String(raw.cookieStorePath) : null, // persist cookies to disk
    gracefulShutdownMs: clampNumber(raw.gracefulShutdownMs, 0, 30000, 0), // wait for in-flight requests
    // Auto-rotation (bypass IP blocks) — OPT-IN (default false) so the
    // auto-abort safety valve stays armed by default. With rotation on, the
    // valve degrades to an extreme backstop (max(threshold,50)% after 500
    // requests) instead of switching off, and only acts when a proxy is
    // configured (see _worker: requires cfg.proxy).
    autoRotate: raw.autoRotate === true,
    torControlPort: clampNumber(raw.torControlPort, 1024, 65535, 9151), // Tor control port
    blockThresholdPct: clampNumber(raw.blockThresholdPct, 10, 100, 70), // % errors to trigger rotation
    proxyHealthFails: Math.round(clampNumber(raw.proxyHealthFails, 2, 50, 5)), // consecutive transport fails before a pool member is skipped
    proxyHealthCooldownMs: Math.round(clampNumber(raw.proxyHealthCooldownMs, 5000, 600000, 60000)), // how long a skipped member stays out
    thresholds: {
      maxErrorRatePct: clampNumber(raw.thresholds && raw.thresholds.maxErrorRatePct, 0, 100, 1),
      maxP95Ms: clampNumber(raw.thresholds && raw.thresholds.maxP95Ms, 1, 600000, 1000),
      minRps: clampNumber(raw.thresholds && raw.thresholds.minRps, 0, 5000000, 0),
    },
    stress: {
      start: Math.round(clampNumber(raw.stress && raw.stress.start, 1, 5000, 50)),
      step: Math.round(clampNumber(raw.stress && raw.stress.step, 1, 5000, 50)),
      max: Math.round(clampNumber(raw.stress && raw.stress.max, 1, 5000, 500)),
      stepDurationSec: clampNumber(raw.stress && raw.stress.stepDurationSec, 1, 600, 30),
    },
    h2Settings: raw.h2Settings && typeof raw.h2Settings === 'object' ? raw.h2Settings : {},
  };

  if (cfg.method === 'GET' || cfg.method === 'HEAD') cfg.body = null;
  if (cfg.body && !cfg.headers['content-type']) {
    cfg.headers['content-type'] = 'application/json';
  }
  if (cfg.body) cfg.headers['content-length'] = Buffer.byteLength(cfg.body);

  if (!cfg.stress || cfg.stress.max < cfg.stress.start) cfg.stress.max = cfg.stress.start;

  return cfg;
}

class LoadEngine {
  constructor(rawCfg, opts = {}) {
    this.cfg = normalizeConfig(rawCfg);
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

    this.global = new Metrics({ sampleCap: this.cfg.sampleCap, trackPhases: this.cfg.trackPhases });
    this.phase = new Metrics({ sampleCap: Math.min(this.cfg.sampleCap, 100000), trackPhases: this.cfg.trackPhases });

    this.state = 'idle'; // idle | running | stopping | finished | error
    this.error = null;
    this.steps = [];
    this.breakingPoint = null;
    this.stopRequested = false;
    this.abortReason = null;
    this.inflight = 0;
    this.activeWorkers = 0;
    this.phaseLabel = '';
    this.startedAtMs = null;
    this.finishedAtMs = null;
    this.finalSummary = null;
    this._agents = new Map();
    this._h2Sessions = new Map();
    this._generation = 0; // increments per run(); guards stop()/finish race
    this._lastSnapshotAt = 0;
    this._lastSnapshot = null;

    this.maxSockets = Math.min(Math.max(this.cfg.concurrency, this.cfg.stress.max), 5000) + 32;
    if (this.cfg.concurrency >= 1000 || this.cfg.stress.max >= 1000) {
      console.warn(`[stromfire] high concurrency (${this.cfg.concurrency}/${this.cfg.stress.max}) — on Linux raise fds first: ulimit -n 65536. Sockets capped at ${this.maxSockets}.`);
    }

    // Per-virtual-user state for isolation
    this._userStates = new Map(); // userId -> { cookies, session, proxyIndex }
    this._nextUserId = 0;

    // Auto-rotation state (block detection + IP switching)
    this._autoRotate = this.cfg.autoRotate || false;
    this._blockDetectionWindow = 20; // new requests since last rotation before re-checking
    this._blockThresholdPct = this.cfg.blockThresholdPct || 70; // % timeouts/errors to trigger rotation
    // Tor enforces NEWNYM itself (~10s between new circuits); hammering the
    // control port faster only yields timeouts. Non-Tor proxies cool down 5s.
    const _isTorProxy = /127\.0\.0\.1:(9150|9050)/.test(this.cfg.proxy || '');
    this._rotationCooldownMs = _isTorProxy ? 10000 : 5000;
    this._lastRotationAt = 0;
    this._rotationCount = 0;
    this._rotationInFlight = false; // single-flight guard: one rotation at a time
    this._lastRotationAttempted = 0; // global.attempted at last rotation (delta window)
    this._lastRotationTimeouts = 0;
    this._lastRotationFailed = 0;
    this._blockedProxies = new Set(); // proxies that got blocked (redacted URLs)
    this._proxyHealth = new Map(); // full proxy URL -> { fails, skipUntil } (pool auto-skip; internal only, never persisted)
    this._torControlPort = this.cfg.torControlPort || 9151; // Tor Browser control port

    // Cookie persistence
    if (this.cfg.cookieStorePath) {
      this._loadCookies();
    }
  }

  _loadCookies() {
    try {
      const fs = require('fs');
      const data = JSON.parse(fs.readFileSync(this.cfg.cookieStorePath, 'utf8'));
      if (data && typeof data === 'object') {
        for (const [userId, cookies] of Object.entries(data)) {
          const state = this._getOrCreateUserState(Number(userId));
          for (const [name, val] of Object.entries(cookies)) {
            state.cookies.set(name, val);
          }
        }
      }
    } catch (_) { /* file doesn't exist or invalid — start fresh */ }
  }

  _saveCookies() {
    if (!this.cfg.cookieStorePath) return;
    try {
      const fs = require('fs');
      const data = {};
      for (const [userId, state] of this._userStates.entries()) {
        if (state.cookies.size > 0) {
          data[userId] = Object.fromEntries(state.cookies);
        }
      }
      fs.writeFileSync(this.cfg.cookieStorePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (_) { /* ignore write errors */ }
  }

  publicConfig() {
    return {
      url: this.cfg.url,
      host: this.cfg.host,
      method: this.cfg.method,
      mode: this.cfg.mode,
      concurrency: this.cfg.concurrency,
      rps: this.cfg.rps,
      durationSec: this.cfg.durationSec,
      rampUpSec: this.cfg.rampUpSec,
      timeoutMs: this.cfg.timeoutMs,
      httpVersion: this.cfg.httpVersion,
      trackPhases: this.cfg.trackPhases,
      pacing: this.cfg.pacing,
      thresholds: this.cfg.thresholds,
      stress: this.cfg.stress,
      headers: Object.keys(this.cfg.headers),
      hasBody: !!this.cfg.body,
      // Auto-rotation config
      autoRotate: this.cfg.autoRotate,
      torControlPort: this.cfg.torControlPort,
      blockThresholdPct: this.cfg.blockThresholdPct,
    };
  }

  _cacheAgent(key, factory) {
    let a = this._agents.get(key);
    if (a) {
      // LRU refresh
      this._agents.delete(key);
      this._agents.set(key, a);
      return a;
    }
    a = factory();
    this._agents.set(key, a);
    // Cap pooled agents (proxyList rotation could otherwise grow unbounded)
    const MAX_AGENTS = 12;
    while (this._agents.size > MAX_AGENTS) {
      const oldest = this._agents.keys().next().value;
      try { this._agents.get(oldest).destroy(); } catch (_) { /* ignore */ }
      this._agents.delete(oldest);
    }
    return a;
  }

  _agent(isHttps) {
    const key = isHttps ? 'https' : 'http';
    return this._cacheAgent(key, () => this._createAgent(isHttps));
  }

  _proxyOpts(proxy) {
    let proxyUrl;
    try {
      proxyUrl = new URL(proxy);
    } catch (e) {
      throw new Error(`Invalid proxy URL: ${proxy}`);
    }
    const proxyProtocol = proxyUrl.protocol;
    const proxyPort = Number(proxyUrl.port) || (proxyProtocol === 'https:' ? 443 : proxyProtocol === 'socks5:' ? 1080 : 8080);
    const proxyAuth = this.cfg.proxyAuth;
    return {
      proxyProtocol,
      proxyHost: proxyUrl.hostname,
      proxyPort,
      proxyUser: proxyUrl.username || (proxyAuth ? proxyAuth.split(':')[0] : ''),
      proxyPass: proxyUrl.password || (proxyAuth ? proxyAuth.split(':')[1] : ''),
      keepAlive: this.cfg.reuseConnections,
      maxSockets: this.maxSockets,
      timeoutMs: this.cfg.timeoutMs,
      tlsFingerprint: this.cfg.tlsFingerprint,
      tlsVerify: this.cfg.tlsVerify,
    };
  }

  _buildProxiedAgent(mod, proxy) {
    const o = this._proxyOpts(proxy);
    if (o.proxyProtocol === 'http:' || o.proxyProtocol === 'https:') return createHttpProxyAgent(mod, o);
    if (o.proxyProtocol === 'socks5:') return createSocksAgent(mod, o);
    throw new Error(`Unsupported proxy protocol: ${o.proxyProtocol}`);
  }

  _createAgent(isHttps) {
    const mod = isHttps ? https : http;
    const proxy = this.cfg.proxy;
    // No proxy - direct connection
    if (!proxy) {
      return new mod.Agent({
        keepAlive: this.cfg.reuseConnections,
        keepAliveMsecs: 30000,
        maxSockets: this.maxSockets,
        maxFreeSockets: 256,
        timeout: this.cfg.timeoutMs,
        scheduling: 'fifo',
        noDelay: true,
      });
    }
    return this._buildProxiedAgent(mod, proxy);
  }

  _h2Session(authority) {
    let session = this._h2Sessions.get(authority);
    if (!session || session.destroyed || session.closed) {
      const isHttps = authority.startsWith('https:');
      const url = new URL(authority);
      const h2s = this.cfg.h2Settings || {};
      session = http2.connect(authority, {
        maxSessionMemory: 64 * 1024 * 1024,
        settings: {
          headerTableSize: h2s.headerTableSize || 4096,
          enablePush: h2s.enablePush !== undefined ? h2s.enablePush : false,
          maxConcurrentStreams: h2s.maxConcurrentStreams || this.maxSockets,
          initialWindowSize: h2s.initialWindowSize || 65535,
          maxFrameSize: h2s.maxFrameSize || 16384,
          maxHeaderListSize: h2s.maxHeaderListSize || 262144,
        },
        createConnection: () => {
          // http2 calls createConnection(authority, options) and expects the
          // connected TLSSocket returned synchronously (no callback form).
          // h2 is only used for https targets — negotiate h2 via ALPN and
          // honour the TLS fingerprint + verification settings like the h1 path.
          return tls.connect(tlsOptionsForFingerprint(this.cfg.tlsFingerprint, {
            host: url.hostname,
            port: url.port || 443,
            servername: url.hostname,
            rejectUnauthorized: this.cfg.tlsVerify,
            timeout: this.cfg.timeoutMs,
            ALPNProtocols: ['h2'],
          }));
        },
      });
      session.on('error', () => {});
      this._h2Sessions.set(authority, session);
    }
    return session;
  }

  _closeAgents() {
    for (const a of this._agents.values()) {
      try { a.destroy(); } catch (e) { /* ignore */ }
    }
    this._agents.clear();
    for (const s of this._h2Sessions.values()) {
      try { s.destroy(); } catch (e) { /* ignore */ }
    }
    this._h2Sessions.clear();
  }

  /** One HTTP request (follows redirects up to redirectsLeft). Never rejects. */
  _requestOnce(url, redirectsLeft, userState, accumulatedPhases) {
    return new Promise((resolve) => {
      let u;
      try {
        u = new URL(url);
      } catch (e) {
        return resolve({ kind: 'error', errCode: 'BAD_URL', latencyMs: 0 });
      }
      const isHttps = u.protocol === 'https:';
      const authority = `${u.protocol}//${u.host}`;
      const useH2 = this.cfg.httpVersion === '2' && isHttps;
      const start = hrNow();
      const phases = { dns: 0, tcp: 0, tls: 0, ttfb: 0, download: 0 };
      let tcpStart = 0;
      let tlsStart = 0;
      let ttfbRecorded = false;
      let settled = false;

      // Build per-request headers with user isolation
      const requestHeaders = this._buildRequestHeaders(userState);

      // Get proxy for this user (rotation)
      const proxy = userState ? this._getProxyForUser(userState) : this.cfg.proxy;
      const useProxy = !!proxy;

      const finish = (r) => {
        if (settled) return;
        settled = true;
        const totalMs = hrNow() - start;
        if (r.latencyMs == null) r.latencyMs = totalMs;
        if (this.cfg.trackPhases) {
          const absEnd = totalMs + start;
          const nextDns = phases.tcp || phases.ttfb || absEnd;
          const nextTcp = phases.tls || phases.ttfb || absEnd;
          const nextTls = phases.ttfb || absEnd;
          const dnsMs = phases.dns > 0 ? nextDns - phases.dns : 0;
          const tcpMs = phases.tcp > 0 ? nextTcp - phases.tcp : 0;
          const tlsMs = phases.tls > 0 ? nextTls - phases.tls : 0;
          const ttfbMs = phases.ttfb > 0 ? absEnd - phases.ttfb : totalMs;
          const hopPhases = {
            dns: Math.max(0, dnsMs),
            tcp: Math.max(0, tcpMs),
            tls: Math.max(0, tlsMs),
            ttfb: Math.max(0, ttfbMs),
            download: Math.max(0, totalMs - (dnsMs + tcpMs + tlsMs + ttfbMs)),
          };
          // Merge with accumulated phases from previous redirect hops
          if (accumulatedPhases) {
            for (const p of CONNECTION_PHASES) {
              hopPhases[p] = (hopPhases[p] || 0) + (accumulatedPhases[p] || 0);
            }
          }
          r.phases = hopPhases;
        }
        // Handle cookie persistence for this user
        if (userState && r.headers && r.headers['set-cookie']) {
          this._storeCookies(userState, r.headers['set-cookie'], u.hostname, isHttps);
        }
        r.proxyUsed = proxy || null; // per-proxy health attribution in _worker
        resolve(r);
      };

      // HTTP/2 path
      if (useH2) {
        const session = this._h2Session(authority);
        const req = session.request({
          ':method': this.cfg.method,
          ':path': (u.pathname || '/') + (u.search || ''),
          ':authority': u.host,
          ...requestHeaders,
        });
        let status = 0;
        let bytes = 0;

        req.on('response', (headers) => {
          status = Number(headers[':status']) || 0;
          if (!ttfbRecorded) {
            phases.ttfb = hrNow();
            ttfbRecorded = true;
          }
          const loc = headers.location;
          if (this.cfg.followRedirects && loc && status >= 300 && status < 400 && redirectsLeft > 0) {
            req.close();
            const hopMs = hrNow() - start;
            let next;
            try {
              next = new URL(loc, u).toString();
            } catch (e) {
              return finish({ status, kind: 'error', errCode: 'BAD_REDIRECT' });
            }
            // Accumulate phases across redirect hops
            const absEnd = hopMs + start;
            const hopPhases = { dns: 0, tcp: 0, tls: 0, ttfb: 0, download: 0 };
            if (phases.ttfb > 0) hopPhases.download = absEnd - phases.ttfb;
            const prev = accumulatedPhases || {};
            const mergedPhases = {};
            for (const p of CONNECTION_PHASES) mergedPhases[p] = (hopPhases[p] || 0) + (prev[p] || 0);
            this._requestOnce(next, redirectsLeft - 1, userState, mergedPhases).then((inner) =>
              finish(Object.assign({}, inner, { latencyMs: hopMs + (inner.latencyMs || 0) }))
            );
            return;
          }
        });

        req.on('data', (chunk) => {
          if (!ttfbRecorded) {
            phases.ttfb = hrNow();
            ttfbRecorded = true;
          }
          bytes += chunk.length;
        });

        req.on('end', () => finish({ status, bytes, headers: { 'set-cookie': req.headers?.['set-cookie'] } }));

        req.on('error', (e) => {
          const code = (e && e.code) || 'H2_ERR';
          finish({ kind: 'error', errCode: code });
        });

        req.setTimeout(this.cfg.timeoutMs, () => {
          req.close();
          finish({ kind: 'timeout', errCode: 'TIMEOUT' });
        });

        if (this.cfg.body && this.cfg.method !== 'GET' && this.cfg.method !== 'HEAD') {
          req.write(this.cfg.body);
        }
        req.end();
        return;
      }

      // HTTP/1.1 path with phase tracking
      let req;
      try {
        const mod = isHttps ? https : http;
        const opts = {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || undefined,
          path: (u.pathname || '/') + (u.search || ''),
          method: this.cfg.method,
          headers: requestHeaders,
          agent: useProxy ? this._createProxyAgent(isHttps, proxy) : this._agent(isHttps),
          timeout: this.cfg.timeoutMs,
          rejectUnauthorized: this.cfg.tlsVerify,
        };
        if (this.cfg.trackPhases) {
          opts.lookup = (hostname, options, callback) => {
            phases.dns = hrNow();
            dns.lookup(hostname, options, callback);
          };
        }
        req = mod.request(opts, (res) => {
          if (!ttfbRecorded) {
            phases.ttfb = hrNow();
            ttfbRecorded = true;
          }
          const status = res.statusCode || 0;
          const loc = res.headers && res.headers.location;
          if (this.cfg.followRedirects && loc && status >= 300 && status < 400 && redirectsLeft > 0) {
            res.resume();
            const hopMs = hrNow() - start;
            let next;
            try {
              next = new URL(loc, u).toString();
            } catch (e) {
              return finish({ status, kind: 'error', errCode: 'BAD_REDIRECT' });
            }
            // Accumulate phases across redirect hops
            const absEnd = hopMs + start;
            const hopPhases = { dns: 0, tcp: 0, tls: 0, ttfb: 0, download: 0 };
            if (phases.ttfb > 0) hopPhases.download = absEnd - phases.ttfb;
            const prev = accumulatedPhases || {};
            const mergedPhases = {};
            for (const p of CONNECTION_PHASES) mergedPhases[p] = (hopPhases[p] || 0) + (prev[p] || 0);
            this._requestOnce(next, redirectsLeft - 1, userState, mergedPhases).then((inner) =>
              finish(Object.assign({}, inner, { latencyMs: hopMs + (inner.latencyMs || 0) }))
            );
            return;
          }
          let bytes = 0;
          res.on('data', (c) => {
            if (!ttfbRecorded) {
              phases.ttfb = hrNow();
              ttfbRecorded = true;
            }
            bytes += c.length;
          });
          res.on('end', () => finish({ status, bytes, headers: res.headers }));
          res.on('error', (e) => finish({ status, kind: 'error', errCode: (e && e.code) || 'RES_ERR' }));
        });

        if (this.cfg.trackPhases) {
          req.on('socket', (socket) => {
            if (!tcpStart) {
              tcpStart = hrNow();
              phases.tcp = tcpStart;
            }
            if (isHttps && socket.encrypted) {
              if (!tlsStart) {
                tlsStart = hrNow();
                phases.tls = tlsStart;
              }
            } else if (isHttps) {
              socket.once('secureConnect', () => {
                if (!tlsStart) {
                  tlsStart = hrNow();
                  phases.tls = tlsStart;
                }
              });
            }
          });
        }

      } catch (e) {
        return finish({ kind: 'error', errCode: (e && e.code) || 'REQ_THROW' });
      }

      req.on('timeout', () => {
        try { req.destroy(); } catch (e) { /* ignore */ }
        finish({ kind: 'timeout', errCode: 'TIMEOUT' });
      });
      req.on('error', (e) => {
        const code = (e && e.code) || 'ERR';
        finish({ kind: code === 'ETIMEDOUT' ? 'timeout' : 'error', errCode: code });
      });

      if (this.cfg.body && this.cfg.method !== 'GET' && this.cfg.method !== 'HEAD') {
        req.write(this.cfg.body);
      }
      req.end();
    });
  }

  _buildRequestHeaders(userState) {
    const headers = { ...this.cfg.headers };

    if (userState && this.cfg.isolateCookies && userState.cookies.size > 0) {
      const cookieHeader = this._formatCookieHeader(userState.cookies);
      if (cookieHeader) headers.cookie = cookieHeader;
    }

    if (userState && this.cfg.rotateHeaders && userState.userAgent) {
      const profile = getHeaderProfile(userState.userAgent);
      headers['user-agent'] = profile['user-agent'];
      if (profile['sec-ch-ua']) headers['sec-ch-ua'] = profile['sec-ch-ua'];
      if (profile['sec-ch-ua-mobile']) headers['sec-ch-ua-mobile'] = profile['sec-ch-ua-mobile'];
      if (profile['sec-ch-ua-platform']) headers['sec-ch-ua-platform'] = profile['sec-ch-ua-platform'];
    }

    if (this.cfg.requestOrderRandomization && Math.random() < 0.1) {
      const keys = Object.keys(headers);
      const shuffled = {};
      keys.sort(() => Math.random() - 0.5).forEach(k => shuffled[k] = headers[k]);
      return shuffled;
    }

    return headers;
  }

  _storeCookies(userState, setCookieHeaders, hostname, isHttps) {
    const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const cookie of cookies) {
      const parts = cookie.split(';').map(s => s.trim());
      const [nameValue] = parts;
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx === -1) continue;
      const name = nameValue.slice(0, eqIdx);
      const value = nameValue.slice(eqIdx + 1);
      let domain = hostname;
      for (const part of parts) {
        if (part.toLowerCase().startsWith('domain=')) {
          domain = part.slice(7);
          if (domain.startsWith('.')) domain = domain.slice(1);
        }
      }
      let expired = false;
      for (const part of parts) {
        if (part.toLowerCase().startsWith('max-age=')) {
          const maxAge = parseInt(part.slice(8), 10);
          if (maxAge <= 0) expired = true;
        }
        if (part.toLowerCase().startsWith('expires=')) {
          const expDate = new Date(part.slice(8));
          if (expDate < new Date()) expired = true;
        }
      }
      if (expired) {
        userState.cookies.delete(name);
      } else {
        userState.cookies.set(name, { value, domain, path: '/', secure: !!isHttps });
      }
    }
  }

  _formatCookieHeader(cookieMap) {
    const parts = [];
    for (const [name, data] of cookieMap.entries()) {
      parts.push(`${name}=${data.value}`);
    }
    return parts.join('; ');
  }

  _createProxyAgent(isHttps, proxy) {
    if (!proxy) return this._agent(isHttps);

    const cacheKey = isHttps ? `https-proxy:${proxy}` : `http-proxy:${proxy}`;
    const cached = this._agents.get(cacheKey);
    if (cached) {
      this._agents.delete(cacheKey);
      this._agents.set(cacheKey, cached);
      return cached;
    }

    const mod = isHttps ? https : http;
    let built;
    try {
      built = this._buildProxiedAgent(mod, proxy);
    } catch (e) {
      if (/Invalid proxy URL/.test(e.message)) {
        console.warn('Invalid proxy URL, using direct connection:', proxy);
        return this._agent(isHttps);
      }
      throw e;
    }
    return this._cacheAgent(cacheKey, () => built);
  }

  _makeGate(endAtMs) {
    if (!this.cfg.rps || this.cfg.rps <= 0) return null;
    const interval = 1000 / this.cfg.rps;
    let nextAt = hrNow();
    return async () => {
      const now = hrNow();
      if (now >= endAtMs) return false;
      const t = Math.max(now, nextAt);
      nextAt = t + interval;
      const wait = t - now;
      if (wait > 0) await sleep(wait);
      return !this.stopRequested && hrNow() < endAtMs;
    };
  }

  _makePreciseGate(endAtMs) {
    if (!this.cfg.rps || this.cfg.rps <= 0) return null;
    const intervalMs = 1000 / this.cfg.rps;
    const intervalNs = intervalMs * 1e6;
    let nextAtNs = process.hrtime.bigint();
    return async () => {
      const nowNs = process.hrtime.bigint();
      const endAtNs = BigInt(Math.floor(endAtMs * 1e6));
      if (nowNs >= endAtNs) return false;
      if (nextAtNs < nowNs) nextAtNs = nowNs;
      const waitNs = nextAtNs - nowNs;
      nextAtNs += BigInt(Math.floor(intervalNs));
      if (waitNs > 0) {
        const waitMs = Number(waitNs) / 1e6;
        if (waitMs > 0.5) await sleep(waitMs);
        else {
          // Busy-wait for sub-millisecond precision
          const spinEnd = process.hrtime.bigint() + waitNs;
          while (process.hrtime.bigint() < spinEnd) { /* spin */ }
        }
      }
      return !this.stopRequested && process.hrtime.bigint() < endAtNs;
    };
  }

  async _worker(startDelayMs, endAtMs, gate) {
    // Assign a persistent virtual user ID to this worker
    const userId = this._nextUserId++;
    const userState = this._getOrCreateUserState(userId);
    this.activeWorkers++;
    try {
      if (startDelayMs > 0) await sleep(startDelayMs);
      while (!this.stopRequested && hrNow() < endAtMs) {
        if (gate) {
          const allowed = await gate();
          if (!allowed) break;
        }
        if (this.stopRequested || hrNow() >= endAtMs) break;

        // Request jitter for anonymity (avoid pattern detection)
        if (this.cfg.requestJitterMs > 0) {
          const jitter = Math.random() * this.cfg.requestJitterMs;
          await sleep(jitter);
        }

        // Simulate realistic user session: think time between requests
        if (this.cfg.simulateUserSession && userState.lastRequestAt) {
          const thinkTime = 500 + Math.random() * 3000; // 500-3500ms think time
          await sleep(thinkTime);
        }

        const scheduledAt = hrNow();
        this.inflight++;
        let r;
        try {
          r = await this._requestOnce(this.cfg.url, this.cfg.maxRedirects, userState);
        } finally {
          this.inflight--;
        }
        userState.lastRequestAt = hrNow();
        userState.requestCount = (userState.requestCount || 0) + 1;

        const actualLatency = r.latencyMs;
        if (this.cfg.pacing === 'precise' && r.latencyMs != null) {
          const queueDelay = hrNow() - scheduledAt - actualLatency;
          if (queueDelay > 1) {
            r.queuedMs = queueDelay;
          }
        }
        this.global.record(r);
        this.phase.record(r);
        this._noteProxyResult(r.proxyUsed, r);

        // Check for blocking and auto-rotate BEFORE auto-abort
        // This gives rotation a chance to work before killing the test
        // Rotation works with a single proxy OR a proxy pool (either counts
        // as "something to rotate to"); without any proxy it stays off.
        if (this._autoRotate && (this.cfg.proxy || this.cfg.proxyList.length > 0) && (r.kind === 'timeout' || r.kind === 'error' || (r.status >= 400 && r.status < 600))) {
          if (this._isBlocked()) {
            // _rotateProxy() is single-flight: only the worker that wins the
            // claim emits block-detected, so one block == one log line, not N.
            if (this._rotateProxy()) {
              this.onEvent({
                type: 'block-detected',
                recentErrors: this.global.failed - (this._lastRotationFailed || 0),
                recentTimeouts: this.global.timeouts - (this._lastRotationTimeouts || 0),
                rotationCount: this._rotationCount,
                action: 'rotating-ip',
              });
            }
          }
        }

        // Auto-abort safety valve. With auto-rotate on, rotation gets the first
        // chance — but it must not be a license to fail forever: past an
        // extreme error rate over a longer window the run stops anyway, noting
        // that rotation did not recover it. (Previously the valve was skipped
        // entirely under autoRotate, so a dead proxy piled up 84k failures.)
        if (this.cfg.abortOnErrorRatePct > 0 && this.abortReason === null) {
          const liveErrPct = (this.global.failed / this.global.attempted) * 100;
          const minReq = this._autoRotate ? 500 : 50;
          const limit = this._autoRotate
            ? Math.max(this.cfg.abortOnErrorRatePct, 50)
            : this.cfg.abortOnErrorRatePct;
          if (this.global.attempted >= minReq && liveErrPct >= limit) {
            this.abortReason =
              `auto-aborted: error rate reached ${liveErrPct.toFixed(1)}% ` +
              `(abort threshold ${limit}%) after ${this.global.attempted} requests` +
              (this._autoRotate ? ` despite ${this._rotationCount} IP rotation(s)` : '');
            this.stopRequested = true;
          }
        }
      }
    } finally {
      this.activeWorkers--;
    }
  }

  _getOrCreateUserState(userId) {
    let state = this._userStates.get(userId);
    if (!state) {
      state = {
        cookies: new Map(),           // cookie jar per user
        session: {},                  // session data
        proxyIndex: 0,                // current proxy in rotation
        requestCount: 0,
        lastRequestAt: null,
        userAgent: null,              // sticky UA per user
      };
      // Assign sticky header profile per user for consistency
      if (this.cfg.rotateHeaders) {
        const profiles = Object.keys(HEADER_PROFILES);
        state.userAgent = profiles[userId % profiles.length];
      }
      // Assign proxy from list (round-robin)
      if (this.cfg.proxyList.length > 0) {
        state.proxyIndex = userId % this.cfg.proxyList.length;
      }
      this._userStates.set(userId, state);
    }
    return state;
  }

  _getProxyForUser(userState) {
    if (this.cfg.proxyList.length > 0) {
      // Skip blocked + health-quarantined pool members (compared redacted —
      // the set never holds creds). If every member is out, the loop falls
      // through and returns one anyway: degraded is better than stalled.
      let attempts = 0;
      while (attempts < this.cfg.proxyList.length) {
        const cand = this.cfg.proxyList[userState.proxyIndex];
        if (!this._blockedProxies.has(redactProxyUrl(cand)) && !this._proxyQuarantined(cand)) break;
        userState.proxyIndex = (userState.proxyIndex + 1) % this.cfg.proxyList.length;
        attempts++;
      }
      const proxy = this.cfg.proxyList[userState.proxyIndex];
      userState.proxyIndex = (userState.proxyIndex + 1) % this.cfg.proxyList.length;
      return proxy;
    }
    return this.cfg.proxy;
  }

  // Per-proxy health for pools: consecutive TRANSPORT failures (timeouts /
  // conn errors — never HTTP statuses, which blame the target, not the
  // proxy) quarantine a member for proxyHealthCooldownMs; any completed HTTP
  // response (even a 500) proves the member works and clears it.
  _noteProxyResult(proxy, r) {
    if (!proxy) return;
    if (this._proxyHealth.size > 200) this._proxyHealth.clear();
    let h = this._proxyHealth.get(proxy);
    if (!h) { h = { fails: 0, skipUntil: 0 }; this._proxyHealth.set(proxy, h); }
    if (r.kind !== 'timeout' && r.kind !== 'error') {
      h.fails = 0;
      h.skipUntil = 0;
      return;
    }
    h.fails++;
    if (h.fails === this.cfg.proxyHealthFails) {
      h.skipUntil = Date.now() + this.cfg.proxyHealthCooldownMs;
      this.onEvent({
        type: 'proxy-quarantined',
        proxy: redactProxyUrl(proxy),
        fails: h.fails,
        rotationCount: this._rotationCount,
      });
    }
  }

  _proxyQuarantined(proxy) {
    const h = this._proxyHealth.get(proxy);
    return !!h && h.fails >= this.cfg.proxyHealthFails && Date.now() < h.skipUntil;
  }

  // Single-flight claim so N workers don't fire N rotations at once
  // (that herd is what overwhelmed the Tor control port -> "Tor control timeout").
  _claimRotation() {
    if (this._rotationInFlight) return false;
    if (Date.now() - this._lastRotationAt < this._rotationCooldownMs) return false;
    this._rotationInFlight = true;
    this._lastRotationAt = Date.now();
    this._lastRotationAttempted = this.global.attempted;
    return true;
  }

  _releaseRotation() {
    this._rotationInFlight = false;
  }

  // Guess the Tor control port from the SOCKS port when the user left the
  // default untouched: Tor Browser is 9150/9151, system tor is 9050/9051.
  // Hitting 9151 while tor listens on 9051 was one source of ECONNREFUSED/
  // timeout loops in the field.
  _effectiveTorControlPort() {
    if (this.cfg.torControlPort && this.cfg.torControlPort !== 9151) return this.cfg.torControlPort;
    const m = /:(9150|9050)/.exec(this.cfg.proxy || '');
    if (m && m[1] === '9050') return 9051;
    return this.cfg.torControlPort || 9151;
  }

  // Check if requests SINCE THE LAST ROTATION indicate we're still blocked.
  // Uses a delta window (not lifetime totals) so one bad stretch can't
  // re-trigger rotations forever, and honors blockThresholdPct for every
  // signal instead of a hardcoded 80%.
  _isBlocked() {
    if (!this._autoRotate) return false;
    if (this._rotationInFlight) return false;
    if (Date.now() - this._lastRotationAt < this._rotationCooldownMs) return false;

    const newReq = this.global.attempted - this._lastRotationAttempted;
    if (newReq < this._blockDetectionWindow) return false;

    const threshold = (this._blockThresholdPct || 70) / 100;
    const timeouts = this.global.timeouts - (this._lastRotationTimeouts || 0);
    const failed = this.global.failed - (this._lastRotationFailed || 0);
    if (newReq > 0) {
      if (timeouts / newReq > threshold) return true;
      if (failed / newReq > threshold) return true;
    }
    return false;
  }

  // Force Tor to get a new circuit (new exit IP). Serialized: concurrent
  // NEWNYM calls are what produced the "Tor control timeout" floods.
  async _rotateTorCircuit() {
    const port = this._effectiveTorControlPort();
    return new Promise((resolve, reject) => {
      const net = require('net');
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        const pw = process.env.TOR_CONTROL_PASSWORD;
        // Empty AUTHENTICATE works for default Tor Browser; system tor often
        // needs cookie auth or a password (HashedControlPassword).
        socket.write(pw ? `AUTHENTICATE "${pw}"\r\n` : 'AUTHENTICATE\r\n');
      });

      let authenticated = false;
      let data = '';
      let settled = false;
      const done = (fn) => (v) => { if (settled) return; settled = true; try { socket.destroy(); } catch (_) {} fn(v); };

      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (!authenticated) {
          if (/250\s+OK/.test(data)) {
            authenticated = true;
            data = '';
            socket.write('SIGNAL NEWNYM\r\n');
          } else if (/515/.test(data)) {
            done(reject)(new Error(
              'Tor control auth failed (515). Tor Browser: leave control auth default; system tor: set TOR_CONTROL_PASSWORD to its HashedControlPassword value.'
            ));
          } else if (/5\d\d/.test(data)) {
            done(reject)(new Error(`Tor control auth rejected: ${data.trim().slice(0, 120)}`));
          }
        } else {
          if (/250\s+OK/.test(data)) {
            done(resolve)(true);
          } else if (/554/.test(data)) {
            done(reject)(new Error('Tor rate-limited NEWNYM (554): circuits rotate at most every ~10s — wait before retrying.'));
          } else if (/5\d\d/.test(data)) {
            done(reject)(new Error(`Tor rejected NEWNYM: ${data.trim().slice(0, 120)}`));
          }
        }
      });

      socket.on('error', (err) => {
        const hint = err && err.code === 'ECONNREFUSED'
          ? ` (nothing on 127.0.0.1:${port}; Tor Browser control is 9151, system tor is 9051 — set torControlPort accordingly)`
          : '';
        done(reject)(new Error((err && (err.code || err.message)) + hint));
      });

      socket.setTimeout(10000, () => {
        done(reject)(new Error(`Tor control timeout on 127.0.0.1:${port} (10s). The control port may be busy, firewalled, or rate-limiting NEWNYM.`));
      });
    });
  }

  // Rotate to next available proxy. Single-flight: the first worker to notice
  // a block claims the rotation; the rest keep testing through the cooldown
  // instead of stampeding the control port.
  _rotateProxy() {
    if (!this._claimRotation()) return false;

    this._rotationCount++;
    this._lastRotationTimeouts = this.global.timeouts;
    this._lastRotationFailed = this.global.failed;

    // Mark current proxy as blocked (event only the first time per proxy so
    // the log shows one "blocked" line, not one per rotation). Stored and
    // emitted REDACTED — raw URLs may embed user:pass credentials that must
    // never reach reports, SSE, or logs.
    if (this.cfg.proxy && !this._blockedProxies.has(redactProxyUrl(this.cfg.proxy))) {
      this._blockedProxies.add(redactProxyUrl(this.cfg.proxy));
      this.onEvent({
        type: 'proxy-blocked',
        proxy: redactProxyUrl(this.cfg.proxy),
        rotationCount: this._rotationCount,
      });
    }

    // For proxy list, the next user will skip blocked ones automatically
    // For single proxy (Tor), we need to force new circuit.
    // Tor control-port automation is gated behind ENABLE_EVASION=1 to avoid
    // accidental abuse of anonymity networks during ordinary load tests.
    if (this.cfg.proxy && (this.cfg.proxy.includes('socks5://127.0.0.1:9150') || this.cfg.proxy.includes('socks5://127.0.0.1:9050'))) {
      if (process.env.ENABLE_EVASION !== '1') {
        this.onEvent({ type: 'tor-rotation-failed', error: 'Tor rotation disabled (set ENABLE_EVASION=1 to allow)', rotationCount: this._rotationCount });
        this._closeAgents();
        this._releaseRotation();
        return true;
      }
      // Tor - try to get new circuit
      this._rotateTorCircuit().then(() => {
        // Close old agents to force new connections with new circuit
        this._closeAgents();
        this.onEvent({
          type: 'tor-circuit-rotated',
          rotationCount: this._rotationCount,
        });
        this._releaseRotation();
      }).catch((err) => {
        // If Tor control fails, at least close agents to reset connections
        this._closeAgents();
        this.onEvent({
          type: 'tor-rotation-failed',
          error: err.message,
          rotationCount: this._rotationCount,
        });
        this._releaseRotation();
      });
    } else {
      // Non-Tor proxy - close agents to force new connections
      this._closeAgents();
      this._releaseRotation();
    }
    return true;
  }

  async _runPhase(concurrency, durationMs, rampUpMs) {
    // durationMs=0 means unlimited (run until stopped)
    const endAtMs = durationMs > 0 ? hrNow() + durationMs : Infinity;
    const gate = this.cfg.pacing === 'precise' ? this._makePreciseGate(endAtMs) : this._makeGate(endAtMs);
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      const startDelay = rampUpMs > 0 ? Math.floor((rampUpMs * i) / concurrency) : 0;
      workers.push(this._worker(startDelay, endAtMs, gate));
    }
    await Promise.all(workers);
  }

  async _runStress() {
    const { start, step, max, stepDurationSec } = this.cfg.stress;
    for (let c = start; c <= max; c += step) {
      if (this.stopRequested) break;
      this.phaseLabel = `ramp step: ${c} concurrent users`;
      this.phase.reset();
      const t0 = Date.now();
      await this._runPhase(c, stepDurationSec * 1000, 0);
      const ps = this.phase.snapshot();
      const v = evaluate(ps, this.cfg.thresholds, this._verdictCtx());
      const entry = {
        concurrency: c,
        rps: ps.rps,
        p95: ps.latency.p95,
        avg: ps.latency.avg,
        errRate: ps.errRate,
        errPct: ps.errRate * 100,
        requests: ps.attempted,
        durationSec: +((Date.now() - t0) / 1000).toFixed(1),
        verdict: v.status,
      };
      this.steps.push(entry);
      this.onEvent({ type: 'step', step: entry });
      if (v.status === 'fail') {
        this.breakingPoint = c;
        break;
      }
    }
  }

  async run() {
    this._generation++;
    const gen = this._generation;
    this.state = 'running';
    this.stopRequested = false;
    this.startedAtMs = Date.now();
    this._lastSnapshotAt = 0;
    this._lastSnapshot = null;
    this.onEvent({ type: 'start', config: this.publicConfig() });
    try {
      if (this.cfg.mode === 'stress') {
        await this._runStress();
      } else {
        this.phaseLabel = `steady ${this.cfg.concurrency} concurrent users`;
        this.phase.reset();
        await this._runPhase(this.cfg.concurrency, this.cfg.durationSec * 1000, this.cfg.rampUpSec * 1000);
      }
      if (gen !== this._generation) return this.finalSummary; // superseded by stop()/reset
      if (!this.error) this.state = 'finished';
    } catch (e) {
      if (gen !== this._generation) return this.finalSummary;
      this.state = 'error';
      this.error = (e && e.message) || String(e);
    } finally {
      if (gen !== this._generation) return this.finalSummary;
      this.finishedAtMs = Date.now();
      this._saveCookies();
      this._closeAgents();
      this.finalSummary = this.summary();
      this.onEvent({ type: 'finished', summary: this.finalSummary });
    }
    return this.finalSummary;
  }

  stop() {
    if (this.state !== 'running' && this.state !== 'stopping') return false;
    const gen = this._generation;
    this.stopRequested = true;
    this.state = 'stopping';
    // Graceful shutdown: wait for in-flight requests to complete
    if (this.cfg.gracefulShutdownMs > 0 && this.inflight > 0) {
      const deadline = Date.now() + this.cfg.gracefulShutdownMs;
      const waitInterval = setInterval(() => {
        if (gen !== this._generation) { clearInterval(waitInterval); return; }
        if (this.inflight <= 0 || Date.now() >= deadline) {
          clearInterval(waitInterval);
          this._finishEngine(gen);
        }
      }, 100);
    } else {
      this._finishEngine(gen);
    }
    return true;
  }

  _finishEngine(gen) {
    if (gen != null && gen !== this._generation) return;
    if (this.state === 'finished' || this.state === 'error') return;
    this.state = 'finished';
    this.finishedAtMs = Date.now();
    this._saveCookies();
    this._closeAgents();
    this.finalSummary = this.summary();
    this.onEvent({ type: 'finished', summary: this.finalSummary });
  }

  // Context for verdict guidance: proxy-collapse advice only makes sense
  // when traffic actually went through a proxy.
  _verdictCtx() {
    return { proxied: !!(this.cfg.proxy || (this.cfg.proxyList && this.cfg.proxyList.length)) };
  }

  summary() {
    const g = this.global.snapshot();
    const v = evaluate(g, this.cfg.thresholds, this._verdictCtx());
    const wallMs = this.startedAtMs ? (this.finishedAtMs || Date.now()) - this.startedAtMs : 0;
    return {
      generatedAt: new Date().toISOString(),
      state: this.state,
      error: this.error,
      config: this.publicConfig(),
      result: v,
      metrics: g,
      steps: this.steps,
      breakingPoint: this.breakingPoint,
      abortReason: this.abortReason,
      wallClockSec: +(wallMs / 1000).toFixed(2),
      rotationCount: this._rotationCount,
      blockedProxies: Array.from(this._blockedProxies),
    };
  }

  _getPoolStats() {
    let active = 0, free = 0;
    for (const agent of this._agents.values()) {
      if (agent && agent.sockets) {
        for (const arr of Object.values(agent.sockets)) active += arr.length;
      }
      if (agent && agent.freeSockets) {
        for (const arr of Object.values(agent.freeSockets)) free += arr.length;
      }
    }
    return { active, free, total: active + free };
  }

  /** Compact snapshot for the live SSE stream (throttled: sort is O(n log n)). */
  snapshot(force = false) {
    const now = Date.now();
    if (!force && this._lastSnapshot && now - this._lastSnapshotAt < 250) {
      return this._lastSnapshot;
    }
    const base = this.global.snapshot({
      engineState: this.state,
      error: this.error,
      inflight: this.inflight,
      activeWorkers: this.activeWorkers,
      phase: this.phaseLabel,
      target: this.cfg.url,
      mode: this.cfg.mode,
      concurrency: this.cfg.concurrency,
      targetRps: this.cfg.rps,
      plannedDurationSec: this.cfg.durationSec,
      abortOnErrorRatePct: this.cfg.abortOnErrorRatePct,
      steps: this.steps,
      breakingPoint: this.breakingPoint,
      abortReason: this.abortReason,
      // Auto-rotation status
      autoRotate: this.cfg.autoRotate,
      rotationCount: this._rotationCount,
      blockedProxies: Array.from(this._blockedProxies),
      lastRotationAt: this._lastRotationAt,
      // Connection pool stats
      connectionPool: this._getPoolStats(),
    });
    if (this.cfg.mode === 'stress' && (this.state === 'running' || this.state === 'stopping')) {
      const p = this.phase.snapshot();
      base.currentStep = {
        concurrency: this.activeWorkers,
        rps: p.rps,
        p95: p.latency.p95,
        errPct: p.errRate * 100,
      };
    }
    // Add structured phases object for UI consumption
    if (this.cfg.trackPhases) {
      const phases = {};
      for (const p of ['dns', 'tcp', 'tls', 'ttfb', 'download']) {
        const mean = base.latency[`${p}_p50`];
        const p95 = base.latency[`${p}_p95`];
        if (mean !== undefined || p95 !== undefined) {
          phases[p] = {
            mean: mean || 0,
            p95: p95 || 0,
          };
        }
      }
      if (Object.keys(phases).length > 0) base.phases = phases;
    }

    base.result = evaluate(base, this.cfg.thresholds, this._verdictCtx());
    this._lastSnapshotAt = now;
    this._lastSnapshot = base;
    return base;
  }
}

module.exports = { LoadEngine, normalizeConfig, tlsOptionsForFingerprint };
