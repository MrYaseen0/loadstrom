'use strict';

/* Strom Fire dashboard — canvas charts. No dependencies. Depends on format.js (fmtNum). */

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(20, rect.width);
  const h = Math.max(20, rect.height);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function hexA(hex, a) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Draw a line/area chart.
 * series: [{ data:number[], color, fill?:bool, axis?:1|2 }]
 */
function drawChart(canvas, series, opts = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  const padL = 40, padR = 40, padT = 10, padB = 20;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  ctx.clearRect(0, 0, w, h);

  let n = 0;
  for (const s of series) n = Math.max(n, s.data.length);

  if (n === 0) {
    ctx.fillStyle = '#6b7d92';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for data…', w / 2, h / 2);
    return;
  }

  let max1 = 0, max2 = 0;
  for (const s of series) {
    const m = Math.max(0, ...s.data);
    if (s.axis === 2) max2 = Math.max(max2, m);
    else max1 = Math.max(max1, m);
  }
  if (max1 === 0) max1 = 1;
  if (max2 === 0) max2 = 1;
  // Snap axis tops to "nice" values so the plotted points match the printed labels.
  max1 = niceMax(max1);
  max2 = niceMax(max2);
  const y1 = (v) => padT + plotH - (v / max1) * plotH;
  const y2 = (v) => padT + plotH - (v / max2) * plotH;
  const x = (i) => (n <= 1 ? padL : padL + (i / (n - 1)) * plotW);

  // grid
  ctx.strokeStyle = '#1b2531';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#6b7d92';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  for (let g = 0; g <= 4; g++) {
    const vy = padT + (plotH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, vy);
    ctx.lineTo(padL + plotW, vy);
    ctx.stroke();
    ctx.fillText(fmtNum(max1 * (1 - g / 4)), padL - 6, vy + 3);
  }
  if (max2 > 0) {
    ctx.textAlign = 'left';
    for (let g = 0; g <= 4; g++) {
      const vy = padT + (plotH * g) / 4;
      ctx.fillText(fmtNum(max2 * (1 - g / 4)), padL + plotW + 6, vy + 3);
    }
  }

  for (const s of series) {
    if (!s.data.length) continue;
    const yy = s.axis === 2 ? y2 : y1;
    if (s.fill) {
      ctx.beginPath();
      ctx.moveTo(x(0), padT + plotH);
      for (let i = 0; i < s.data.length; i++) ctx.lineTo(x(i), yy(s.data[i]));
      ctx.lineTo(x(s.data.length - 1), padT + plotH);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, hexA(s.color, 0.28));
      grad.addColorStop(1, hexA(s.color, 0.02));
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < s.data.length; i++) {
      const px = x(i), py = yy(s.data[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // x label
  ctx.fillStyle = '#6b7d92';
  ctx.textAlign = 'left';
  ctx.fillText(`${n}s`, padL, h - 6);
}
