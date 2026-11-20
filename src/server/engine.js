// The timer engine: owns the whole show state and every action that can change it.
// The server, the Electron shell, hotkeys and Companion all go through `engine.dispatch()`.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { computeTimer, emptyTimer, nextClockTime, parseDuration, parseClockTime, formatTimeOfDay, todayAt, MODES } from '../../public/shared/timecalc.js';

export const MESSAGE_COLORS = ['white', 'yellow', 'red', 'green', 'blue'];
export const OVERLAY_LAYOUTS = ['fullscreen', 'lowerthird', 'bar', 'corner'];

export function defaultState() {
  return {
    version: 1,
    rundown: [],
    currentId: null,
    timer: emptyTimer(),
    message: { text: '', color: 'white', flash: false, visible: false },
    messagePresets: ['Wrap up', '5 minutes left', 'Speak louder', 'Slow down', 'Take questions now', 'Please finish now'],
    blackout: false,
    flashUntil: 0,
    overlay: {
      onAir: false,
      layout: 'fullscreen',
      label: '', // empty = use the current cue title
      subLabel: '',
      atZero: 'hold', // hold | text | overtime
      zeroText: "We're live!",
      showProgress: true, // kept for older show files; progressStyle is the real setting
      progressStyle: 'bar', // bar | ring | none
      digitAnimation: 'slide', // slide (new digit pushes old one down) | fade | none
      highlight: 'none', // none | hours | minutes | seconds  (coloured with the accent colour)
      leadingZero: true, // "05:07" vs "5:07"
      hideZeroMinutes: false, // under one minute show just "45" (hours always collapse when zero)
    },
    theme: {
      fontFamily: 'Segoe UI',
      fontUrl: '',
      fontWeight: 700,
      // Lupixis Media palette
      textColor: '#e6e8e6',
      accentColor: '#3772ff',
      panelColor: '#27292b',
      panelOpacity: 0.85,
      logoUrl: '',
      showLogo: true,
      background: 'none', // none | color | image  (only drawn by the fullscreen layout)
      backgroundColor: '#27292b',
      backgroundUrl: '',
      uppercaseLabel: true,
      radius: 18,
    },
    show: { name: '', dirty: false }, // which saved show is loaded (show library)
    settings: {
      language: 'en',
      clock24: true, // 24-hour clock everywhere in the app
      defaultDuration: 300000,
      defaultWarning: 120000,
      defaultCritical: 30000,
      // idleDisplay: what to show when no timer is running: 'timer' | 'clock' | 'clockDate'
      viewer: { showClock: true, showTitle: true, showNext: true, showProgress: true, clock24: true, idleDisplay: 'timer', showClips: true },
      // The floating window has its own options. controls: 'hover' | 'always' | 'off'
      floating: { showTitle: false, showProgress: true, showMessage: true, idleDisplay: 'timer', controls: 'hover', opacity: 1, showClips: true },
      // Clip timers: show how long a playing video/audio clip has left.
      integrations: {
        qlab: { enabled: false, host: '', port: 53000, passcode: '', filter: 'color', color: 'red', tag: '[T]' },
        caspar: { enabled: false, port: 6250, filter: 'all', layers: '', tag: '[T]' },
      },
      autoStartScheduled: true, // cues with a start time start themselves when that time arrives
      hotkeys: {
        toggle: 'Control+Alt+Enter',
        next: 'Control+Alt+PageDown',
        previous: 'Control+Alt+PageUp',
        addMinute: 'Control+Alt+Up',
        subtractMinute: 'Control+Alt+Down',
        blackout: 'Control+Alt+B',
        toggleMessage: 'Control+Alt+M',
        toggleFloating: 'Control+Alt+T',
      },
      floatingKeepOnTop: true,
    },
    log: [], // show report: what actually happened
  };
}

