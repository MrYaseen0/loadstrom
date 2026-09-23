'use strict';

/* Strom Fire dashboard client. No dependencies. */

const $ = (id) => document.getElementById(id);

// All dashboard data lives behind sign-in: any API 401 means the session is
// gone (or was never established) → back to the login page. The login page
// itself never loads this script, so no redirect loop is possible.
(function () {
  if (typeof window === 'undefined' || !window.fetch) return;
  const rawFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    return rawFetch(url, opts).then((r) => {
      try {
        const u = typeof url === 'string' ? url : (url && url.url) || '';
        if (r && r.status === 401 && u.indexOf('/api/') === 0 &&
            u.indexOf('/api/login') !== 0 && u.indexOf('/api/auth-status') !== 0) {
          window.location.replace('/login.html');
        }
      } catch (_) { /* ignore */ }
      return r;
    });
  };
})();

const state = {
  mode: 'load',
  running: false,
  lastT: -1,
  series: { rps: [], err: [], avg: [], p95: [] },
  lastReport: null,
  finishHandled: false,
  es: null,
  rotationCount: 0,
};

/* ------------------------------ helpers (fmt/* in format.js, charts in charts.js) ------------------------------ */
function logLine(msg) {
  const el = $('log');
  const div = document.createElement('div');
  div.innerHTML = `<span class="t">${ts()}</span>  ${msg}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  while (el.childNodes.length > 300) el.removeChild(el.firstChild);
}

/* ------------------------------ rotation log ------------------------------ */
function logRotation(msg, cls) {
  const el = $('rotationLog');
  const empty = el.querySelector('.log-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'rot-entry ' + (cls || '');
  div.innerHTML = `<span class="rot-time">${ts()}</span> ${escapeHtml(msg)}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  while (el.childNodes.length > 100) el.removeChild(el.firstChild);
  updateRotationKpi();
}

function updateRotationKpi() {
  const kRot = $('kRotations');
  if (kRot) kRot.textContent = state.rotationCount + ' rotation' + (state.rotationCount !== 1 ? 's' : '');
}

/* ------------------------------ test history ------------------------------ */
function getHistory() {
  try { return JSON.parse(localStorage.getItem('loadstorm_history') || '[]'); } catch { return []; }
}
function saveHistory(entry) {
  const hist = getHistory();
  hist.unshift(entry);
  if (hist.length > 20) hist.length = 20;
  localStorage.setItem('loadstorm_history', JSON.stringify(hist));
  renderHistory();
}
function renderHistory() {
  const hist = getHistory();
  const el = $('historyList');
  if (!el) return;
  if (!hist.length) {
    el.innerHTML = '<div class="hist-empty">No tests run yet.</div>';
    return;
  }
  el.innerHTML = hist.map((h, i) =>
    `<div class="hist-item" data-idx="${i}">
      <span class="hist-badge ${h.status}">${h.status}</span>
      <span class="hist-url">${escapeHtml(h.url)}</span>
      <span class="hist-meta">${h.rps} rps · p95 ${h.p95}ms · ${h.time}</span>
    </div>`
  ).join('');
  el.querySelectorAll('.hist-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = Number(item.dataset.idx);
      if (hist[idx] && hist[idx].config) {
        loadConfig(hist[idx].config);
      }
    });
  });
}
function loadConfig(cfg) {
  if (!cfg) return;
  if (cfg.url) $('url').value = cfg.url;
  if (cfg.proxy) $('proxy').value = cfg.proxy;
  if (cfg.concurrency) $('concurrency').value = cfg.concurrency;
  if (cfg.rps != null) $('rps').value = cfg.rps;
  if (cfg.durationSec != null) $('durationSec').value = cfg.durationSec;
  if (cfg.headerProfile) $('headerProfile').value = cfg.headerProfile;
  if (cfg.tlsFingerprint) $('tlsFingerprint').value = cfg.tlsFingerprint;
  if (cfg.mode) setMode(cfg.mode);
  if (cfg.stress) {
    if (cfg.stress.start) $('stStart').value = cfg.stress.start;
    if (cfg.stress.step) $('stStep').value = cfg.stress.step;
    if (cfg.stress.max) $('stMax').value = cfg.stress.max;
    if (cfg.stress.stepDurationSec) $('stDur').value = cfg.stress.stepDurationSec;
  }
  if (cfg.thresholds) {
    if (cfg.thresholds.maxErrorRatePct != null) $('maxErr').value = cfg.thresholds.maxErrorRatePct;
    if (cfg.thresholds.maxP95Ms != null) $('maxP95').value = cfg.thresholds.maxP95Ms;
    if (cfg.thresholds.minRps != null) $('minRps').value = cfg.thresholds.minRps;
  }
  logLine('Loaded config from history.');
}

