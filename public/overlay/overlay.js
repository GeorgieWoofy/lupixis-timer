import { Connection, flag, params, autoHideCursor } from '/shared/client.js';
import { TimeDisplay } from '/overlay/timedisplay.js';

const canvas = document.getElementById('canvas');
const graphic = document.getElementById('graphic');
const q = (sel) => graphic.querySelector(sel);
const els = {
  bgfill: q('.bgfill'), logo: q('.logo'), label: q('.label'), sub: q('.sublabel'), fill: q('.fill'),
  ringBig: q('.ring-big .ring-fill'), ringMini: q('.ring-mini .ring-fill'),
};
const time = new TimeDisplay(q('.time'));

const bg = params.get('bg') || 'transparent';
if (bg !== 'transparent') document.body.classList.add(`bg-${bg}`);
const forcedLayout = params.get('layout');
const always = flag('always', false);
if (flag('checker', false)) document.body.classList.add('checker'); // controller preview
autoHideCursor();
// Esc closes a fullscreen output window in the desktop app.
addEventListener('keydown', (e) => e.key === 'Escape' && window.lupixisDesktop?.closeOutput?.());

const conn = new Connection({ role: flag('preview', false) ? 'preview' : 'overlay' });

// Scale the 1920×1080 design canvas to the window, centred (letterboxed).
function scale() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  canvas.style.transform = `translate(${(innerWidth - 1920 * s) / 2}px, ${(innerHeight - 1080 * s) / 2}px) scale(${s})`;
}
addEventListener('resize', scale);
scale();

/** Progress style, with backwards compatibility for the old on/off setting. */
const progressStyle = (o) => (o.showProgress === false ? 'none' : o.progressStyle || 'bar');

let fontUrl = null;
conn.on('state', (s) => {
  const th = s.theme;
  const o = s.overlay;
  const root = document.documentElement.style;
  root.setProperty('--text', th.textColor);
  root.setProperty('--accent', th.accentColor);
  root.setProperty('--panel', hexToRgba(th.panelColor, th.panelOpacity));
  root.setProperty('--radius', `${th.radius}px`);
  root.setProperty('--weight', th.fontWeight);
  root.setProperty('--label-transform', th.uppercaseLabel ? 'uppercase' : 'none');
  root.setProperty('--font', `${th.fontUrl ? '"LupixisCustom", ' : ''}"${th.fontFamily}", 'Segoe UI', system-ui, sans-serif`);
  if (th.fontUrl !== fontUrl) {
    fontUrl = th.fontUrl;
    document.getElementById('fontFace').textContent = fontUrl ? `@font-face { font-family: "LupixisCustom"; src: url("${fontUrl}"); }` : '';
  }

  const layout = forcedLayout || o.layout;
  graphic.className = `layout-${layout} prog-${progressStyle(o)}`;
  graphic.classList.toggle('on', always || o.onAir);
  graphic.classList.toggle('has-logo', !!(th.logoUrl && th.showLogo));
  if (th.logoUrl && els.logo.getAttribute('src') !== th.logoUrl) els.logo.src = th.logoUrl;

  els.bgfill.classList.toggle('show', th.background !== 'none');
  els.bgfill.style.backgroundColor = th.background === 'color' ? th.backgroundColor : '#000';
  els.bgfill.style.backgroundImage = th.background === 'image' && th.backgroundUrl ? `url("${th.backgroundUrl}")` : 'none';

  const cue = s.rundown.find((c) => c.id === s.currentId);
  els.label.textContent = o.label || cue?.title || '';
  els.sub.textContent = o.subLabel || '';
});

function frame() {
  const s = conn.state;
  if (s) {
    const c = conn.timer();
    const o = s.overlay;
    const opts = { anim: o.digitAnimation, leadingZero: o.leadingZero, hideZeroMinutes: o.hideZeroMinutes, highlight: o.highlight };
    if (!c.loaded) {
      time.showText('--:--');
    } else if (c.mode === 'countup') {
      time.show(c.elapsed / 1000, opts);
    } else if (c.remaining > 0) {
      time.show(Math.ceil(c.remaining / 1000), opts);
    } else if (o.atZero === 'text') {
      time.showText(o.zeroText);
    } else if (o.atZero === 'overtime') {
      time.show(-c.remaining / 1000, { ...opts, sign: '+' });
    } else {
      time.show(0, opts);
    }
    const p = c.progress;
    els.fill.style.width = `${(p * 100).toFixed(2)}%`;
    // Rings show the time left: full at the start, empty at zero.
    const offset = (p * 100).toFixed(2);
    els.ringBig.style.strokeDashoffset = offset;
    els.ringMini.style.strokeDashoffset = offset;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