/** Deep-merge saved data over defaults so new settings appear after an update. Arrays are replaced. */
function mergeDefaults(def, saved) {
  if (!isPlainObject(def) || !isPlainObject(saved)) return saved === undefined ? def : saved;
  const out = { ...def };
  for (const [k, v] of Object.entries(saved)) out[k] = k in def ? mergeDefaults(def[k], v) : v;
  return out;
}
const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Read a duration from action params: {ms}, {seconds}, {minutes} or {text:"5:00"}. */
function msFrom(p, fallback = null) {
  if (p.ms != null && p.ms !== '') return Number(p.ms);
  if (p.seconds != null && p.seconds !== '') return Number(p.seconds) * 1000;
  if (p.minutes != null && p.minutes !== '') return Number(p.minutes) * 60000;
  if (p.text != null) return parseDuration(p.text);
  if (p.value != null) return parseDuration(p.value);
  return fallback;
}
const truthy = (v) => v === true || v === 'true' || v === '1' || v === 1 || v === 'on';

export class Engine extends EventEmitter {
  constructor(saved) {
    super();
    this.state = mergeDefaults(defaultState(), saved || {});
    // 0.4 -> 0.5: the 12/24-hour choice moved from the confidence-monitor settings to a general setting.
    if (saved?.settings?.viewer?.clock24 === false && saved.settings.clock24 == null) this.state.settings.clock24 = false;
    this.state.rundown = (this.state.rundown || []).map(sanitizeCue);
    this.host = { type: 'server' }; // replaced by the Electron shell with display/window info
    this.clients = {}; // connected clients by role
    this._advancing = false;
    this._fired = new Map(); // cue id -> epoch of the scheduled start already triggered
    this._interval = setInterval(() => this.tick(), 200);
  }

  destroy() {
    clearInterval(this._interval);
  }

  /** Everything clients need, in one object. */
  snapshot() {
    return { ...this.state, host: this.host, clients: this.clients, serverTime: Date.now() };
  }

  computed(now = Date.now()) {
    return computeTimer(this.state.timer, now);
  }

  currentIndex() {
    return this.state.rundown.findIndex((c) => c.id === this.state.currentId);
  }

  /** Only the timers (rundown items that aren't group headings or notes). */
  cues() {
    return this.state.rundown.filter(isCue);
  }

  /** Position of the current cue among the timers (0-based), or -1. */
  currentCueIndex() {
    return this.cues().findIndex((c) => c.id === this.state.currentId);
  }

  currentCue() {
    return this.state.rundown.find((c) => c.id === this.state.currentId) || null;
  }

  setHost(info) {
    this.host = info;
    this.emit('change', { persist: false });
  }

  setClients(counts) {
    this.clients = counts;
    this.emit('change', { persist: false });
  }

  /** Run a named action. Throws on unknown actions or bad input. */
  dispatch(name, params = {}) {
    const fn = ACTIONS[name];
    if (!fn) throw new Error(`Unknown action "${name}"`);
    const result = fn.call(this, params || {});
    // Edits to the show (not transport) mark it as unsaved in the show library.
    if (SHOW_EDITS.has(name) && this.state.show) this.state.show.dirty = true;
    this.emit('change', { persist: true, action: name });
    return result;
  }

  // ---- timer internals ---------------------------------------------------

  newCue(patch = {}) {
    const s = this.state.settings;
    return sanitizeCue({
      id: randomUUID(),
      title: '',
      speaker: '',
      notes: '',
      mode: 'countdown',
      duration: s.defaultDuration,
      target: '',
      start: '',
      warning: s.defaultWarning,
      critical: s.defaultCritical,
      autoAdvance: false,
      ...patch,
    });
  }