/* ------------------------------ charts (see charts.js) ------------------------------ */
function redraw() {
  drawChart($('chartRps'), [
    { data: state.series.rps, color: '#4c8dff', fill: true, axis: 1 },
    { data: state.series.err, color: '#ff5d6c', axis: 2 },
  ]);
  drawChart($('chartLat'), [
    { data: state.series.avg, color: '#22d3a6', fill: true, axis: 1 },
    { data: state.series.p95, color: '#f5b544', axis: 1 },
  ]);
}

/* ------------------------------ verdict ------------------------------ */
function renderVerdict(payload) {
  const el = $('verdict');
  const r = payload.result;
  let cls, badge, headline, sub;

  if (payload.engineState === 'idle' || payload.idle) {
    cls = 'idle'; badge = 'Ready'; headline = 'Ready when you are';
    sub = 'Paste a URL, pick a load profile, tick the authorisation box, and press Start.';
    el.innerHTML = `<div class="v-headline"><span class="v-badge">${badge}</span>${headline}</div><div class="v-sub">${sub}</div>`;
    return;
  }
  if (payload.engineState === 'running' || payload.engineState === 'stopping') {
    cls = 'running'; badge = 'Running'; headline = `Testing ${escapeHtml(payload.target || '')}`;
    sub = `${fmtNum(displayRps(payload))} rps · ${fmtNum(payload.activeWorkers)} users active · ${fmtNum(payload.completed)} done`;
    el.innerHTML = `<div class="v-headline"><span class="v-badge">${badge}</span>${headline}</div><div class="v-sub">${sub}</div>`;
    return;
  }
  if (!r) return;

  cls = r.status;
  badge = r.status === 'pass' ? 'Pass' : r.status === 'warn' ? 'Warnings' : r.status === 'defended' ? 'Defended' : 'Fail';
  headline = r.headline;
  const reasons = (r.reasons || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  const recos = (r.recommendations || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  el.innerHTML =
    `<div class="v-headline"><span class="v-badge">${badge}</span>${escapeHtml(headline)}</div>` +
    `<div class="v-sub">${escapeHtml(formatSummaryLine(payload))}</div>` +
    (reasons ? `<ul class="v-reasons">${reasons}</ul>` : '') +
    (recos ? `<ul class="v-reasons">${recos}</ul>` : '');
}

/* ------------------------------ KPIs / tables (fmt helpers in format.js) ------------------------------ */
function renderKpis(p) {
  $('kRps').innerHTML = `${fmtNum(displayRps(p))} <small>rps</small>`;
  $('kUsers').textContent = fmtNum(p.activeWorkers || p.inflight || 0);
  $('kAvg').innerHTML = `${fmtMs(p.latency.avg)} <small>ms</small>`;
  $('kP95').innerHTML = `${fmtMs(p.latency.p95)} <small>ms</small>`;
  $('kP99').innerHTML = `${fmtMs(p.latency.p99)} <small>ms</small>`;
  const errPct = (p.errRate || 0) * 100;
  $('kErr').innerHTML = `${fmtNum(errPct, 2)} <small>%</small>`;
  $('kReq').textContent = fmtNum(p.attempted);
  $('kBytes').innerHTML = fmtBytes(p.bytes);

  const maxErr = Number($('maxErr').value) || 1;
  const maxP95 = Number($('maxP95').value) || 1000;
  setKpiState('kpiErrCard', errPct, maxErr);
  setKpiState($('kP95').parentElement, p.latency.p95, maxP95);
}
function setKpiState(elOrId, value, limit) {
  const el = typeof elOrId === 'string' ? $(elOrId) : elOrId;
  el.classList.remove('good', 'warnc', 'bad');
  if (value <= limit * 0.5) el.classList.add('good');
  else if (value <= limit) el.classList.add('warnc');
  else el.classList.add('bad');
}

function renderStatusTable(p) {
  const tbody = $('statusTable').querySelector('tbody');
  const counts = p.statusCounts || {};
  const keys = Object.keys(counts);
  const total = p.attempted || 0;
  const rows = [];
  for (const k of keys) {
    const code = Number(k);
    const cls = code >= 500 ? 's5' : code >= 400 ? 's4' : code >= 300 ? 's3' : code >= 200 ? 's2' : 'se';
    rows.push({ code, count: counts[k], cls });
  }
  if (p.timeouts) rows.push({ code: 'timeout', count: p.timeouts, cls: 'se' });
  if (p.connErrors) rows.push({ code: 'conn error', count: p.connErrors, cls: 'se' });
  rows.sort((a, b) => b.count - a.count);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">No traffic yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const share = total ? ((r.count / total) * 100).toFixed(1) : '0.0';
      return `<tr><td><span class="badge ${r.cls}">${escapeHtml(String(r.code))}</span></td><td class="num">${fmtNum(r.count)}</td><td class="num">${share}%</td></tr>`;
    })
    .join('');
}

