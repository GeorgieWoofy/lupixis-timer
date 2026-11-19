// Browser-side connection to the Lupixis Timer server: live state, clock sync, actions, translations.
import { computeTimer } from './timecalc.js';

/**
 * Live connection. Keeps `state` up to date and estimates the offset between this device's clock
 * and the server's, so every screen shows exactly the same second.
 */
export class Connection {
  constructor({ role = 'viewer' } = {}) {
    this.role = role;
    this.state = null;
    this.connected = false;
    this.offset = 0; // serverTime ≈ Date.now() + offset
    this._samples = [];
    this._listeners = { state: [], status: [], clips: [] };
    this.clips = []; // clip timers from QLab / CasparCG
    this.clipStatus = {};
    this._pending = new Map();
    this._seq = 0;
    this._connect();
  }

  /** Current time on the server's clock (ms). */
  now() {
    return Date.now() + this.offset;
  }

  /** Clip timers with their remaining seconds right now (playing clips keep counting between updates). */
  clipsNow() {
    const now = this.now();
    return this.clips.map((c) => {
      const remaining = c.paused ? c.remaining : Math.max(0, c.remaining - (now - c.at) / 1000);
      return { ...c, remainingNow: remaining, progress: c.duration > 0 ? 1 - remaining / c.duration : 0 };
    });
  }

  /** Computed timer values for right now. */
  timer() {
    return computeTimer(this.state?.timer, this.now());
  }

  on(event, fn) {
    this._listeners[event].push(fn);
    if (event === 'state' && this.state) fn(this.state);
    if (event === 'status') fn(this.connected);
  }

  _emit(event, arg) {
    for (const fn of this._listeners[event]) fn(arg);
  }

  /** Run an action on the server. Resolves with its result, rejects with its error. */
  action(name, params = {}) {
    if (this.ws?.readyState === 1) {
      const id = ++this._seq;
      this.ws.send(JSON.stringify({ t: 'action', id, name, params }));
      return new Promise((resolve, reject) => {
        this._pending.set(id, { resolve, reject });
        setTimeout(() => this._pending.delete(id) && reject(new Error('Timed out')), 5000);
      });
    }
    // Fallback while reconnecting.
    return fetch(`/api/action/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) })
      .then((r) => r.json())
      .then((r) => (r.ok ? r : Promise.reject(new Error(r.error))));
  }

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this._emit('status', true);
      ws.send(JSON.stringify({ t: 'hello', role: this.role }));
      this._samples = [];
      // A burst of pings for a quick initial sync, then a slow refresh.
      for (let i = 0; i < 6; i++) setTimeout(() => this._ping(), i * 150);
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => this._ping(), 10000);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'state') {
        this.state = msg.state;
        if (!this._samples.length) this.offset = msg.state.serverTime - Date.now(); // rough until pings arrive
        this._emit('state', msg.state);
      } else if (msg.t === 'clips') {
        this.clips = msg.clips || [];
        this.clipStatus = msg.status || {};
        this._emit('clips', this.clips);
      } else if (msg.t === 'pong') {
        this._onPong(msg);
      } else if (msg.t === 'result') {
        const p = this._pending.get(msg.id);
        if (!p) return;
        this._pending.delete(msg.id);
        msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
      }
    };
    ws.onclose = () => {
      clearInterval(this._pingTimer);
      if (this.connected) {
        this.connected = false;
        this._emit('status', false);
      }
      setTimeout(() => this._connect(), 1000);
    };
    ws.onerror = () => ws.close();
  }

  _ping() {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'ping', id: ++this._seq, c: Date.now() }));
  }

  _onPong({ c, s }) {
    const now = Date.now();
    const rtt = now - c;
    this._samples.push({ rtt, offset: s - (c + rtt / 2) });
    if (this._samples.length > 10) this._samples.shift();
    // The sample with the smallest round-trip is the most accurate.
    const best = this._samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
  }
}

// ---- translations ------------------------------------------------------------
// Strings live in /locales/<code>.json. English is always loaded as the fallback,
// so a partial community translation never shows empty labels.

let strings = {};
let fallback = {};
let currentLang = null;

export async function loadLanguage(code = 'en') {
  if (code === currentLang) return;
  if (!Object.keys(fallback).length) fallback = await fetch('/locales/en.json').then((r) => r.json());
  strings = code === 'en' ? fallback : await fetch(`/locales/${code}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  currentLang = code;
  document.documentElement.lang = code;
}

/** Translate a key like "transport.start". `{name}` placeholders are filled from `vars`. */
export function t(key, vars) {
  let s = lookup(strings, key) ?? lookup(fallback, key) ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  return s;
}

function lookup(obj, key) {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/** Fill every element with data-i18n / data-i18n-title / data-i18n-placeholder. */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  root.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
}

// ---- small DOM helpers ---------------------------------------------------------

/** Create an element: h('button', {class:'x', onclick}, 'Label') */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

/** Set an input's value unless the user is currently typing in it. */
export function setVal(el, value) {
  if (!el || document.activeElement === el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else if (el.value !== String(value ?? '')) el.value = value ?? '';
}

/** Scale `el`'s font so its text fills `box` (width and height) without overflowing. */
export function fitText(el, box, { max = 2000, fill = 0.96 } = {}) {
  const bw = box.clientWidth;
  const bh = box.clientHeight;
  if (!bw || !bh) return;
  el.style.fontSize = '100px';
  const w = el.scrollWidth || 1;
  const hgt = el.scrollHeight || 1;
  const size = Math.min((bw * fill * 100) / w, (bh * fill * 100) / hgt, max);
  el.style.fontSize = `${Math.floor(size)}px`;
}

/** Like fitText, but for text that may wrap onto several lines (messages). Binary search on font size. */
export function fitWrappedText(el, box, { min = 10, max = 400, fill = 0.92 } = {}) {
  const cs = getComputedStyle(box);
  const bw = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const bh = (box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) * fill;
  if (bw <= 0 || bh <= 0) return;
  let lo = min, hi = max;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    el.style.fontSize = `${mid}px`;
    if (el.scrollHeight <= bh && el.scrollWidth <= bw) lo = mid;
    else hi = mid;
  }
  el.style.fontSize = `${lo}px`;
}

/** Hide the mouse cursor after a moment of no movement (for output screens). */
export function autoHideCursor(ms = 2000) {
  let timer;
  const show = () => {
    document.body.classList.remove('hide-cursor');
    clearTimeout(timer);
    timer = setTimeout(() => document.body.classList.add('hide-cursor'), ms);
  };
  addEventListener('mousemove', show);
  show();
}

/** Keep tablets/phones used as confidence monitors from going to sleep. */
export async function keepAwake() {
  try {
    let lock = await navigator.wakeLock?.request('screen');
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && (!lock || lock.released)) lock = await navigator.wakeLock?.request('screen');
    });
  } catch {
    /* not supported or not allowed: fine */
  }
}

export const params = new URLSearchParams(location.search);
/** Read a boolean URL parameter (?clock=0 / ?clock=1), or `def` when missing. */
export function flag(name, def) {
  if (!params.has(name)) return def;
  const v = params.get(name);
  return v === '' || v === '1' || v === 'true' || v === 'yes';
}

export function formatClock(ms, h24 = true) {
  const d = new Date(ms);
  let hh = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (h24) return `${String(hh).padStart(2, '0')}:${mm}`;
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 || 12;
  return `${hh}:${mm} ${ampm}`;
}
