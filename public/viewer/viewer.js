import { Connection, loadLanguage, applyI18n, t, fitText, fitWrappedText, flag, autoHideCursor, keepAwake, formatClock } from '/shared/client.js';
import { timerText } from '/shared/timecalc.js';

const $ = (id) => document.getElementById(id);
const body = document.body;
const els = {
  timer: $('timer'), timerFit: $('timerFit'), date: $('date'), title: $('title'), clock: $('clock'), next: $('next'),
  message: $('message'), messageText: $('messageText'), progressFill: $('progressFill'), ctlToggle: $('ctlToggle'),
};

const compact = flag('compact', false);
const floating = flag('floating', false);
body.classList.toggle('compact', compact);
body.classList.toggle('floating', floating);
body.classList.toggle('mirror', flag('mirror', false));
const respectBlackout = flag('blackout', true);

const conn = new Connection({ role: flag('preview', false) ? 'preview' : floating ? 'floating' : 'viewer' });
if (!floating) autoHideCursor();
keepAwake();

// ---- control bar (floating window, or any view opened with ?controls=1) ----
// Window buttons talk to the desktop app directly (preload bridge), so they also work
// when this window is connected to a timer running on another computer.
const desktop = window.lupixisDesktop;
body.classList.toggle('has-window-api', !!desktop);
$('ctlMin').onclick = () => desktop?.minimize();
$('ctlClose').onclick = () => (desktop ? desktop.close() : conn.action('app', { command: 'closeFloating' }).catch(() => window.close()));
// Move the floating window by dragging anywhere that isn't a button.
if (desktop && floating) {
  document.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('button')) desktop.dragStart();
  });
  const end = () => desktop.dragEnd();
  addEventListener('mouseup', end);
  addEventListener('blur', end);
}
document.querySelectorAll('#controls [data-action]').forEach((b) => {
  b.onclick = () => conn.action(b.dataset.action, b.dataset.seconds ? { seconds: Number(b.dataset.seconds) } : {}).catch(() => {});
});

let lastTimerText = '';
let lastLayoutKey = '';
let lastIdleKey = null;
let lang = null;
let opts = {};

conn.on('status', (ok) => body.classList.toggle('offline', !ok));

conn.on('state', async (s) => {
  if (s.settings.language !== lang) {
    lang = s.settings.language;
    await loadLanguage(lang);
    applyI18n();
  }
  // The floating window has its own display settings; URL flags override either.
  opts = floating ? { ...s.settings.viewer, showClock: false, showNext: false, ...s.settings.floating } : s.settings.viewer;
  body.classList.toggle('no-clock', !flag('clock', opts.showClock));
  body.classList.toggle('no-title', !flag('title', opts.showTitle));
  body.classList.toggle('no-next', !flag('next', opts.showNext));
  body.classList.toggle('no-progress', !flag('progress', opts.showProgress));
  body.classList.toggle('show-title-compact', compact && flag('title', opts.showTitle));
  body.classList.toggle('blackout', respectBlackout && s.blackout && !floating);

  const controls = flag('controls', floating ? opts.controls !== 'off' : false);
  body.classList.toggle('controls', controls);
  body.classList.toggle('controls-always', controls && floating && opts.controls === 'always');

  const i = s.rundown.findIndex((c) => c.id === s.currentId);
  const cue = s.rundown[i];
  const next = s.rundown[i + 1];
  els.title.textContent = cue ? [cue.title, cue.speaker].filter(Boolean).join(' · ') : '';
  els.next.textContent = next ? `${t('viewer.next')}: ${next.title || t('viewer.untitled')}` : '';

  const m = s.message;
  const showMsg = m.visible && !!m.text && (!floating || opts.showMessage !== false);
  body.classList.toggle('has-message', showMsg);
  els.message.className = `${m.color}${m.flash ? ' flash' : ''}`;
  if (els.messageText.textContent !== m.text) els.messageText.textContent = m.text;
  const key = [showMsg, m.text, body.className].join('|');
  if (key !== lastLayoutKey) {
    lastLayoutKey = key;
    requestAnimationFrame(refit);
  }
});

function refit() {
  fitText(els.timer, els.timerFit, { fill: compact ? 0.98 : 0.95 });
  if (body.classList.contains('has-message')) fitWrappedText(els.messageText, els.message, { max: compact ? 120 : 400 });
}
new ResizeObserver(refit).observe(document.documentElement);

const dateFmt = () => {
  try {
    return new Date().toLocaleDateString(lang || 'en', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return new Date().toDateString();
  }
};

// Draw loop: compute locally from the synced clock, touch the DOM only when something changes.
function frame() {
  const s = conn.state;
  if (s) {
    const c = conn.timer();
    const now = conn.now();
    // "No timer running": nothing loaded, or loaded but not started yet. A paused timer keeps showing its time.
    const idleMode = opts.idleDisplay || 'timer';
    const idle = idleMode !== 'timer' && (!c.loaded || (!c.running && !c.started));
    const idleKey = idle ? idleMode : '';
    if (idleKey !== lastIdleKey) {
      lastIdleKey = idleKey;
      body.classList.toggle('idle-clock', idle);
      body.classList.toggle('show-date', idle && idleMode === 'clockDate');
      requestAnimationFrame(refit);
    }
    const text = idle ? formatClock(now, s.settings.viewer.clock24) : timerText(c);
    if (text !== lastTimerText) {
      const lengthChanged = text.length !== lastTimerText.length;
      els.timer.textContent = text;
      lastTimerText = text;
      if (lengthChanged) refit();
    }
    if (idle && idleMode === 'clockDate') {
      const d = dateFmt();
      if (els.date.textContent !== d) {
        els.date.textContent = d;
        refit();
      }
    }
    setPhase(idle ? 'normal' : c.phase);
    body.classList.toggle('paused', c.loaded && !c.running && c.started);
    body.classList.toggle('running', c.running);
    els.progressFill.style.width = `${(c.progress * 100).toFixed(2)}%`;
    els.clock.textContent = formatClock(now, s.settings.viewer.clock24);
    body.classList.toggle('flashing', s.flashUntil > now);
    renderClips();
  }
  requestAnimationFrame(frame);
}

// ---- clip timer pop-ups ----
const clipEls = new Map();
function renderClips() {
  const show = flag('clips', opts.showClips !== false);
  const clips = show ? conn.clipsNow().slice(0, 3) : [];
  const box = $('clips');
  const keys = new Set(clips.map((c) => c.key));
  for (const [k, el] of clipEls) if (!keys.has(k)) el.remove(), clipEls.delete(k);
  for (const c of clips) {
    let el = clipEls.get(c.key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'clip';
      el.innerHTML = '<span class="clip-icon"></span><span class="clip-name"></span><span class="clip-time"></span><span class="clip-bar"><span></span></span>';
      box.append(el);
      clipEls.set(c.key, el);
    }
    const s = Math.ceil(c.remainingNow);
    const text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    const name = el.querySelector('.clip-name');
    if (name.textContent !== c.name) name.textContent = c.name;
    const time = el.querySelector('.clip-time');
    if (time.textContent !== text) time.textContent = text;
    el.classList.toggle('paused', !!c.paused);
    el.classList.toggle('ending', s <= 10);
    el.querySelector('.clip-bar span').style.width = `${(c.progress * 100).toFixed(1)}%`;
  }
  body.classList.toggle('has-clips', clips.length > 0);
}
let phase = '';
function setPhase(p) {
  if (p === phase) return;
  body.classList.remove(`phase-${phase}`);
  body.classList.add(`phase-${p}`);
  phase = p;
}
requestAnimationFrame(frame);