  loadCue(cue, { autostart = false } = {}) {
    if (cue && !isCue(cue)) throw new Error('Group headings and notes cannot be loaded');
    this.closeLogEntry();
    const now = Date.now();
    this.state.currentId = cue ? cue.id : null;
    if (!cue) {
      this.state.timer = emptyTimer();
      return;
    }
    const t = {
      ...emptyTimer(),
      cueId: cue.id,
      mode: cue.mode,
      duration: cue.duration,
      warning: cue.warning,
      critical: cue.critical,
      loadedAt: now,
    };
    if (cue.mode === 'clock') {
      t.targetAt = nextClockTime(cue.target, now) ?? now;
      t.duration = Math.max(0, t.targetAt - now);
      t.running = true; // wall-clock countdowns always run
      t.startedAt = now;
    }
    this.state.timer = t;
    if (autostart) this.startTimer();
  }

  startTimer() {
    const t = this.state.timer;
    if (!t.cueId) {
      // Nothing loaded yet: load the first cue so "Start" on a fresh show just works.
      const first = this.cues()[0];
      if (!first) return;
      this.loadCue(first);
    }
    const tt = this.state.timer;
    if (tt.running && tt.mode !== 'clock') return;
    tt.running = true;
    if (tt.mode !== 'clock') tt.startedAt = Date.now();
    this.openLogEntry();
  }

  pauseTimer() {
    const t = this.state.timer;
    if (!t.running || t.mode === 'clock') return;
    t.elapsedBefore += Date.now() - t.startedAt;
    t.startedAt = null;
    t.running = false;
  }

  step(delta, { autostart = false } = {}) {
    const list = this.cues(); // group headings and notes are skipped
    if (!list.length) return;
    const i = this.currentCueIndex();
    const next = i === -1 ? (delta > 0 ? 0 : list.length - 1) : i + delta;
    if (next < 0 || next >= list.length) return;
    this.loadCue(list[next], { autostart });
  }

  /** Called 5x per second: scheduled starts and auto-advance. */
  tick() {
    this.checkScheduledStarts();
    const cue = this.currentCue();
    const t = this.state.timer;
    if (!cue || !cue.autoAdvance || !t.running || this._advancing) return;
    const c = this.computed();
    if (c.mode !== 'countup' && c.remaining <= 0) {
      this._advancing = true;
      try {
        const i = this.currentCueIndex();
        if (i < this.cues().length - 1) this.dispatch('next', { autostart: true });
      } finally {
        this._advancing = false;
      }
    }
  }

  /**
   * Cues with a start time load and start themselves when that time of day arrives.
   * Only fires within 10 s of the start time, so opening the app later never triggers old cues.
   * The countdown is anchored to the exact start time, so it ends on schedule even if it fires late.
   */
  checkScheduledStarts() {
    if (!this.state.settings.autoStartScheduled) return;
    const now = Date.now();
    for (const cue of this.cues()) {
      if (!cue.start) continue;
      const at = todayAt(cue.start, now);
      if (at == null || now < at || now - at > 10000 || this._fired.get(cue.id) === at) continue;
      this._fired.set(cue.id, at);
      const t = this.state.timer;
      if (this.state.currentId === cue.id && t.running) continue; // already started by hand
      this.loadCue(cue);
      const tt = this.state.timer;
      if (tt.mode !== 'clock') {
        tt.running = true;
        tt.startedAt = at;
      }
      this.openLogEntry();
      this.emit('change', { persist: true, action: 'scheduledStart' });
    }
  }

  // ---- show report -------------------------------------------------------

  openLogEntry() {
    const cue = this.currentCue();
    const last = this.state.log[this.state.log.length - 1];
    if (!cue || (last && last.cueId === cue.id && !last.endedAt)) return;
    // startedAt uses the timer's own start, so a scheduled start that fired a moment late still logs the exact time.
    this.state.log.push({ cueId: cue.id, title: cue.title, speaker: cue.speaker, planned: cue.duration, startedAt: this.state.timer.startedAt || Date.now(), endedAt: null, actual: null });
    if (this.state.log.length > 500) this.state.log.shift();
  }