function renderSteps(steps) {
  const wrap = $('stepsWrap');
  if (!steps || !steps.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const tb = $('stepsTable').querySelector('tbody');
  tb.innerHTML = steps
    .map((s) => {
      const cls = s.verdict === 'fail' ? 's5' : (s.verdict === 'warn' || s.verdict === 'defended') ? 's4' : 's2';
      return `<tr><td>${fmtNum(s.concurrency)}</td><td class="num">${fmtNum(s.rps)}</td><td class="num">${fmtMs(s.p95)}</td><td class="num">${fmtNum(s.errPct, 2)}</td><td><span class="badge ${cls}">${escapeHtml(s.verdict)}</span></td></tr>`;
    })
    .join('');
}

/* ------------------------------ live stream ------------------------------ */
function connect() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/stream');
  state.es = es;

  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
  es.onmessage = (ev) => {
    let p;
    try {
      p = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (p.event) {
      if (p.event === 'start') logLine('Test started.');
      else if (p.event === 'step') logLine('Ramp step finished.');
      else if (p.event === 'finished') logLine('Test finished.');
      else if (p.event === 'proxy-blocked') {
        state.rotationCount = p.rotationCount ?? (state.rotationCount + 1);
        logRotation(`Blocked proxy: ${p.proxy || 'unknown'} — rotating (#${state.rotationCount})`, 'rot-warn');
        logLine(`Rotating IP... (#${state.rotationCount})`);
      }
      else if (p.event === 'tor-circuit-rotated') {
        state.rotationCount = p.rotationCount ?? (state.rotationCount + 1);
        logRotation(`Tor circuit rotated — new exit IP (#${state.rotationCount})`, 'rot-ok');
        logLine(`New Tor circuit obtained (#${state.rotationCount})`);
      }
      else if (p.event === 'tor-rotation-failed') {
        logRotation(`Tor rotation failed: ${escapeHtml(p.error || 'unknown')}`, 'rot-fail');
        logLine(`Tor rotation failed: ${escapeHtml(p.error || '')}`);
      }
      else if (p.event === 'block-detected') {
        state.rotationCount = p.rotationCount ?? state.rotationCount;
        const timeouts = p.recentTimeouts || 0;
        const errors = p.recentErrors || 0;
        logRotation(`Block detected — ${timeouts} timeouts, ${errors} errors, rotating...`, 'rot-warn');
        logLine(`Block detected (#${state.rotationCount})`);
      }
      else if (p.event === 'defense-detected') {
        const d = p.defense || {};
        logLine(`🛡 Target defense triggered: ${escapeHtml(d.type || 'protection')} (HTTP ${d.dominantCode || '?'}) at request #${d.firstSeenRequest || '?'} — test stopped, verdict: defended.`);
      }
      return;
    }
    handlePayload(p);
  };
}
function setConn(ok) {
  const el = $('connPill');
  el.className = `pill ${ok ? 'online' : 'offline'}`;
  el.innerHTML = `<span class="dot"></span>${ok ? 'live' : 'disconnected'}`;
}

function handlePayload(p) {
  if (p.idle) {
    renderVerdict({ idle: true });
    return;
  }
  renderVerdict(p);
  renderKpis(p);
  renderStatusTable(p);
  renderSteps(p.steps);

  if (p.timelineTail && p.timelineTail.length) {
    for (const b of p.timelineTail) {
      if (b.t <= state.lastT) continue;
      state.lastT = b.t;
      state.series.rps.push(b.rps || 0);
      state.series.err.push((b.errRate || 0) * 100);
      state.series.avg.push(b.avg || 0);
      state.series.p95.push(b.p95 || 0);
    }
    if (state.series.rps.length > 1500) {
      for (const k of Object.keys(state.series)) state.series[k] = state.series[k].slice(-1200);
    }
    redraw();
  }

  if (p.engineState === 'finished' || p.engineState === 'error') {
    finishRun(p);
  } else {
    setRunningUI(true);
  }
}

function finishRun(p) {
  if (state.finishHandled) return;
  state.finishHandled = true;
  setRunningUI(false);
  state.running = false;
  if (p.abortReason) {
    logLine(`⚠ ${escapeHtml(p.abortReason)}`);
    logLine('Test ended early to avoid hammering a failing target.');
  } else {
    logLine(p.engineState === 'error' ? `Test ended with error: ${escapeHtml(p.error || 'unknown')}` : 'Verdict ready.');
  }
  fetch('/api/report')
    .then((r) => r.json())
    .then((d) => {
      if (d && d.report) {
        state.lastReport = d.report;
        showReport(d.report);
        const m = d.report.metrics || {};
        saveHistory({
          url: d.report.config ? d.report.config.url : '',
          config: d.report.config || {},
          status: d.report.result ? d.report.result.status : 'unknown',
          rps: (m.rps || 0).toFixed(1),
          p95: (m.latency && m.latency.p95 ? m.latency.p95 : 0).toFixed(0),
          time: ts(),
        });
      }
    })
    .catch(() => {});
}

/* ------------------------------ report ------------------------------ */
function showReport(report) {
  $('reportCard').hidden = false;
  $('reportJson').textContent = JSON.stringify(report, null, 2);
  $('reportSummary').textContent = formatSummaryLine(Object.assign({ statusCounts: {} }, report.metrics));
}

function download(name, text, type) {
  const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 100);
}

