'use strict';

/* Strom Fire dashboard — formatting helpers. No dependencies. */

function fmtNum(n, d = 0) {
  if (!isFinite(n)) return '0';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtL(v) {
  if (!isFinite(v) || v < 0.05) return '0';
  return fmtNum(v, v < 10 ? 1 : 0);
}
function fmtMs(v) {
  if (!isFinite(v)) return '0';
  return v < 10 ? fmtNum(v, 1) : fmtNum(Math.round(v));
}
function fmtBytes(n) {
  if (!n || n < 1) return '0 <small>B</small>';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${fmtNum(v, i === 0 ? 0 : 1)} <small>${u[i]}</small>`;
}
function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* Display rate: completed responses/sec, falling back to offered attempts/sec
   when nothing completed (total proxy-path failure reads "0 rps" otherwise). */
function displayRps(p) {
  if ((p.rps || 0) > 0) return p.rps;
  return p.attemptedRps || 0;
}
function formatSummaryLine(p) {
  // p.rps counts completed responses; when everything dies in the proxy path
  // it reads 0 and hides the offered volume, so show attempted/s as context.
  const base = `${fmtNum(p.ok)} OK · ${fmtNum(p.failed)} failed · p95 ${fmtMs(p.latency.p95)} ms · p99 ${fmtMs(p.latency.p99)} ms · ${fmtNum(p.rps)} rps avg`;
  if ((p.rps || 0) === 0 && (p.attemptedRps || 0) > 0 && (p.attempted || 0) > 0) {
    return `${base} (${fmtNum(p.attemptedRps)} attempts/s offered, 0 completed)`;
  }
  return base;
}