  closeLogEntry() {
    const last = this.state.log[this.state.log.length - 1];
    if (!last || last.endedAt || last.cueId !== this.state.currentId) return;
    last.endedAt = Date.now();
    last.actual = Math.round(this.computed().elapsed);
  }
}

function normalizeClock(v) {
  const secs = parseClockTime(v);
  return secs == null ? '' : formatTimeOfDay(secs);
}

/** Rundown items are timers ("cue"), group headings ("group") or operator notes ("note"). */
export const KINDS = ['cue', 'group', 'note'];
export const isCue = (c) => !c.kind || c.kind === 'cue';

function sanitizeCue(c) {
  return {
    id: String(c.id),
    kind: KINDS.includes(c.kind) ? c.kind : 'cue',
    flashOvertime: !!c.flashOvertime, // pulse the time on screens while this cue is in overtime
    collapsed: !!c.collapsed, // groups only
    title: String(c.title ?? '').slice(0, 200),
    speaker: String(c.speaker ?? '').slice(0, 200),
    notes: String(c.notes ?? '').slice(0, 2000),
    mode: MODES.includes(c.mode) ? c.mode : 'countdown',
    duration: Math.max(0, Number(c.duration) || 0),
    target: String(c.target ?? ''),
    start: normalizeClock(c.start), // optional scheduled start "HH:MM[:SS]"
    warning: Math.max(0, Number(c.warning) || 0),
    critical: Math.max(0, Number(c.critical) || 0),
    autoAdvance: !!c.autoAdvance,
  };
}