/* ------------------------------ form ------------------------------ */
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.seg-btn').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $('loadFields').hidden = mode !== 'load';
  $('stressFields').hidden = mode !== 'stress';
  $('spikeFields').hidden = mode !== 'spike';
  $('soakFields').hidden = mode !== 'soak';
}

function readConfig() {
  const headersRaw = $('headers').value.trim();
  const bodyRaw = $('body').value.trim();
  const cfg = {
    url: $('url').value.trim(),
    method: $('method').value,
    mode: state.mode,
    concurrency: Math.min(10000, Number($('concurrency').value) || 100),
    rps: Number($('rps').value) || 0,
    durationSec: $('durationSec').value === '' ? 30 : Number($('durationSec').value),
    rampUpSec: Number($('rampUpSec').value) || 0,
    timeoutMs: Number($('timeoutMs').value) || 15000,
    tlsVerify: $('tlsVerify').checked,
    followRedirects: $('followRedirects').checked,
    maxRedirects: Number($('maxRedirects').value) || 5,
    httpVersion: $('httpVersion').value,
    pacing: $('pacing').value,
    trackPhases: $('trackPhases').checked,
    abortOnErrorRatePct: Number($('abortErr').value) || 0,
    // Anonymity / proxy
    proxy: $('proxy').value.trim(),
    proxyList: $('proxyList').value.trim().split('\n').map(s => s.trim()).filter(Boolean),
    headerProfile: $('headerProfile').value,
    rotateHeaders: $('rotateHeaders').checked,
    requestJitterMs: Number($('requestJitterMs').value) || 0,
    tlsFingerprint: $('tlsFingerprint').value,
    isolateCookies: $('isolateCookies').checked,
    simulateUserSession: $('simulateUserSession').checked,
    requestOrderRandomization: $('requestOrderRandomization').checked,
    reuseConnections: $('reuseConnections').checked,
    // Auto-rotation
    autoRotate: $('autoRotate').checked,
    torControlPort: Number($('torControlPort').value) || 9151,
    blockThresholdPct: Number($('blockThresholdPct').value) || 70,
    thresholds: {
      maxErrorRatePct: Number($('maxErr').value),
      maxP95Ms: Number($('maxP95').value),
      minRps: Number($('minRps').value) || 0,
    },
    stress: {
      start: Number($('stStart').value),
      step: Number($('stStep').value),
      max: Number($('stMax').value),
      stepDurationSec: Number($('stDur').value),
    },
    spikeUsers: Number($('spikeUsers').value) || 500,
    spikeHoldSec: Number($('spikeHoldSec').value) || 30,
    confirm: $('confirm').checked,
  };
  if (state.mode === 'soak') {
    // Soak uses its own low-and-long inputs instead of the load profile fields.
    cfg.concurrency = Math.min(10000, Number($('soakUsers').value) || 25);
    cfg.durationSec = Math.min(7200, Number($('soakDurationSec').value) || 1800);
  }
  if (headersRaw) cfg.headers = headersRaw;
  if (bodyRaw) cfg.body = bodyRaw;
  return cfg;
}

