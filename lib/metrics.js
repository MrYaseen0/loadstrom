'use strict';

// Metrics collection for a load test.
//
// Design notes:
//  - Latency percentiles use a *reservoir sample* with a fixed capacity so memory
//    stays bounded no matter how many requests a run issues. Min/avg/max are exact.
//  - A per-second timeline bucket powers the live charts; per-bucket latency samples
//    are capped so long runs stay cheap to render.
//  - No dependencies.

/** Nearest-rank percentile on an already-sorted ascending array. */
function percentileNearestRank(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[n - 1];
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(n - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/** Fixed-capacity reservoir sampler (uniform random replacement). */
class Reservoir {
  constructor(cap) {
    this.cap = Math.max(1, cap | 0);
    this.n = 0;
    this.buf = new Float64Array(this.cap);
    this._sorted = null;
    this._dirty = true;
  }
  add(v) {
    this.n++;
    if (this.n <= this.cap) {
      this.buf[this.n - 1] = v;
    } else {
      const j = Math.floor(Math.random() * this.n);
      if (j < this.cap) this.buf[j] = v;
    }
    this._dirty = true;
  }
  sorted() {
    if (this._dirty) {
      const len = Math.min(this.n, this.cap);
      const a = Array.from(this.buf.subarray(0, len));
      a.sort((x, y) => x - y);
      this._sorted = a;
      this._dirty = false;
    }
    return this._sorted;
  }
  size() {
    return Math.min(this.n, this.cap);
  }
  clear() {
    this.n = 0;
    this._sorted = null;
    this._dirty = true;
  }
}

const PHASE_NAMES = ['dns', 'tcp', 'tls', 'ttfb', 'download'];

class PhaseReservoir {
  constructor(cap) {
    this.cap = Math.max(1, cap | 0);
    this.n = 0;
    this.bufs = {};
    for (const p of PHASE_NAMES) this.bufs[p] = new Float64Array(this.cap);
    this._sorted = {};
    this._dirty = true;
  }
  add(phases) {
    this.n++;
    for (const p of PHASE_NAMES) {
      const v = phases[p] || 0;
      if (this.n <= this.cap) {
        this.bufs[p][this.n - 1] = v;
      } else {
        const j = Math.floor(Math.random() * this.n);
        if (j < this.cap) this.bufs[p][j] = v;
      }
    }
    this._dirty = true;
  }
  sorted(phase) {
    if (this._dirty) {
      const len = Math.min(this.n, this.cap);
      for (const p of PHASE_NAMES) {
        const a = Array.from(this.bufs[p].subarray(0, len));
        a.sort((x, y) => x - y);
        this._sorted[p] = a;
      }
      this._dirty = false;
    }
    return this._sorted[phase] || [];
  }
  size() {
    return Math.min(this.n, this.cap);
  }
  clear() {
    this.n = 0;
    this._sorted = {};
    this._dirty = true;
  }
}

class Metrics {
  /**
   * @param {object} opts
   * @param {number} [opts.sampleCap] reservoir capacity (default 200000)
   * @param {number} [opts.maxTimeline] buckets kept in the returned timeline
   * @param {boolean} [opts.trackPhases] track connection phases (DNS, TCP, TLS, TTFB, download)
   */
  constructor(opts = {}) {
    this.sampleCap = opts.sampleCap || 200000;
    this.maxTimeline = opts.maxTimeline || 1200;
    this.trackPhases = opts.trackPhases !== false;
    this.startedAt = Date.now();

    this.attempted = 0;
    this.completed = 0;
    this.ok = 0;
    this.failed = 0;
    this.timeouts = 0;
    this.connErrors = 0;
    this.bytes = 0;

    this.status = new Map();
    this.lat = new Reservoir(this.sampleCap);
    this.phaseLat = this.trackPhases ? new PhaseReservoir(this.sampleCap) : null;
    this.sumLat = 0;
    this.countLat = 0;
    this.minLat = null;
    this.maxLat = null;

    this.seconds = []; // per-second buckets
  }

  reset() {
    this.startedAt = Date.now();
    this.attempted = 0;
    this.completed = 0;
    this.ok = 0;
    this.failed = 0;
    this.timeouts = 0;
    this.connErrors = 0;
    this.bytes = 0;
    this.status = new Map();
    this.lat.clear();
    if (this.phaseLat) this.phaseLat.clear();
    this.sumLat = 0;
    this.countLat = 0;
    this.minLat = null;
    this.maxLat = null;
    this.seconds = [];
  }

  _bucket(nowMs) {
    const sec = Math.max(0, Math.floor((nowMs - this.startedAt) / 1000));
    // Absolute second index as t so trimming old buckets never desyncs labels
    let cur = this.seconds.length ? this.seconds[this.seconds.length - 1] : null;
    if (cur && sec <= cur.t) return cur; // clock jump backwards: reuse current bucket
    if (!cur || cur.t !== sec) {
      // Gap fill (cap fill to avoid pathological memory on clock jumps)
      const lastT = cur ? cur.t : sec - 1;
      const gap = Math.min(Math.max(0, sec - lastT), this.maxTimeline);
      const from = sec - gap + 1;
      for (let t = Math.max(lastT + 1, from); t <= sec; t++) {
        this.seconds.push({ t, count: 0, ok: 0, err: 0, sumLat: 0, nLat: 0, lat: [] });
      }
      cur = this.seconds[this.seconds.length - 1];
    }
    // Trim oldest buckets to bound memory; t stays absolute
    if (this.seconds.length > this.maxTimeline) {
      this.seconds.splice(0, this.seconds.length - this.maxTimeline);
    }
    return cur;
  }

  /**
   * Record one request result.
   * @param {{latencyMs?:number, status?:number, bytes?:number, kind?:string}} r
   *   kind: undefined (success), 'timeout', or 'error'
   */
  record(r) {
    const nowMs = Date.now();
    const b = this._bucket(nowMs);
    b.count++;
    this.attempted++;

    if (r.bytes) this.bytes += r.bytes;

    if (r.latencyMs != null && isFinite(r.latencyMs)) {
      this.lat.add(r.latencyMs);
      if (this.phaseLat && r.phases) this.phaseLat.add(r.phases);
      this.sumLat += r.latencyMs;
      this.countLat++;
      b.sumLat += r.latencyMs;
      b.nLat++;
      if (b.lat.length < 256) {
        b.lat.push(r.latencyMs);
      } else {
        b.lat[b.lat.length - 1 - (b.nLat % 256)] = r.latencyMs;
      }
      b._gen = (b._gen || 0) + 1;
      if (this.minLat === null || r.latencyMs < this.minLat) this.minLat = r.latencyMs;
      if (this.maxLat === null || r.latencyMs > this.maxLat) this.maxLat = r.latencyMs;
    }

    if (r.kind === 'timeout') {
      this.timeouts++;
      this.failed++;
      b.err++;
    } else if (r.kind === 'error') {
      this.connErrors++;
      this.failed++;
      b.err++;
    } else {
      this.completed++;
      const sc = r.status | 0;
      this.status.set(sc, (this.status.get(sc) || 0) + 1);
      if (sc >= 200 && sc < 400) {
        this.ok++;
        b.ok++;
      } else {
        this.failed++;
        b.err++;
      }
    }
  }

  snapshot(extra) {
    const elapsedMs = Date.now() - this.startedAt;
    const sec = elapsedMs / 1000;
    const sorted = this.lat.sorted();

    const start = Math.max(0, this.seconds.length - this.maxTimeline);
    const timeline = [];
    for (let i = start; i < this.seconds.length; i++) {
      const b = this.seconds[i];
      let p95 = 0;
      if (b.lat.length) {
        // Per-bucket p95 is cached but invalidated when new data arrives
        if (b._p95 == null || b._p95gen !== b._gen) {
          const s = b.lat.slice().sort((x, y) => x - y);
          b._p95 = percentileNearestRank(s, 95);
          b._p95gen = b._gen;
        }
        p95 = b._p95;
      }
      timeline.push({
        t: b.t,
        count: b.count,
        rps: b.count,
        ok: b.ok,
        err: b.err,
        errRate: b.count ? b.err / b.count : 0,
        avg: b.nLat ? b.sumLat / b.nLat : 0,
        p95,
      });
    }

    const statusCounts = {};
    for (const [k, v] of this.status.entries()) {
      statusCounts[k] = v;
    }

    const latency = {
      min: this.minLat == null ? 0 : this.minLat,
      max: this.maxLat == null ? 0 : this.maxLat,
      avg: this.countLat ? this.sumLat / this.countLat : 0,
      p50: percentileNearestRank(sorted, 50),
      p90: percentileNearestRank(sorted, 90),
      p95: percentileNearestRank(sorted, 95),
      p99: percentileNearestRank(sorted, 99),
    };

    // Add phase percentiles if tracking enabled
    if (this.trackPhases && this.phaseLat) {
      for (const p of PHASE_NAMES) {
        const ps = this.phaseLat.sorted(p);
        if (ps.length) {
          latency[`${p}_p50`] = percentileNearestRank(ps, 50);
          latency[`${p}_p95`] = percentileNearestRank(ps, 95);
          latency[`${p}_p99`] = percentileNearestRank(ps, 99);
        }
      }
    }

    const out = {
      elapsedSec: +sec.toFixed(2),
      attempted: this.attempted,
      completed: this.completed,
      ok: this.ok,
      failed: this.failed,
      timeouts: this.timeouts,
      connErrors: this.connErrors,
      bytes: this.bytes,
      // rps = completed responses/sec (legacy field, kept for compat).
      // attemptedRps = offered load/sec — the honest throughput number when
      // every request dies in the proxy/Tor path and completed stays 0.
      rps: sec > 0 ? this.completed / sec : 0,
      attemptedRps: sec > 0 ? this.attempted / sec : 0,
      errRate: this.attempted > 0 ? this.failed / this.attempted : 0,
      latency,
      statusCounts,
      sampleSize: sorted.length,
      timeline,
    };
    return Object.assign(out, extra || {});
  }
}

module.exports = { Metrics, Reservoir, PhaseReservoir, percentileNearestRank };