/** All actions. `this` is the Engine. Params come from WebSocket, HTTP query/body, hotkeys or Companion. */
const ACTIONS = {
  // ---- transport ----
  start() { this.startTimer(); },
  pause() { this.pauseTimer(); },
  toggle() { this.state.timer.running && this.state.timer.mode !== 'clock' ? this.pauseTimer() : this.startTimer(); },
  /** Reset = "that didn't count": back to the original duration, and this run is not recorded. */
  reset() {
    const cue = this.currentCue();
    if (!cue) return;
    const log = this.state.log;
    const last = log[log.length - 1];
    if (last && last.cueId === cue.id && !last.endedAt) log.pop();
    this.loadCue(cue);
  },
  /** Stop = "it's finished": records the real start/end (markers, show report), then back to the original duration, not running. */
  stop() {
    const cue = this.currentCue();
    if (cue) this.loadCue(cue); // loadCue closes the running log entry first
  },
  next(p) { this.step(1, { autostart: truthy(p.autostart) }); },
  previous(p) { this.step(-1, { autostart: truthy(p.autostart) }); },
  startNext() { this.step(1, { autostart: true }); },
  load(p) {
    let cue = null;
    if (p.id) cue = this.state.rundown.find((c) => c.id === p.id);
    else if (p.index != null) cue = this.cues()[Number(p.index) - 1]; // 1-based cue number (headings/notes not counted)
    if (!cue) throw new Error('Cue not found');
    this.loadCue(cue, { autostart: truthy(p.autostart) });
  },
  addTime(p) {
    const ms = msFrom(p, 60000);
    if (!Number.isFinite(ms)) throw new Error('Invalid time');
    const t = this.state.timer;
    if (!t.cueId) return;
    if (t.mode === 'clock') t.targetAt += ms;
    t.duration = Math.max(0, t.duration + ms);
  },
  setRemaining(p) {
    const ms = msFrom(p);
    if (!Number.isFinite(ms)) throw new Error('Invalid time');
    const t = this.state.timer;
    if (!t.cueId) return;
    const c = this.computed();
    if (t.mode === 'clock') {
      t.targetAt = Date.now() + ms;
      t.duration = Math.max(0, c.elapsed) + ms;
    } else {
      t.duration = Math.max(0, c.elapsed + ms);
    }
  },

  // ---- messages & screen effects ----
  setMessage(p) {
    const m = this.state.message;
    if (p.text != null) m.text = String(p.text).slice(0, 500);
    if (p.color != null && MESSAGE_COLORS.includes(p.color)) m.color = p.color;
    if (p.flash != null) m.flash = truthy(p.flash);
    if (p.visible != null) m.visible = truthy(p.visible) && !!m.text;
  },
  showMessage(p) { ACTIONS.setMessage.call(this, { ...p, visible: true }); },
  hideMessage() { this.state.message.visible = false; },
  toggleMessage() { const m = this.state.message; m.visible = !m.visible && !!m.text; },
  showPreset(p) {
    const text = this.state.messagePresets[Number(p.index) - 1];
    if (text == null) throw new Error('Preset not found');
    ACTIONS.setMessage.call(this, { ...p, text, visible: true });
  },
  setPresets(p) {
    if (!Array.isArray(p.presets)) throw new Error('presets must be an array');
    this.state.messagePresets = p.presets.map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 50);
  },
  blackout(p) { this.state.blackout = p.value == null ? !this.state.blackout : truthy(p.value); },
  flash(p) {
    const seconds = Math.min(10, Math.max(0.5, Number(p.seconds) || 3));
    this.state.flashUntil = Date.now() + seconds * 1000;
  },

  // ---- broadcast overlay ----
  overlayShow() { this.state.overlay.onAir = true; },
  overlayHide() { this.state.overlay.onAir = false; },
  overlayToggle() { this.state.overlay.onAir = !this.state.overlay.onAir; },
  overlayUpdate(p) {
    const o = this.state.overlay;
    const patch = p.patch || p;
    if (patch.layout != null) {
      if (!OVERLAY_LAYOUTS.includes(patch.layout)) throw new Error('Unknown layout');
      o.layout = patch.layout;
    }
    for (const k of ['label', 'subLabel', 'zeroText']) if (patch[k] != null) o[k] = String(patch[k]).slice(0, 200);
    if (patch.atZero != null && ['hold', 'text', 'overtime'].includes(patch.atZero)) o.atZero = patch.atZero;
    if (patch.showProgress != null) {
      o.showProgress = truthy(patch.showProgress);
      if (!o.showProgress) o.progressStyle = 'none';
      else if (o.progressStyle === 'none') o.progressStyle = 'bar';
    }
    if (patch.progressStyle != null && ['bar', 'ring', 'none'].includes(patch.progressStyle)) {
      o.progressStyle = patch.progressStyle;
      o.showProgress = patch.progressStyle !== 'none';
    }
    if (patch.digitAnimation != null && ['slide', 'fade', 'none'].includes(patch.digitAnimation)) o.digitAnimation = patch.digitAnimation;
    if (patch.highlight != null && ['none', 'hours', 'minutes', 'seconds'].includes(patch.highlight)) o.highlight = patch.highlight;
    if (patch.leadingZero != null) o.leadingZero = truthy(patch.leadingZero);
    if (patch.hideZeroMinutes != null) o.hideZeroMinutes = truthy(patch.hideZeroMinutes);
    if (patch.onAir != null) o.onAir = truthy(patch.onAir);
  },
  updateTheme(p) {
    const patch = p.patch || {};
    const def = defaultState().theme;
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in def)) continue;
      this.state.theme[k] = typeof def[k] === 'number' ? Number(v) : typeof def[k] === 'boolean' ? truthy(v) : String(v);
    }
  },

  // ---- rundown editing ----
  addCue(p) {
    const cue = this.newCue(p.cue || {});
    const list = this.state.rundown;
    const after = p.afterId ? list.findIndex((c) => c.id === p.afterId) : -1;
    if (after >= 0) list.splice(after + 1, 0, cue);
    else list.push(cue);
    if (!this.state.currentId && isCue(cue)) this.loadCue(cue);
    return cue;
  },
  updateCue(p) {
    const list = this.state.rundown;
    const i = list.findIndex((c) => c.id === p.id);
    if (i < 0) throw new Error('Cue not found');
    const before = list[i];
    const cue = sanitizeCue({ ...before, ...(p.patch || {}), id: before.id });
    list[i] = cue;
    if (cue.id !== this.state.currentId) return;
    // Keep the live timer in step with edits to the current cue.
    const t = this.state.timer;
    t.warning = cue.warning;
    t.critical = cue.critical;
    const c = this.computed();
    if (cue.mode !== before.mode || (!c.started && cue.mode !== 'clock')) this.loadCue(cue);
    else if (cue.mode === 'clock' && cue.target !== before.target) this.loadCue(cue);
    else if (cue.duration !== before.duration && cue.mode !== 'clock') t.duration = cue.duration;
  },
  deleteCue(p) {
    const list = this.state.rundown;
    const i = list.findIndex((c) => c.id === p.id);
    if (i < 0) return;
    list.splice(i, 1);
    if (this.state.currentId === p.id) {
      this.state.timer = emptyTimer(); // the deleted cue's log entry stays as it was
      this.state.currentId = null;
      this.loadCue(list.slice(i).find(isCue) || this.cues().pop() || null);
    }
  },
  moveCue(p) {
    const list = this.state.rundown;
    const from = list.findIndex((c) => c.id === p.id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(list.length - 1, Number(p.toIndex)));
    const [cue] = list.splice(from, 1);
    list.splice(to, 0, cue);
  },
  duplicateCue(p) {
    const list = this.state.rundown;
    const i = list.findIndex((c) => c.id === p.id);
    if (i < 0) return;
    list.splice(i + 1, 0, { ...list[i], id: randomUUID(), title: list[i].title });
  },
  replaceRundown(p) {
    if (!Array.isArray(p.rundown)) throw new Error('rundown must be an array');
    this.state.rundown = p.rundown.slice(0, 500).map((c) => this.newCue({ ...c, id: c.id || randomUUID() }));
    this.loadCue(this.cues()[0] || null);
  },
  clearRundown() {
    this.state.rundown = [];
    this.loadCue(null);
  },
  /** Collapse/expand a group heading (shared, so every controller shows the same). */
  toggleGroup(p) {
    const g = this.state.rundown.find((c) => c.id === p.id && c.kind === 'group');
    if (g) g.collapsed = p.value == null ? !g.collapsed : truthy(p.value);
  },

  // ---- settings & data ----
  updateSettings(p) {
    this.state.settings = mergeDefaults(this.state.settings, p.patch || {});
  },
  importShow(p) {
    const show = p.show || {};
    for (const k of ['rundown', 'messagePresets', 'overlay', 'theme', 'settings']) {
      if (show[k] != null) this.state[k] = mergeDefaults(defaultState()[k], show[k]);
    }
    this.state.rundown = (this.state.rundown || []).map((c) => this.newCue(c));
    this.loadCue(this.cues()[0] || null);
    this.state.show = { name: String(p.name || ''), dirty: false };
  },
  /** Start an empty show (theme, messages and settings stay). */
  newShow() {
    this.state.rundown = [];
    this.loadCue(null);
    this.state.log = [];
    this.state.show = { name: '', dirty: false };
  },
  resetLog() { this.state.log = []; },

  // ---- desktop app commands (floating window, outputs) ----
  // Handled by the Electron shell; in browser-only mode they are a no-op.
  app(p) {
    if (this.host.type !== 'electron') throw new Error('This needs the desktop app');
    this.emit('host-command', p);
  },
};

export const ACTION_NAMES = Object.keys(ACTIONS);

const SHOW_EDITS = new Set(['addCue', 'updateCue', 'deleteCue', 'moveCue', 'duplicateCue', 'replaceRundown', 'clearRundown', 'setPresets', 'overlayUpdate', 'updateTheme']);