function setRunningUI(running) {
  state.running = running;
  $('startBtn').disabled = running;
  $('stopBtn').disabled = !running;
  const top = $('stopBtnTop');
  if (top) top.classList.toggle('show', running);
}

function showError(msg) {
  const el = $('configError');
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

async function start() {
  showError('');
  const cfg = readConfig();
  if (!/^https?:\/\//i.test(cfg.url)) {
    showError('Enter a full URL starting with http:// or https://');
    return;
  }
  if (!cfg.confirm) {
    showError('Please tick the authorisation checkbox — you must own the target or have written permission.');
    return;
  }
  // client-side safety pre-check (server enforces too)
  try {
    const v = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: cfg.url }),
    }).then((r) => r.json());
    if (v && v.ok === false) {
      showError(v.reason || 'Target rejected.');
      return;
    }
  } catch (e) {
    /* ignore network hiccup; server will still validate */
  }

  // reset view
  state.lastT = -1;
  state.series = { rps: [], err: [], avg: [], p95: [] };
  state.lastReport = null;
  state.finishHandled = false;
  state.rotationCount = 0;
  $('reportCard').hidden = true;
  $('stepsWrap').hidden = state.mode !== 'stress';
  const rotLog = $('rotationLog');
  if (rotLog) rotLog.innerHTML = '<div class="log-empty">No rotations yet.</div>';
  updateRotationKpi();
  redraw();
  logLine(`Starting ${cfg.mode === 'stress' ? 'stress' : 'steady'} test on ${escapeHtml(cfg.url)}`);

  setRunningUI(true);
  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      setRunningUI(false);
      showError(data.error || 'Failed to start.');
      logLine(`Start failed: ${escapeHtml(data.error || res.status)}`);
      return;
    }
    logLine('Test accepted by server.');
  } catch (e) {
    setRunningUI(false);
    showError('Cannot reach the Strom Fire server.');
  }
}

async function stop() {
  try {
    await fetch('/api/stop', { method: 'POST' });
    logLine('Stop requested — draining in-flight requests…');
  } catch (e) {
    /* ignore */
  }
}

async function reset() {
  try {
    await fetch('/api/reset', { method: 'POST' });
  } catch (e) {
    /* ignore */
  }
  state.lastT = -1;
  state.series = { rps: [], err: [], avg: [], p95: [] };
  state.lastReport = null;
  state.finishHandled = false;
  state.rotationCount = 0;
  $('reportCard').hidden = true;
  $('stepsWrap').hidden = true;
  const rotLog = $('rotationLog');
  if (rotLog) rotLog.innerHTML = '<div class="log-empty">No rotations yet.</div>';
  renderVerdict({ idle: true });
  renderKpis({ rps: 0, activeWorkers: 0, latency: {}, errRate: 0, attempted: 0, bytes: 0 });
  renderStatusTable({ statusCounts: {}, attempted: 0 });
  redraw();
  logLine('Reset.');
}

