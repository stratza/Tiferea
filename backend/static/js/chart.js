// Dependency-free time-series chart on <canvas>: y gridlines, time axis,
// request/limit reference lines, and a hover crosshair with tooltip.
// compact mode (pod panel) keeps the lines but drops the axis labels.
// Theme colors are read from CSS variables at draw time.

import { el } from './util.js';

const FONT = '10px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

function themeColor(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || '#888';
}

function hhmm(tsSeconds) {
  return new Date(tsSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function timeChart({ fmtY = String, height = 120, compact = false } = {}) {
  const canvas = el('canvas');
  const tip = el('div', { class: 'chart-tip hidden' });
  const root = el('div', { class: `chart${compact ? ' chart-compact' : ''}`,
                           style: `height:${height}px` }, canvas, tip);

  let samples = [];   // [tsSeconds, value], ascending
  let refs = [];      // { label, value, tone: 'warn' | 'bad' }
  let hover = -1;     // hovered sample index
  let destroyed = false;

  const pad = compact ? { l: 5, r: 5, t: 5, b: 5 } : { l: 56, r: 10, t: 8, b: 18 };

  function scale() {
    const w = root.clientWidth;
    const h = root.clientHeight;
    const t0 = samples.length ? samples[0][0] : 0;
    const t1 = samples.length ? Math.max(samples[samples.length - 1][0], t0 + 1) : 1;
    let vmax = 1e-9;
    for (const s of samples) vmax = Math.max(vmax, s[1]);
    for (const r of refs) vmax = Math.max(vmax, r.value);
    const ymax = vmax * 1.15;   // headroom so the line never touches the top
    return {
      w, h, t0, t1, vmax, ymax,
      x: (t) => pad.l + ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r),
      y: (v) => h - pad.b - (v / ymax) * (h - pad.t - pad.b),
    };
  }

  function draw() {
    if (destroyed) return;
    const w = root.clientWidth;
    const h = root.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const fg = themeColor('--fg');
    const muted = themeColor('--muted');
    const border = themeColor('--border');
    const tone = { warn: themeColor('--warn'), bad: themeColor('--bad') };
    const s = scale();
    ctx.font = FONT;

    if (!compact) {
      ctx.strokeStyle = border;
      ctx.fillStyle = muted;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const v of [s.vmax / 2, s.vmax]) {
        const yy = s.y(v);
        ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
        ctx.fillText(fmtY(v), pad.l - 6, yy);
      }
      if (samples.length > 1) {
        ctx.textBaseline = 'top';
        for (const f of [0, 0.5, 1]) {
          const t = s.t0 + (s.t1 - s.t0) * f;
          ctx.textAlign = f === 0 ? 'left' : f === 1 ? 'right' : 'center';
          ctx.fillText(hhmm(t), s.x(t), h - pad.b + 4);
        }
      }
    }

    ctx.strokeStyle = border;
    ctx.beginPath(); ctx.moveTo(pad.l, h - pad.b); ctx.lineTo(w - pad.r, h - pad.b); ctx.stroke();

    for (const r of refs) {
      const yy = s.y(r.value);
      ctx.strokeStyle = tone[r.tone] || muted;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
      ctx.setLineDash([]);
      if (!compact) {
        ctx.fillStyle = tone[r.tone] || muted;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(r.label, w - pad.r - 2, yy - 1);
      }
    }

    if (samples.length > 1) {
      ctx.beginPath();
      samples.forEach((p, i) => {
        if (i === 0) ctx.moveTo(s.x(p[0]), s.y(p[1]));
        else ctx.lineTo(s.x(p[0]), s.y(p[1]));
      });
      ctx.strokeStyle = fg;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineTo(s.x(samples[samples.length - 1][0]), h - pad.b);
      ctx.lineTo(s.x(samples[0][0]), h - pad.b);
      ctx.closePath();
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = fg;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    } else if (samples.length === 1) {
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(s.x(samples[0][0]), s.y(samples[0][1]), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (hover >= 0 && hover < samples.length) {
      const [t, v] = samples[hover];
      ctx.strokeStyle = muted;
      ctx.beginPath(); ctx.moveTo(s.x(t), pad.t); ctx.lineTo(s.x(t), h - pad.b); ctx.stroke();
      ctx.fillStyle = fg;
      ctx.beginPath(); ctx.arc(s.x(t), s.y(v), 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  function onMove(e) {
    if (!samples.length) return;
    const rect = canvas.getBoundingClientRect();
    const s = scale();
    const t = s.t0 + ((e.clientX - rect.left - pad.l) / Math.max(1, s.w - pad.l - pad.r)) * (s.t1 - s.t0);
    let best = 0;
    for (let i = 1; i < samples.length; i++) {
      if (Math.abs(samples[i][0] - t) < Math.abs(samples[best][0] - t)) best = i;
    }
    hover = best;
    const [ts, v] = samples[best];
    tip.textContent = `${new Date(ts * 1000).toLocaleTimeString()} · ${fmtY(v)}`;
    tip.classList.remove('hidden');
    tip.style.left = `${Math.min(Math.max(s.x(ts) + 8, 0), s.w - tip.offsetWidth - 4)}px`;
    tip.style.top = `${Math.max(s.y(v) - tip.offsetHeight - 8, 0)}px`;
    draw();
  }

  function onLeave() {
    hover = -1;
    tip.classList.add('hidden');
    draw();
  }

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  const ro = new ResizeObserver(() => draw());
  ro.observe(root);

  return {
    el: root,
    set(newSamples, newRefs = []) {
      samples = newSamples || [];
      refs = newRefs || [];
      if (hover >= samples.length) hover = -1;
      draw();
    },
    destroy() {
      destroyed = true;
      ro.disconnect();
    },
  };
}