/* ------------------------------ exports ------------------------------ */
function reportCsv(report) {
  const m = report.metrics;
  const rows = [
    ['metric', 'value'],
    ['target', report.config.url],
    ['mode', report.config.mode],
    ['verdict', report.result.status],
    ['requests_attempted', m.attempted],
    ['requests_ok', m.ok],
    ['requests_failed', m.failed],
    ['rps', m.rps.toFixed(2)],
    ['attempted_rps', (m.attemptedRps != null ? m.attemptedRps : m.rps).toFixed(2)],
    ['error_rate_pct', (m.errRate * 100).toFixed(3)],
    ['latency_avg_ms', m.latency.avg.toFixed(2)],
    ['latency_p50_ms', m.latency.p50.toFixed(2)],
    ['latency_p95_ms', m.latency.p95.toFixed(2)],
    ['latency_p99_ms', m.latency.p99.toFixed(2)],
    ['latency_max_ms', m.latency.max.toFixed(2)],
    ['bytes', m.bytes],
    ['defense_detected', report.defense && report.defense.detected ? 'yes' : 'no'],
    ['defense_type', (report.defense && report.defense.type) || ''],
    ['defense_first_seen_request', (report.defense && report.defense.firstSeenRequest) || ''],
    ['rate_limited_responses', report.rateLimited || 0],
    ['soak_degradation', report.soak && report.soak.checked ? (report.soak.degraded ? 'yes' : 'no') : 'n/a'],
    ['soak_first_half_err_pct', report.soak && report.soak.firstHalf ? (report.soak.firstHalf.errRate * 100).toFixed(2) : ''],
    ['soak_second_half_err_pct', report.soak && report.soak.secondHalf ? (report.soak.secondHalf.errRate * 100).toFixed(2) : ''],
    ['soak_first_half_avg_ms', report.soak && report.soak.firstHalf ? report.soak.firstHalf.avgMs : ''],
    ['soak_second_half_avg_ms', report.soak && report.soak.secondHalf ? report.soak.secondHalf.avgMs : ''],
  ];
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}

/* ------------------------------ auto-detect proxy ------------------------------ */
function autoDetectProxy() {
  if ($('proxy').value.trim()) return;
  fetch('/api/test-proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proxy: 'socks5://127.0.0.1:9150', target: 'https://httpbin.org/ip' }),
  }).then(r => r.json()).then(data => {
    if (data.ok) {
      $('proxy').value = 'socks5://127.0.0.1:9150';
      $('proxyStatus').className = 'proxy-status ok';
      $('proxyStatus').textContent = `Tor detected — ${data.ms}ms`;
      logLine('Tor Browser detected and working (port 9150).');
    } else {
      fetch('/api/test-proxy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proxy: 'socks5://127.0.0.1:9050', target: 'https://httpbin.org/ip' }),
      }).then(r => r.json()).then(data2 => {
        if (data2.ok) {
          $('proxy').value = 'socks5://127.0.0.1:9050';
          $('proxyStatus').className = 'proxy-status ok';
          $('proxyStatus').textContent = `Tor detected — ${data2.ms}ms`;
          logLine('Tor Browser detected and working (port 9050).');
        }
      }).catch(() => {});
    }
  }).catch(() => {});
}

/* ------------------------------ wire up ------------------------------ */
function updateRotateWarn() {
  const on = $('autoRotate').checked;
  const hasProxy = $('proxy').value.trim() !== '' || $('proxyList').value.trim() !== '';
  $('rotateWarn').hidden = !(on && !hasProxy);
}
function init() {
  document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('startBtn').addEventListener('click', start);
  $('stopBtn').addEventListener('click', stop);
  $('stopBtnTop').addEventListener('click', stop);
  $('resetBtn').addEventListener('click', reset);
  $('autoRotate').addEventListener('change', updateRotateWarn);
  $('proxy').addEventListener('input', updateRotateWarn);
  $('proxyList').addEventListener('input', updateRotateWarn);
  updateRotateWarn();
  const logoutBtn = $('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
    window.location.replace('/login.html');
  });

  $('demoBtn').addEventListener('click', async () => {
    try {
      const d = await fetch('/api/demo-target').then((r) => r.json());
      $('url').value = d.url;
      $('urlHint').textContent = 'Demo target loaded — safe to test. Press Start.';
      $('urlHint').classList.remove('warn');
      logLine('Loaded built-in demo target.');
    } catch (e) {
      /* ignore */
    }
  });

  $('url').addEventListener('input', () => {
    const u = $('url').value.trim();
    const hint = $('urlHint');
    if (!u) {
      hint.textContent = 'Paste the address of a site or server you own. http and https are supported.';
      hint.classList.remove('warn');
      return;
    }
    if (!/^https?:\/\//i.test(u)) {
      hint.textContent = 'Include the scheme, e.g. https:// or http://';
      hint.classList.add('warn');
    } else {
      hint.textContent = 'Looks good. Remember: only test systems you own or are authorised to test.';
      hint.classList.remove('warn');
    }
  });

  $('exportJson').addEventListener('click', () => {
    if (state.lastReport) download('stromfire-report.json', JSON.stringify(state.lastReport, null, 2), 'application/json');
  });
  $('exportCsv').addEventListener('click', () => {
    if (state.lastReport) download('stromfire-report.csv', reportCsv(state.lastReport), 'text/csv');
  });
  $('copyReport').addEventListener('click', async () => {
    if (!state.lastReport) return;
    const r = state.lastReport;
    const text = `${r.result.headline}\n${formatSummaryLine(Object.assign({ statusCounts: {} }, r.metrics))}\nTarget: ${r.config.url} (${r.config.mode})`;
    try {
      await navigator.clipboard.writeText(text);
      logLine('Summary copied to clipboard.');
    } catch (e) {
      logLine('Copy failed — your browser blocked clipboard access.');
    }
  });
  $('printReport').addEventListener('click', () => window.print());

  /* proxy test button */
  $('testProxyBtn').addEventListener('click', async () => {
    const proxy = $('proxy').value.trim();
    if (!proxy) {
      $('proxyStatus').className = 'proxy-status fail';
      $('proxyStatus').textContent = 'Enter a proxy URL first';
      return;
    }
    $('proxyStatus').className = 'proxy-status testing';
    $('proxyStatus').textContent = 'Testing...';
    $('testProxyBtn').disabled = true;
    try {
      const res = await fetch('/api/test-proxy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proxy, target: $('url').value.trim() || 'https://httpbin.org/ip' }),
      });
      const data = await res.json();
      if (data.ok) {
        $('proxyStatus').className = 'proxy-status ok';
        if (data.ip) {
          $('proxyStatus').textContent = `OK — ${data.ms}ms — IP: ${data.ip}`;
          logLine(`Proxy test OK: ${data.ms}ms, IP: ${escapeHtml(data.ip)}`);
        } else {
          // Target was not an IP-echo endpoint (e.g. an HTML page): the proxy
          // works but there is no exit IP to show. Never print page CSS as IP.
          const detail = data.title ? `page "${data.title}"` : `HTTP ${data.status || '?'}`;
          $('proxyStatus').className = 'proxy-status ok';
          $('proxyStatus').textContent = `OK — ${data.ms}ms via proxy (${detail}; use https://httpbin.org/ip to see exit IP)`;
          logLine(`Proxy test OK: ${data.ms}ms via proxy (${escapeHtml(detail)}, ${fmtNum(data.bytes || 0)} B). ${escapeHtml(data.note || 'Point the probe at an IP-echo URL to see the exit IP.')}`);
        }
      } else {
        $('proxyStatus').className = 'proxy-status fail';
        $('proxyStatus').textContent = `FAIL — ${data.error || 'unknown error'}`;
        logLine(`Proxy test FAILED: ${data.error || 'unknown'}`);
      }
    } catch (e) {
      $('proxyStatus').className = 'proxy-status fail';
      $('proxyStatus').textContent = 'FAIL — network error';
      logLine('Proxy test FAILED: network error');
    }
    $('testProxyBtn').disabled = false;
  });

  /* detect-tor button: one-click Tor setup (fills proxy + control port) */
  $('detectTorBtn').addEventListener('click', async () => {
    $('proxyStatus').className = 'proxy-status testing';
    $('proxyStatus').textContent = 'Detecting Tor...';
    $('detectTorBtn').disabled = true;
    try {
      const data = await fetch('/api/tor-status').then((r) => r.json());
      if (data && data.socks) {
        $('proxy').value = data.proxy;
        $('torControlPort').value = data.control;
        $('proxyStatus').className = 'proxy-status ok';
        $('proxyStatus').textContent = data.mixed
          ? `Found Tor SOCKS :${data.socks} + control :${data.control} (mixed pair) — filled in`
          : `Found Tor SOCKS :${data.socks} + control :${data.control} — filled in`;
        logLine(`Tor detected: SOCKS :${data.socks}, control :${data.control}. Press Test Connection to verify the exit IP.`);
      } else {
        $('proxyStatus').className = 'proxy-status fail';
        $('proxyStatus').textContent = (data && data.hint) || 'Tor not found';
        logLine('Tor detect: nothing on 9150/9050.');
      }
    } catch (e) {
      $('proxyStatus').className = 'proxy-status fail';
      $('proxyStatus').textContent = 'FAIL — network error';
    }
    $('detectTorBtn').disabled = false;
  });

  /* ------------------------------ security scan ------------------------------ */
  const SEV_COLOR = { high: '#ff5d6c', medium: '#f5b544', low: '#4c8dff', info: '#22d3a6' };
  $('secScanBtn').addEventListener('click', async () => {
    const url = $('url').value.trim();
    const box = $('secResults');
    const scoreEl = $('secScore');
    if (!url) { showError('Paste a URL first.'); return; }
    if (!$('confirm').checked) { showError('Tick the authorisation checkbox first.'); return; }
    showError('');
    const btn = $('secScanBtn');
    btn.disabled = true;
    box.innerHTML = '<div class="log-empty">Scanning…</div>';
    scoreEl.hidden = true;
    try {
      const r = await fetch('/api/security', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, confirm: true, tlsVerify: $('tlsVerify').checked }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
      scoreEl.hidden = false;
      scoreEl.textContent = 'score ' + d.score + '/100';
      scoreEl.style.borderColor = d.score >= 80 ? 'var(--pass)' : (d.score >= 50 ? '#f5b544' : 'var(--fail)');
      box.innerHTML = '';
      (d.findings || []).forEach((f) => {
        const div = document.createElement('div');
        div.className = 'rot-entry';
        const color = SEV_COLOR[f.severity] || '#999';
        div.innerHTML = `<span class="rot-time" style="color:${color};font-weight:700">${escapeHtml((f.severity || '').toUpperCase())}</span> ` +
          `<strong>${escapeHtml(f.passed ? '✓' : '✗')} ${escapeHtml(f.title)}</strong><br>` +
          `<span style="color:var(--txt-dim)">${escapeHtml(f.detail || '')}</span>` +
          (f.recommendation ? `<br><span style="color:var(--txt-dim)">→ ${escapeHtml(f.recommendation)}</span>` : '');
        box.appendChild(div);
      });
      box.scrollTop = 0;
      logLine(`Security scan done: score ${d.score}/100, ${(d.findings || []).filter((f) => !f.passed).length} findings.`);
    } catch (e) {
      box.innerHTML = '<div class="log-empty">Scan failed: ' + escapeHtml(e.message) + '</div>';
    }
    btn.disabled = false;
  });

  /* presets */
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.preset;
      if (p === 'gentle') {
        $('concurrency').value = 10; $('rps').value = 0; $('durationSec').value = 30;
        $('maxErr').value = 5; $('maxP95').value = 2000; $('timeoutMs').value = 15000;
        setMode('load');
      } else if (p === 'normal') {
        $('concurrency').value = 50; $('rps').value = 0; $('durationSec').value = 60;
        $('maxErr').value = 1; $('maxP95').value = 1000; $('timeoutMs').value = 10000;
        setMode('load');
      } else if (p === 'aggressive') {
        $('concurrency').value = 200; $('rps').value = 0; $('durationSec').value = 0;
        $('maxErr').value = 0.5; $('maxP95').value = 500; $('timeoutMs').value = 5000;
        setMode('load');
      } else if (p === 'stress') {
        $('stStart').value = 20; $('stStep').value = 20; $('stMax').value = 500; $('stDur').value = 10;
        $('maxErr').value = 1; $('maxP95').value = 1000; $('timeoutMs').value = 10000;
        setMode('stress');
      }
      logLine(`Loaded preset: ${p}`);
    });
  });

  window.addEventListener('resize', () => {
    clearTimeout(window.__rz);
    window.__rz = setTimeout(redraw, 150);
  });

  setMode('load');
  redraw();
  renderVerdict({ idle: true });
  renderHistory();
  connect();
  autoDetectProxy();

  // Prefill the built-in demo target so the first run is always a safe one.
  if (!$('url').value.trim()) {
    fetch('/api/demo-target')
      .then((r) => r.json())
      .then((d) => {
        if (d && d.url && !$('url').value.trim()) {
          $('url').value = d.url;
          $('urlHint').textContent = 'Demo target loaded — safe to test right now. Or paste your own URL.';
        }
      })
      .catch(() => {});
  }

  // Esc = emergency stop (only while a test is running).
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.running) {
      ev.preventDefault();
      stop();
    }
  });

  logLine('Strom Fire ready.');
}

document.addEventListener('DOMContentLoaded', init);
