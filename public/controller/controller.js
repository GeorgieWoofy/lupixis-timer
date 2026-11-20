// Controller UI. Every button just sends an action to the server; the server broadcasts the new state
// and `render()` redraws from it. That way several controllers (laptop + phone) always agree.
import { Connection, loadLanguage, applyI18n, t, h, setVal, formatClock } from '/shared/client.js';
import { timerText, parseDuration, formatDurationInput, parseClockTime, formatTimeOfDay, formatDelta, computeSchedule, projectSchedule, nearDay, todayAt, formatSeconds, MODES } from '/shared/timecalc.js';

const $ = (id) => document.getElementById(id);
const conn = new Connection({ role: 'controller' });
let S = null; // latest server state
let lang = null;
let langReady = false; // translations loaded (don't draw text before that)
let info = { port: location.port, addresses: [] };

const HOTKEYS = ['toggle', 'next', 'previous', 'addMinute', 'subtractMinute', 'blackout', 'toggleMessage', 'toggleFloating'];

// ---------------------------------------------------------------------------
// helpers

function act(name, params) {
  return conn.action(name, params).catch((err) => {
    toast(err.message, 'error');
    throw err;
  });
}
const quiet = (p) => p.catch(() => {});

function toast(text, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, text);
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 5000 : 2200);
}

function invalid(input) {
  input.classList.remove('invalid');
  void input.offsetWidth;
  input.classList.add('invalid');
  setTimeout(() => input.classList.remove('invalid'), 1200);
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function throttle(fn, ms) {
  let last = 0, timer = null, lastArgs;
  return (...args) => {
    lastArgs = args;
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      last = Date.now();
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...lastArgs);
      }, wait);
    }
  };
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = $('fileInput');
    input.value = '';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

async function upload(file) {
  const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return json.url;
}

const svg = (d) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.innerHTML = `<path d="${d}"/>`;
  return el;
};
const ICON_PLAY = 'M7 4v16l13-8z';
// Arrow pointing left into a bar: "bring this cue into the timer" (load without starting).
const ICON_LOAD = 'M4 4h2.5v16H4zM20 10.75H12.3l3.6-3.6-1.75-1.75L7.55 12l6.6 6.6 1.75-1.75-3.6-3.6H20z';
const ICON_DOTS = 'M5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z';

// Mouse clicks shouldn't leave focus on buttons, so Space always means Start/Pause.
document.addEventListener('click', (e) => {
  const b = e.target.closest('button, summary');
  if (b && e.detail > 0) b.blur();
});

// ---------------------------------------------------------------------------
// transport

$('btnToggle').onclick = () => quiet(act('toggle'));
$('btnPrev').onclick = () => quiet(act('previous'));
$('btnNext').onclick = () => quiet(act('next'));
$('btnReset').onclick = () => quiet(act('reset'));
$('btnStop').onclick = () => quiet(act('stop'));
document.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => quiet(act('addTime', { seconds: Number(b.dataset.add) }))));
$('setTimeForm').onsubmit = (e) => {
  e.preventDefault();
  const input = $('setTimeInput');
  const ms = parseDuration(input.value);
  if (ms == null) return invalid(input);
  quiet(act('setRemaining', { ms }));
  input.value = '';
  input.blur();
};
$('btnBlackout').onclick = () => quiet(act('blackout'));
$('btnFlash').onclick = () => quiet(act('flash', { seconds: 3 }));

// Keyboard shortcuts inside the controller (the desktop app also has global hotkeys).
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  const map = {
    ' ': ['toggle'],
    ArrowRight: ['next'],
    ArrowLeft: ['previous'],
    '+': ['addTime', { seconds: 60 }],
    '=': ['addTime', { seconds: 60 }],
    '-': ['addTime', { seconds: -60 }],
    b: ['blackout'],
    m: ['toggleMessage'],
    f: ['flash', { seconds: 3 }],
  };
  const a = map[e.key];
  if (!a) return;
  e.preventDefault();
  quiet(act(...a));
});

// ---------------------------------------------------------------------------
// rundown

const rows = new Map(); // cue id -> { el, f: fields, cue }
let dragId = null;

$('btnAddCue').onclick = async () => {
  const cue = await act('addCue', {});
  requestAnimationFrame(() => rows.get(cue?.id)?.f.title.focus());
};

const h24 = () => S?.settings.clock24 !== false;
/** Stored "HH:MM" (24 h) -> shown in the user's clock format. */
const showClock = (str) => (str ? formatTimeOfDay(parseClockTime(str), h24()) : '');
const secondsOfDay = (ts) => {
  const d = new Date(ts);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
};
/** Write an early/late marker: green "−0:30" when early, red "+0:46" when late, nothing within 5 s. */
function setDelta(el, secs) {
  const show = secs != null && Math.abs(secs) >= 5;
  const text = show ? formatDelta(secs) : '';
  if (el.textContent !== text) el.textContent = text;
  el.className = `delta${show ? (secs > 0 ? ' late' : ' early') : ''}`;
}

/** Shared by every row type: drag to reorder by grabbing the handle. */
function attachDrag(r, id, handle) {
  handle.addEventListener('mousedown', () => (r.el.draggable = true));
  r.el.addEventListener('dragstart', (e) => {
    dragId = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    r.el.classList.add('dragging');
  });
  r.el.addEventListener('dragend', () => {
    r.el.draggable = false;
    r.el.classList.remove('dragging');
    document.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  });
  r.el.addEventListener('dragover', (e) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    const rect = r.el.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    r.el.classList.toggle('drop-after', after);
    r.el.classList.toggle('drop-before', !after);
  });
  r.el.addEventListener('dragleave', () => r.el.classList.remove('drop-before', 'drop-after'));
  r.el.addEventListener('drop', (e) => {
    e.preventDefault();
    const after = r.el.classList.contains('drop-after');
    r.el.classList.remove('drop-before', 'drop-after');
    const from = S.rundown.findIndex((c) => c.id === dragId);
    let to = S.rundown.findIndex((c) => c.id === id) + (after ? 1 : 0);
    if (from < to) to--;
    if (from !== to) quiet(act('moveCue', { id: dragId, toIndex: to }));
    dragId = null;
  });
  r.el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === 'Escape') && e.target.tagName === 'INPUT') e.target.blur();
  });
}

const deleteItem = (r, id) => confirm(t('rundown.confirmDelete', { title: r.cue?.title || '' })) && quiet(act('deleteCue', { id }));
const insertButtons = (id) => [
  h('button', { class: 'btn small', onclick: () => quiet(act('addCue', { afterId: id })) }, t('rundown.insertBelow')),
  h('button', { class: 'btn small', onclick: () => quiet(act('addCue', { afterId: id, cue: { kind: 'group', title: t('rundown.newGroup') } })) }, t('rundown.groupBelow')),
  h('button', { class: 'btn small', onclick: () => quiet(act('addCue', { afterId: id, cue: { kind: 'note', title: '' } })) }, t('rundown.noteBelow')),
];

// ---- group heading row ----
function createGroupRow(id) {
  const f = {};
  const r = { f, cue: null, kind: 'group' };
  r.el = h('div', { class: 'cue group-row', dataset: { id } },
    (f.toggle = h('button', { class: 'group-toggle', title: t('rundown.collapse'), onclick: () => quiet(act('toggleGroup', { id })) }, '▾')),
    (f.title = h('input', { class: 'group-title', placeholder: t('rundown.groupPlaceholder') })),
    (f.summary = h('span', { class: 'group-summary muted small' })),
    h('span', { class: 'group-handle', title: t('rundown.dragHint') }, '⠿'),
    (f.del = h('button', { class: 'btn icon-sm', title: t('common.delete'), onclick: () => deleteItem(r, id) }, '×')),
  );
  f.title.onchange = () => quiet(act('updateCue', { id, patch: { title: f.title.value } }));
  attachDrag(r, id, r.el.querySelector('.group-handle'));
  return r;
}

// ---- operator note row (e.g. "Break 20:00") ----
function createNoteRow(id) {
  const f = {};
  const r = { f, cue: null, kind: 'note' };
  r.el = h('div', { class: 'cue note-row', dataset: { id } },
    h('span', { class: 'note-icon', title: t('rundown.dragHint') }, '✎'),
    (f.title = h('input', { class: 'note-text', placeholder: t('rundown.notePlaceholder') })),
    (f.del = h('button', { class: 'btn icon-sm', title: t('common.delete'), onclick: () => deleteItem(r, id) }, '×')),
  );
  f.title.onchange = () => quiet(act('updateCue', { id, patch: { title: f.title.value } }));
  attachDrag(r, id, r.el.querySelector('.note-icon'));
  return r;
}

// ---- timer row ----
function createRow(id) {
  const f = {};
  const r = { f, cue: null, kind: 'cue' };
  const update = (patch) => quiet(act('updateCue', { id, patch }));

  r.el = h('div', { class: 'cue', dataset: { id } },
    h('div', { class: 'cue-grid' },
      (f.num = h('span', { class: 'cue-num', title: t('rundown.dragHint') })),
      h('div', { class: 'c-title' },
        (f.title = h('input', { placeholder: t('rundown.titlePlaceholder') })),
        (f.speaker = h('input', { class: 'speaker', placeholder: t('rundown.speakerPlaceholder') })),
      ),
      h('div', { class: 'c-mode' }, (f.mode = h('select', {}, MODES.map((m) => h('option', { value: m }, t(`mode.${m}`)))))),
      h('div', { class: 'c-start' }, (f.start = h('input', { title: t('rundown.startHint') })), (f.startDelta = h('span', { class: 'delta', title: t('rundown.startDeltaHint') }))),
      h('div', { class: 'c-dur' }, (f.time = h('input'))),
      h('div', { class: 'c-end' }, (f.end = h('input', { title: t('rundown.endHint') })), (f.endDelta = h('span', { class: 'delta', title: t('rundown.endDeltaHint') }))),
      h('div', { class: 'c-auto' }, (f.auto = h('input', { type: 'checkbox', title: t('rundown.autoHint') }))),
      h('div', { class: 'c-actions' },
        (f.load = h('button', { class: 'btn', title: t('rundown.load') }, svg(ICON_LOAD))),
        (f.go = h('button', { class: 'btn go-now', title: t('rundown.startNow') }, svg(ICON_PLAY))),
        (f.moreBtn = h('button', { class: 'btn', title: t('rundown.details') }, svg(ICON_DOTS))),
      ),
    ),
    (f.more = h('div', { class: 'cue-more', hidden: true },
      // Type lives here when the Type column is hidden (touch mode / narrow window).
      h('label', { class: 'field type-alt' }, h('span', {}, t('rundown.colType')), (f.mode2 = h('select', {}, MODES.map((m) => h('option', { value: m }, t(`mode.${m}`)))))),
      h('label', { class: 'field' }, h('span', {}, t('rundown.warning')), (f.warning = h('input'))),
      h('label', { class: 'field' }, h('span', {}, t('rundown.critical')), (f.critical = h('input'))),
      h('label', { class: 'check wide-check' }, (f.flash = h('input', { type: 'checkbox' })), h('span', {}, t('rundown.flashOvertime'))),
      h('label', { class: 'check wide-check auto-alt' }, (f.auto2 = h('input', { type: 'checkbox' })), h('span', {}, t('rundown.colAuto'))),
      h('label', { class: 'field notes' }, h('span', {}, t('rundown.notes')), (f.notes = h('textarea', { rows: 2 }))),
      h('div', { class: 'row wrap' },
        ...insertButtons(id),
        h('button', { class: 'btn small', onclick: () => quiet(act('duplicateCue', { id })) }, t('rundown.duplicate')),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn small danger', onclick: () => deleteItem(r, id) }, t('common.delete')),
      ),
    )),
    (f.progress = h('div', { class: 'cue-progress' })),
  );

  f.title.onchange = () => update({ title: f.title.value });
  f.speaker.onchange = () => update({ speaker: f.speaker.value });
  f.notes.onchange = () => update({ notes: f.notes.value });
  f.auto.onchange = () => update({ autoAdvance: f.auto.checked });
  f.auto2.onchange = () => update({ autoAdvance: f.auto2.checked });
  f.flash.onchange = () => update({ flashOvertime: f.flash.checked });
  f.mode2.onchange = () => {
    f.mode.value = f.mode2.value;
    f.mode.onchange();
  };
  f.mode.onchange = () => {
    const patch = { mode: f.mode.value };
    if (patch.mode === 'clock' && !r.cue.target) {
      const d = new Date(Date.now() + 3600000);
      patch.target = `${String(d.getHours()).padStart(2, '0')}:00`;
    }
    update(patch);
  };
  // Duration: editing it moves the end time.
  f.time.onchange = () => {
    const ms = parseDuration(f.time.value);
    if (ms == null) return invalid(f.time), (f.time.value = formatDurationInput(r.cue.duration));
    update({ duration: ms });
  };
  // Start: empty = follows the previous cue (shown faintly); a time = starts itself at that time.
  f.start.onchange = () => {
    const v = f.start.value.trim();
    if (v && parseClockTime(v) == null) return invalid(f.start), (f.start.value = showClock(r.cue.start));
    update({ start: v });
  };
  // End: sets the duration from the start time (or the target time for "until time" cues).
  f.end.onchange = () => {
    const v = f.end.value.trim();
    const endSecs = parseClockTime(v);
    if (endSecs == null) return invalid(f.end), (f.end.value = formatTimeOfDay(r.sched?.end, h24()));
    if (r.cue.mode === 'clock') return update({ target: formatTimeOfDay(endSecs) });
    const start = r.sched?.start;
    if (start == null) {
      toast(t('rundown.needStart'), 'error');
      return invalid(f.end), (f.end.value = '');
    }
    let secs = endSecs - (start % 86400);
    if (secs <= 0) secs += 86400;
    update({ duration: secs * 1000 });
  };
  for (const k of ['warning', 'critical']) {
    f[k].onchange = () => {
      const ms = parseDuration(f[k].value);
      if (ms == null) return invalid(f[k]), (f[k].value = formatDurationInput(r.cue[k]));
      update({ [k]: ms });
    };
  }
  f.load.onclick = () => quiet(act('load', { id }));
  f.go.onclick = () => quiet(act('load', { id, autostart: true }));
  f.num.ondblclick = () => quiet(act('load', { id }));
  f.moreBtn.onclick = () => (f.more.hidden = !f.more.hidden);
  attachDrag(r, id, f.num);
  return r;
}

const isCueItem = (c) => !c.kind || c.kind === 'cue';

function renderRundown(s) {
  const list = $('cueList');
  const sched = computeSchedule(s.rundown);
  const cueList = s.rundown.filter(isCueItem);
  const curCue = cueList.findIndex((c) => c.id === s.currentId);
  // Latest show-report entry per cue: when it really started / how long it really ran.
  const lastLog = new Map();
  for (const e of s.log || []) lastLog.set(e.cueId, e);

  let cueNo = 0;
  let collapsed = false;
  let group = null;
  const groupStats = new Map(); // group id -> { n, ms, start, end }

  s.rundown.forEach((item, i) => {
    let r = rows.get(item.id);
    const kind = item.kind || 'cue';
    if (r && r.kind !== kind) {
      r.el.remove();
      r = null;
    }
    if (!r) rows.set(item.id, (r = kind === 'group' ? createGroupRow(item.id) : kind === 'note' ? createNoteRow(item.id) : createRow(item.id)));
    r.cue = item;
    r.sched = sched[i];
    const f = r.f;

    if (kind === 'group') {
      group = item;
      collapsed = !!item.collapsed;
      groupStats.set(item.id, { n: 0, ms: 0, start: null, end: null });
      setVal(f.title, item.title);
      setText(f.toggle, item.collapsed ? '▸' : '▾');
      r.el.classList.toggle('collapsed', !!item.collapsed);
      r.el.classList.remove('in-collapsed');
      return;
    }
    r.el.classList.toggle('in-collapsed', collapsed);
    if (kind === 'note') {
      setVal(f.title, item.title);
      return;
    }

    // ---- timer row ----
    const cue = item;
    const sc = sched[i];
    const no = ++cueNo;
    if (group) {
      const g = groupStats.get(group.id);
      g.n++;
      if (cue.mode !== 'clock') g.ms += cue.duration;
      if (g.start == null && sc.start != null) g.start = sc.start;
      if (sc.end != null) g.end = sc.end;
    }
    setText(f.num, String(no));
    setVal(f.title, cue.title);
    setVal(f.speaker, cue.speaker);
    setVal(f.mode, cue.mode);
    setVal(f.mode2, cue.mode);
    // Start: own time in the field; otherwise the planned/expected start as a faint placeholder (see renderProjection).
    setVal(f.start, showClock(cue.start));
    f.start.parentElement.classList.toggle('scheduled', !!cue.start && s.settings.autoStartScheduled);
    // Duration: editable, except for "until time" cues where it follows from start -> target.
    const isClock = cue.mode === 'clock';
    f.time.disabled = isClock;
    setVal(f.time, isClock ? (sc.start != null && sc.end != null ? formatDurationInput((sc.end - sc.start) * 1000) : '—') : formatDurationInput(cue.duration));
    f.time.placeholder = 'M:SS';
    f.time.title = isClock ? t('rundown.clockDurationHint') : t('rundown.durationHint');
    // End values and the early/late markers are drawn by renderProjection().

    setVal(f.auto, cue.autoAdvance);
    setVal(f.auto2, cue.autoAdvance);
    setVal(f.flash, cue.flashOvertime);
    setVal(f.warning, formatDurationInput(cue.warning));
    setVal(f.critical, formatDurationInput(cue.critical));
    setVal(f.notes, cue.notes);

    const ci = no - 1;
    r.el.classList.toggle('current', ci === curCue);
    r.el.classList.toggle('done', curCue >= 0 && ci < curCue);
    if (ci !== curCue) f.progress.style.width = '0';
  });

  // Group summaries: "3 timers · 45:00 · 09:00–09:45"
  for (const [id, g] of groupStats) {
    const r = rows.get(id);
    const range = g.start != null && g.end != null ? ` · ${formatTimeOfDay(g.start, h24())}–${formatTimeOfDay(g.end, h24())}` : '';
    setText(r.f.summary, `${t('rundown.groupCount', { n: g.n })} · ${formatDurationInput(g.ms)}${range}`);
  }

  for (const [id, r] of rows) {
    if (!s.rundown.some((c) => c.id === id)) {
      r.el.remove();
      rows.delete(id);
    }
  }
  const want = s.rundown.map((c) => rows.get(c.id).el);
  const have = [...list.children];
  if (want.length !== have.length || want.some((el, i) => have[i] !== el)) want.forEach((el) => list.append(el));
  $('emptyRundown').hidden = s.rundown.length > 0;
  const total = cueList.filter((c) => c.mode !== 'clock').reduce((a, c) => a + c.duration, 0);
  renderProjection();
  setText($('rundownTotal'), cueList.length ? t(cueList.length === 1 ? 'rundown.totalOne' : 'rundown.total', { n: cueList.length, time: formatDurationInput(total) }) : '');
}

/** The end marker only appears once a cue has finished (no live counting while it runs). */
function renderLiveEnd() {}

/**
 * Start / End columns: planned times, expected times in orange when they've moved (late start, overrun,
 * rippling on to later cues), real times once a cue has finished, and the early/late markers.
 * Runs on every state change and twice a second (expected times move with the clock).
 */
let lastProjection = 0;
function renderProjection() {
  if (!S) return;
  lastProjection = Date.now();
  const sched = computeSchedule(S.rundown);
  const now = conn.now();
  const nowSod = secondsOfDay(now) + (now % 1000) / 1000;
  const proj = projectSchedule(S.rundown, sched, S.log, S.currentId, conn.timer(), nowSod, secondsOfDay);
  const lastLog = new Map();
  for (const e of S.log || []) lastLog.set(e.cueId, e);
  const T = (x) => formatTimeOfDay(Math.round(x), h24());
  const moved = (a, b) => a != null && b != null && Math.abs(a - b) >= 5;

  S.rundown.forEach((cue, i) => {
    const r = rows.get(cue.id);
    if (!r || r.kind !== 'cue') return;
    const f = r.f;
    const plan = sched[i];
    const p = proj[i];

    // ---- Start ----
    if (p?.startActual) {
      if (!cue.start) f.start.placeholder = plan.start != null ? T(plan.start) : T(p.start);
      f.start.classList.remove('projected');
      setDelta(f.startDelta, plan.start != null ? p.start - nearDay(plan.start, p.start) : null);
    } else {
      setDelta(f.startDelta, null);
      if (!cue.start) f.start.placeholder = p?.start != null ? T(p.start) : plan.start != null ? T(plan.start) : '--:--';
      f.start.classList.toggle('projected', !cue.start && moved(p?.start, plan.start));
    }

    // ---- End ----
    let text;
    let orange = false;
    let placeholder = '--:--';
    if (p?.endActual) {
      text = T(p.end);
      const planEnd = plan.end != null ? nearDay(plan.end, p.end) : null;
      orange = moved(p.end, planEnd);
      const log = lastLog.get(cue.id);
      // Compare with the planned end time; without a plan, compare how long it ran with its duration.
      const d = planEnd != null ? p.end - planEnd : log?.actual != null && cue.mode !== 'clock' ? (log.actual - cue.duration) / 1000 : null;
      setDelta(f.endDelta, d);
    } else {
      setDelta(f.endDelta, null);
      if (moved(p?.end, plan.end)) {
        text = T(p.end);
        orange = true;
      } else if (plan.end != null) {
        text = T(plan.end);
      } else {
        text = '';
        if (p?.end != null) placeholder = T(p.end);
      }
    }
    setVal(f.end, text);
    f.end.placeholder = placeholder;
    f.end.classList.toggle('projected', orange);
    f.end.title = orange && !p?.endActual ? t('rundown.projectedHint') : t('rundown.endHint');
  });
}

// ---- saved shows library ----
const api = (path, body) =>
  fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    .then((r) => r.json())
    .then((r) => (r.ok === false ? Promise.reject(new Error(r.error)) : r));

async function openShows() {
  closeMenu();
  $('saveAsName').value = S?.show?.name || '';
  $('btnOpenShowsFolder').hidden = !bridge;
  $('showsDialog').showModal();
  await refreshShowList();
}
async function refreshShowList() {
  const list = await api('/api/shows').catch(() => []);
  const cur = S?.show?.name;
  const fmt = (ms) => new Date(ms).toLocaleString(lang || 'en', { dateStyle: 'medium', timeStyle: 'short', hour12: !h24() });
  $('showList').replaceChildren(
    ...(list.length
      ? list.map((sh) =>
          h('div', { class: `show-item${sh.name === cur ? ' current' : ''}` },
            h('div', { class: 'show-meta' }, h('b', {}, sh.name), h('span', { class: 'muted small' }, `${t(sh.cues === 1 ? 'rundown.totalOneShort' : 'rundown.totalShort', { n: sh.cues })} · ${fmt(sh.modified)}`)),
            h('button', { class: 'btn small primary', onclick: () => loadShow(sh.name) }, t('shows.load')),
            h('button', { class: 'btn small', title: t('common.delete'), onclick: () => deleteShow(sh.name) }, '×'),
          ),
        )
      : [h('p', { class: 'hint' }, t('shows.none'))]),
  );
}
async function saveShow(name) {
  try {
    const r = await api('/api/shows/save', { name });
    toast(t('shows.saved', { name: r.name }));
    if ($('showsDialog').open) refreshShowList();
  } catch (e) {
    toast(e.message, 'error');
  }
}
async function loadShow(name) {
  if (S.show?.dirty && S.rundown.length && !confirm(t('shows.confirmDiscard'))) return;
  try {
    await api('/api/shows/load', { name });
    $('showsDialog').close();
    toast(t('shows.loaded', { name }));
  } catch (e) {
    toast(e.message, 'error');
  }
}
async function deleteShow(name) {
  if (!confirm(t('shows.confirmDelete', { name }))) return;
  await api('/api/shows/delete', { name }).catch((e) => toast(e.message, 'error'));
  refreshShowList();
}
$('btnShows').onclick = openShows;
$('showChip').onclick = openShows;
$('btnShowsClose').onclick = () => $('showsDialog').close();
$('saveAsForm').onsubmit = (e) => {
  e.preventDefault();
  const name = $('saveAsName').value.trim();
  if (!name) return invalid($('saveAsName'));
  saveShow(name);
};
$('btnSaveShow').onclick = () => {
  closeMenu();
  S?.show?.name ? saveShow(S.show.name) : openShows();
};
$('btnNewShow').onclick = async () => {
  if (S.show?.dirty && S.rundown.length && !confirm(t('shows.confirmDiscard'))) return;
  await act('newShow');
  $('showsDialog').close();
};
$('btnOpenShowsFolder').onclick = () => bridge?.command('openShowsFolder');
// Ctrl+S saves the current show (or asks for a name).
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    S?.show?.name ? saveShow(S.show.name) : openShows();
  }
});
function renderShowChip(s) {
  const sh = s.show || {};
  setText($('showName'), sh.name || t('shows.unsaved'));
  $('showChip').classList.toggle('unnamed', !sh.name);
  $('showDirty').hidden = !(sh.dirty && sh.name);
  $('showDirty').title = t('shows.dirty');
}

$('btnAddGroup').onclick = async () => {
  closeMenu();
  const g = await act('addCue', { cue: { kind: 'group', title: t('rundown.newGroup') } });
  requestAnimationFrame(() => rows.get(g?.id)?.f.title.select());
};
$('btnAddNote').onclick = async () => {
  closeMenu();
  const n = await act('addCue', { cue: { kind: 'note', title: '' } });
  requestAnimationFrame(() => rows.get(n?.id)?.f.title.focus());
};

// ---- rundown menu ----
const closeMenu = () => document.querySelectorAll('details.menu').forEach((d) => (d.open = false));
document.addEventListener('click', (e) => {
  if (!e.target.closest('details.menu')) closeMenu();
});
$('btnImportCsv').onclick = () => {
  closeMenu();
  $('csvText').value = '';
  $('csvDialog').showModal();
};
$('csvDialog').addEventListener('close', async () => {
  if ($('csvDialog').returnValue !== 'ok') return;
  const cues = parseSheet($('csvText').value);
  if (!cues.length) return toast(t('csv.nothing'), 'error');
  if ($('csvReplace').checked) await act('replaceRundown', { rundown: cues });
  else for (const cue of cues) await act('addCue', { cue });
  toast(t('csv.done', { n: cues.length }));
});
$('btnExportShow').onclick = () => {
  closeMenu();
  location.href = '/api/show';
};
$('btnReport').onclick = () => {
  closeMenu();
  location.href = '/api/report.csv';
};
$('btnImportShow').onclick = async () => {
  closeMenu();
  const file = await pickFile('.json,application/json');
  if (!file) return;
  if (!confirm(t('rundown.confirmImport'))) return;
  const res = await fetch('/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await file.text() }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
  res.ok ? toast(t('rundown.imported')) : toast(res.error, 'error');
};
$('btnClearRundown').onclick = () => {
  closeMenu();
  if (confirm(t('rundown.confirmClear'))) quiet(act('clearRundown'));
};

/** Parse rows pasted from Excel / Google Sheets (tab-separated) or CSV. */
function parseSheet(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const first = lines[0];
  const delim = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';
  const table = lines.map((l) => splitRow(l, delim));
  const head = table[0].map((x) => x.trim().toLowerCase());
  const known = {
    title: ['title', 'name', 'segment', 'session', 'item', 'topic'],
    speaker: ['speaker', 'presenter', 'who', 'host', 'speakers'],
    duration: ['duration', 'length', 'time', 'min', 'minutes', 'mins'],
    start: ['start', 'start time', 'starts', 'at', 'begin', 'from'],
    end: ['end', 'end time', 'ends', 'finish', 'until', 'to', 'target'],
    notes: ['notes', 'note', 'comment', 'comments'],
    type: ['type', 'mode'],
  };
  let map;
  if (head.some((x) => known.title.includes(x))) {
    map = Object.fromEntries(Object.entries(known).map(([k, names]) => [k, head.findIndex((x) => names.includes(x))]));
    table.shift();
  } else {
    map = { title: 0, duration: 1, speaker: 2, start: -1, end: -1, notes: -1, type: -1 };
  }
  return table
    .map((r) => {
      const get = (k) => (map[k] >= 0 ? (r[map[k]] ?? '').trim() : '');
      const cue = { title: get('title'), speaker: get('speaker'), notes: get('notes') };
      let d = parseDuration(get('duration'));
      const type = get('type').toLowerCase().replace(/[\s-]/g, '');
      const start = parseClockTime(get('start'));
      const end = parseClockTime(get('end'));
      if (start != null) cue.start = get('start');
      // No duration but a start and end time: work the duration out.
      if (d == null && start != null && end != null) d = (((end - start) % 86400) + 86400) % 86400 * 1000;
      if (d != null) cue.duration = d;
      if (type === 'countup') cue.mode = 'countup';
      if (type.startsWith('clock') || type.startsWith('timeofday') || type.startsWith('until')) {
        cue.mode = 'clock';
        cue.target = get('end') || get('start');
      }
      return cue;
    })
    .filter((c) => c.title || c.duration != null);
}

function splitRow(line, delim) {
  if (delim === '\t') return line.split('\t');
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) out.push(cur), (cur = '');
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// side tabs

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((el) => (el.hidden = el.id !== `tab-${name}`));
  try {
    localStorage.setItem('lupixis.tab', name);
  } catch {}
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
let savedTab = 'message';
try {
  savedTab = localStorage.getItem('lupixis.tab') || 'message';
} catch {}
showTab(savedTab);

// ---- message ----
let selColor = 'white';
let lastServerMsg = null;
function paintSwatches() {
  document.querySelectorAll('#msgColors .sw').forEach((b) => b.classList.toggle('selected', b.dataset.color === selColor));
}
document.querySelectorAll('#msgColors .sw').forEach((b) => {
  b.onclick = () => {
    selColor = b.dataset.color;
    paintSwatches();
    if (S?.message.visible) quiet(act('setMessage', { color: selColor }));
  };
});
$('msgFlash').onchange = () => S?.message.visible && quiet(act('setMessage', { flash: $('msgFlash').checked }));
const showMsg = () => {
  const text = $('msgText').value.trim();
  if (!text) return invalid($('msgText'));
  quiet(act('showMessage', { text, color: selColor, flash: $('msgFlash').checked }));
};
$('btnMsgShow').onclick = showMsg;
$('msgText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) showMsg();
});
$('btnMsgHide').onclick = () => quiet(act('hideMessage'));
$('btnEditPresets').onclick = () => {
  const ed = $('presetEditor');
  ed.hidden = !ed.hidden;
  if (!ed.hidden) $('presetText').value = S.messagePresets.join('\n');
};
$('btnSavePresets').onclick = async () => {
  await act('setPresets', { presets: $('presetText').value.split('\n').map((x) => x.trim()).filter(Boolean) });
  $('presetEditor').hidden = true;
};

let presetsKey = '';
function renderMessage(s) {
  const m = s.message;
  const key = `${m.text}|${m.color}|${m.flash}`;
  if (key !== lastServerMsg) {
    lastServerMsg = key;
    setVal($('msgText'), m.text);
    selColor = m.color;
    setVal($('msgFlash'), m.flash);
    paintSwatches();
  }
  $('msgLive').classList.toggle('on', m.visible);
  const pk = JSON.stringify(s.messagePresets) + m.visible + m.text;
  if (pk === presetsKey) return;
  presetsKey = pk;
  $('presetList').replaceChildren(
    ...s.messagePresets.map((text, i) =>
      h('button', {
        class: `btn${m.visible && m.text === text ? ' active' : ''}`,
        onclick: () => (m.visible && S.message.text === text ? quiet(act('hideMessage')) : quiet(act('showPreset', { index: i + 1, color: selColor, flash: $('msgFlash').checked }))),
      }, text, h('kbd', {}, String(i + 1))),
    ),
  );
}

// ---- broadcast ----
$('btnOnAir').onclick = () => quiet(act('overlayToggle'));
document.querySelectorAll('#layoutSeg button').forEach((b) => (b.onclick = () => quiet(act('overlayUpdate', { layout: b.dataset.layout }))));
$('ovLabel').onchange = () => quiet(act('overlayUpdate', { label: $('ovLabel').value }));
$('ovSubLabel').onchange = () => quiet(act('overlayUpdate', { subLabel: $('ovSubLabel').value }));
$('ovAtZero').onchange = () => quiet(act('overlayUpdate', { atZero: $('ovAtZero').value }));
$('ovZeroText').onchange = () => quiet(act('overlayUpdate', { zeroText: $('ovZeroText').value }));
// Time & progress options: data-ov="<overlay key>" (select or checkbox)
document.querySelectorAll('[data-ov]').forEach((el) => {
  el.onchange = () => quiet(act('overlayUpdate', { [el.dataset.ov]: el.type === 'checkbox' ? el.checked : el.value }));
});

const theme = (patch) => quiet(act('updateTheme', { patch }));
const themeLive = throttle(theme, 120);
$('thFont').onchange = () => theme({ fontFamily: $('thFont').value.trim() || 'Segoe UI' });
$('thWeight').onchange = () => theme({ fontWeight: $('thWeight').value });
$('thText').oninput = () => themeLive({ textColor: $('thText').value });
$('thAccent').oninput = () => themeLive({ accentColor: $('thAccent').value });
$('thPanel').oninput = () => themeLive({ panelColor: $('thPanel').value });
$('thOpacity').oninput = () => themeLive({ panelOpacity: $('thOpacity').value });
$('thRadius').oninput = () => themeLive({ radius: $('thRadius').value });
$('thUpper').onchange = () => theme({ uppercaseLabel: $('thUpper').checked });
$('thShowLogo').onchange = () => theme({ showLogo: $('thShowLogo').checked });
$('thBg').onchange = () => theme({ background: $('thBg').value });
$('thBgColor').oninput = () => themeLive({ backgroundColor: $('thBgColor').value, background: 'color' });

async function uploadInto(accept, patchFn) {
  const file = await pickFile(accept);
  if (!file) return;
  try {
    theme(patchFn(await upload(file), file));
  } catch (err) {
    toast(err.message, 'error');
  }
}
$('btnFontUpload').onclick = () => uploadInto('.ttf,.otf,.woff,.woff2', (url) => ({ fontUrl: url }));
$('btnFontClear').onclick = () => theme({ fontUrl: '' });
$('btnLogoUpload').onclick = () => uploadInto('image/*', (url) => ({ logoUrl: url, showLogo: true }));
$('btnLogoClear').onclick = () => theme({ logoUrl: '' });
$('btnLogoBrand').onclick = () => theme({ logoUrl: '/shared/logo.svg', showLogo: true });
$('btnBgUpload').onclick = () => uploadInto('image/*', (url) => ({ backgroundUrl: url, background: 'image' }));

function renderBroadcast(s) {
  const o = s.overlay;
  const th = s.theme;
  $('btnOnAir').classList.toggle('on', o.onAir);
  setText($('onAirLabel'), o.onAir ? t('broadcast.onAir') : t('broadcast.offAir'));
  document.querySelectorAll('#layoutSeg button').forEach((b) => b.classList.toggle('active', b.dataset.layout === o.layout));
  const cue = s.rundown.find((c) => c.id === s.currentId);
  $('ovLabel').placeholder = cue?.title ? t('broadcast.labelPlaceholder', { title: cue.title }) : t('broadcast.labelEmpty');
  setVal($('ovLabel'), o.label);
  setVal($('ovSubLabel'), o.subLabel);
  setVal($('ovAtZero'), o.atZero);
  setVal($('ovZeroText'), o.zeroText);
  $('ovZeroTextField').hidden = o.atZero !== 'text';
  document.querySelectorAll('[data-ov]').forEach((el) => setVal(el, el.dataset.ov === 'progressStyle' && o.showProgress === false ? 'none' : o[el.dataset.ov]));

  setVal($('thFont'), th.fontFamily);
  setVal($('thWeight'), String(th.fontWeight));
  setVal($('thText'), th.textColor);
  setVal($('thAccent'), th.accentColor);
  setVal($('thPanel'), th.panelColor);
  setVal($('thOpacity'), th.panelOpacity);
  setText($('thOpacityVal'), `${Math.round(th.panelOpacity * 100)}%`);
  setVal($('thRadius'), th.radius);
  setText($('thRadiusVal'), `${th.radius}px`);
  setVal($('thUpper'), th.uppercaseLabel);
  setVal($('thShowLogo'), th.showLogo);
  if ($('thLogoPreview').getAttribute('src') !== th.logoUrl) $('thLogoPreview').setAttribute('src', th.logoUrl);
  setText($('thFontFile'), th.fontUrl ? th.fontUrl.split('/').pop() : t('theme.noFontFile'));
  $('btnFontClear').hidden = !th.fontUrl;
  $('btnLogoClear').hidden = !th.logoUrl;
  setVal($('thBg'), th.background);
  setVal($('thBgColor'), th.backgroundColor);
}

document.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy($(b.dataset.copy).value)));
function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast(t('common.copied')), () => toast(text));
}

// ---- outputs ----
// In the desktop app, outputs always mean *this* computer (via the preload bridge), even when this
// controller is showing a timer that runs on another laptop. In a browser they go to the server's computer.
const bridge = window.lupixisDesktop;
let localInfo = null;
if (bridge) {
  const setInfo = (i) => {
    localInfo = i;
    if (S && langReady) renderOutputs(S), renderSettings(S);
  };
  bridge.info().then(setInfo);
  bridge.onUpdate(setInfo);
}
const appCmd = (command, extra = {}) =>
  bridge ? bridge.command(command, extra).catch((e) => toast(e.message, 'error')) : quiet(act('app', { command, ...extra }));
$('btnFloating').onclick = () => appCmd('toggleFloating');
$('btnCloseOutputs').onclick = () => appCmd('closeAllOutputs');

// ---- this computer: follow a timer on another laptop ----
async function connectTo(url, name) {
  try {
    await bridge.command('connect', { url, name }); // the window reloads from the other timer
  } catch (e) {
    toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
  }
}
$('connectForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('connectInput').value.trim();
  if (!v) return invalid($('connectInput'));
  connectTo(v);
};
$('btnDisconnect').onclick = () => bridge?.command('disconnect');
$('takeoverSelect').onchange = () => bridge?.command('setTakeover', { view: $('takeoverSelect').value });
$('btnScreen2').onclick = () => bridge?.command('toggleSecondScreen').catch((e) => toast(e.message.replace(/^.*Error: /, ''), 'error'));
$('btnFullscreen').onclick = () => bridge?.toggleFullscreen();
$('btnFullscreen').hidden = !bridge;

// ---- touch mode: bigger buttons and rows for touchscreens (remembered per device) ----
function touchDefault() {
  return matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches);
}
function setTouch(on, save) {
  document.body.classList.toggle('touch', on);
  $('btnTouch').classList.toggle('active', on);
  if (save) {
    try {
      localStorage.setItem('lupixis.touch', on ? 'on' : 'off');
    } catch {}
  }
}
let touchPref = null;
try {
  touchPref = localStorage.getItem('lupixis.touch');
} catch {}
setTouch(touchPref ? touchPref === 'on' : touchDefault(), false);
$('btnTouch').onclick = () => setTouch(!document.body.classList.contains('touch'), true);

function renderScreenButtons() {
  const i = localInfo;
  const second = i?.displays?.find((d) => !d.primary);
  $('btnScreen2').hidden = !second;
  if (!second) return;
  const on = (i.outputs || []).some((o) => o.displayId === second.id);
  $('btnScreen2').classList.toggle('danger-on', on);
  setText($('btnScreen2'), on ? t('top.screen2On') : t('top.screen2'));
  setVal($('takeoverSelect'), i.takeover || 'none');
}

let networkKey = '';
function renderThisComputer() {
  const i = localInfo;
  $('thisComputer').hidden = !i;
  if (!i) return;
  const remote = i.mode === 'remote';
  $('modeBadge').className = `badge mode ${remote ? 'remote' : 'main'}`;
  setText($('modeBadge'), remote ? t('outputs.modeRemote') : t('outputs.modeMain'));
  setText($('modeText'), remote ? t('outputs.modeRemoteText', { name: i.remote.name, url: i.remote.url }) : t('outputs.modeMainText', { name: i.hostname }));
  $('btnDisconnect').hidden = !remote;
  $('remoteBadge').hidden = !remote;
  if (remote) setText($('remoteBadge'), t('top.following', { name: i.remote.name }));
  const key = JSON.stringify([i.discovered, i.remote, lang]);
  if (key === networkKey) return;
  networkKey = key;
  const list = i.discovered || [];
  $('discoverList').replaceChildren(
    ...(list.length
      ? list.map((d) => {
          const active = remote && i.remote.url === d.url;
          return h('div', { class: `peer${active ? ' active' : ''}` },
            h('div', { class: 'peer-name' }, d.name, h('span', { class: 'muted small' }, `${d.host}:${d.port}${d.version ? ' · v' + d.version : ''}`)),
            active ? h('span', { class: 'badge remote' }, t('outputs.connected')) : h('button', { class: 'btn small primary', onclick: () => connectTo(d.url, d.name) }, t('outputs.connect')),
          );
        })
      : [h('p', { class: 'hint' }, t('outputs.noneFound'))]),
  );
}

let displaysKey = '';
function renderOutputs(s) {
  renderThisComputer();
  renderScreenButtons();
  const host = localInfo || s.host || {};
  const desktop = host.type === 'electron';
  $('desktopOutputs').hidden = !desktop;
  $('browserOnlyNote').hidden = desktop;
  $('hotkeySettings').hidden = !desktop;
  if (!desktop) return;
  setText($('btnFloating'), host.floatingOpen ? t('outputs.closeFloating') : t('outputs.openFloating'));
  $('btnFloating').classList.toggle('primary', !host.floatingOpen);
  const key = JSON.stringify([host.displays, host.outputs, lang]);
  if (key === displaysKey) return;
  displaysKey = key;
  const open = new Set((host.outputs || []).map((o) => `${o.view}@${o.displayId}`));
  $('displayList').replaceChildren(
    ...(host.displays || []).map((d, i) =>
      h('div', { class: 'display' },
        h('div', { class: 'display-name' }, `${t('outputs.display')} ${i + 1}`, h('span', { class: 'muted small' }, `${d.width}×${d.height}${d.primary ? ' · ' + t('outputs.primary') : ''}`)),
        h('div', { class: 'row' },
          ['viewer', 'overlay'].map((view) => {
            const on = open.has(`${view}@${d.id}`);
            return h('button', { class: `btn small${on ? ' active' : ''}`, onclick: () => appCmd(on ? 'closeOutput' : 'openOutput', { displayId: d.id, view }) }, t(`outputs.view.${view}`));
          }),
        ),
      ),
    ),
  );
}

function renderLinks() {
  const sel = $('addrSelect');
  const hosts = [...info.addresses, 'localhost'];
  const prev = sel.value;
  sel.replaceChildren(...hosts.map((a) => h('option', { value: a }, a === 'localhost' ? t('outputs.thisComputer') : a)));
  sel.value = hosts.includes(prev) ? prev : hosts[0];
  const base = `http://${sel.value}:${info.port}`;
  const links = [
    ['controller', '/controller'],
    ['viewer', '/viewer'],
    ['compact', '/viewer?compact=1'],
    ['overlay', '/overlay'],
  ];
  $('linkList').replaceChildren(
    ...links.map(([k, path]) => {
      const url = base + path;
      return h('div', { class: 'linkrow' },
        h('span', {}, t(`outputs.link.${k}`)),
        h('code', { title: url }, url),
        h('button', { class: 'btn small', onclick: () => copy(url) }, t('common.copy')),
        h('button', { class: 'btn small', onclick: () => showQr(url, t(`outputs.link.${k}`)) }, 'QR'),
      );
    }),
  );
  showQr(`${base}/viewer`, t('outputs.link.viewer'));
  $('overlayUrl').value = `${location.protocol}//${location.host}/overlay`;
}
function showQr(url, label) {
  $('qrImg').src = `/api/qr?text=${encodeURIComponent(url)}`;
  setText($('qrLabel'), `${label} · ${url}`);
}
$('addrSelect').onchange = renderLinks;

// ---- settings ----
$('setLanguage').onchange = () => quiet(act('updateSettings', { patch: { language: $('setLanguage').value } }));
for (const [id, key] of [['setDuration', 'defaultDuration'], ['setWarning', 'defaultWarning'], ['setCritical', 'defaultCritical']]) {
  $(id).onchange = () => {
    const ms = parseDuration($(id).value);
    if (ms == null) return invalid($(id));
    quiet(act('updateSettings', { patch: { [key]: ms } }));
  };
}
document.querySelectorAll('[data-viewer]').forEach((cb) => {
  cb.onchange = () => quiet(act('updateSettings', { patch: { viewer: { [cb.dataset.viewer]: cb.checked } } }));
});
$('setKeepOnTop').onchange = () => quiet(act('updateSettings', { patch: { floatingKeepOnTop: $('setKeepOnTop').checked } }));
$('setClock24').onchange = () => quiet(act('updateSettings', { patch: { clock24: $('setClock24').checked } }));
$('setAutoStart').onchange =() => quiet(act('updateSettings', { patch: { autoStartScheduled: $('setAutoStart').checked } }));
document.querySelectorAll('[data-viewer-select]').forEach((el) => {
  el.onchange = () => quiet(act('updateSettings', { patch: { viewer: { [el.dataset.viewerSelect]: el.value } } }));
});
document.querySelectorAll('[data-floating]').forEach((cb) => {
  cb.onchange = () => quiet(act('updateSettings', { patch: { floating: { [cb.dataset.floating]: cb.checked } } }));
});
document.querySelectorAll('[data-floating-select]').forEach((el) => {
  el.onchange = () => quiet(act('updateSettings', { patch: { floating: { [el.dataset.floatingSelect]: el.value } } }));
});
// Integrations (QLab / CasparCG): data-integ="qlab.host" etc.
document.querySelectorAll('[data-integ]').forEach((el) => {
  el.onchange = () => {
    const [src, key] = el.dataset.integ.split('.');
    let v = el.type === 'checkbox' ? el.checked : el.value.trim();
    if ('num' in el.dataset) {
      v = Number(v);
      if (!Number.isInteger(v) || v < 1 || v > 65535) return invalid(el);
    }
    quiet(act('updateSettings', { patch: { integrations: { [src]: { [key]: v } } } }));
  };
});
function renderIntegrations(st) {
  const ig = st.integrations || {};
  document.querySelectorAll('[data-integ]').forEach((el) => {
    const [src, key] = el.dataset.integ.split('.');
    setVal(el, ig[src]?.[key]);
  });
  $('qlabColorField').hidden = ig.qlab?.filter !== 'color';
  $('qlabTagField').hidden = ig.qlab?.filter !== 'tag';
  $('casparLayersField').hidden = ig.caspar?.filter !== 'layers';
  $('casparTagField').hidden = ig.caspar?.filter !== 'tag';
}
function renderClipStatus() {
  const st = conn.clipStatus || {};
  for (const src of ['qlab', 'caspar']) {
    const text = !st[src] || st[src] === 'off' ? t('clips.off') : st[src];
    const el = $(`${src}Status`);
    setText(el, text);
    el.className = `istatus ${/^(Connected|Listening)/.test(text) ? 'ok' : text === t('clips.off') ? '' : 'warn'}`;
  }
}
conn.on('clips', renderClipStatus);

let clipListKey = '';
function renderClipList(clips) {
  if ($('tab-clips').hidden) return;
  const key = JSON.stringify(clips.map((c) => [c.key, c.name, Math.ceil(c.remainingNow), c.paused]));
  if (key === clipListKey) return;
  clipListKey = key;
  $('clipList').replaceChildren(
    ...(clips.length
      ? clips.map((c) => {
          const s = Math.ceil(c.remainingNow);
          return h('div', { class: `clip-item${s <= 10 ? ' ending' : ''}` },
            h('span', {}, `${c.paused ? '⏸' : '▶'} ${c.name}`),
            h('span', { class: 't' }, formatSeconds(s)),
            h('span', { class: 'src' }, c.source === 'qlab' ? 'QLab' : `CasparCG ${c.key.split(':')[1]}`),
          );
        })
      : [h('p', { class: 'hint' }, t('clips.none'))]),
  );
}

const floatOpacity = throttle((v) => quiet(act('updateSettings', { patch: { floating: { opacity: Number(v) } } })), 120);
$('floatOpacity').oninput = () => floatOpacity($('floatOpacity').value);
$('btnResetLog').onclick = () => confirm(t('settings.confirmResetLog')) && quiet(act('resetLog'));

const hotkeyInputs = {};
function buildHotkeys() {
  $('hotkeyList').replaceChildren(
    ...HOTKEYS.map((k) => {
      const input = h('input', { placeholder: t('settings.hotkeyNone'), title: t('settings.hotkeyRecord') });
      input.addEventListener('keydown', (e) => recordHotkey(e, k, input));
      input.onchange = () => quiet(act('updateSettings', { patch: { hotkeys: { [k]: input.value.trim() } } }));
      hotkeyInputs[k] = input;
      return h('label', { class: 'hotkey' }, h('span', {}, t(`hotkeys.${k}`)), input);
    }),
  );
}
// Press a key combination in the field to record it as an Electron accelerator.
function recordHotkey(e, k, input) {
  if (e.key === 'Tab') return;
  e.preventDefault();
  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    input.value = '';
  } else {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const names = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus' };
    const key = names[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    if (!mods.length && !/^F\d+$/.test(key)) return toast(t('settings.hotkeyNeedsModifier'), 'error');
    input.value = [...mods, key].join('+');
  }
  input.blur(); // triggers change -> save
}

async function renderSettings(s) {
  const st = s.settings;
  setVal($('setLanguage'), st.language);
  setVal($('setDuration'), formatDurationInput(st.defaultDuration));
  setVal($('setWarning'), formatDurationInput(st.defaultWarning));
  setVal($('setCritical'), formatDurationInput(st.defaultCritical));
  document.querySelectorAll('[data-viewer]').forEach((cb) => setVal(cb, st.viewer[cb.dataset.viewer]));
  setVal($('setKeepOnTop'), st.floatingKeepOnTop);
  setVal($('setAutoStart'), st.autoStartScheduled);
  setVal($('setClock24'), st.clock24 !== false);
  renderIntegrations(st);
  renderClipStatus();
  document.querySelectorAll('[data-viewer-select]').forEach((el) => setVal(el, st.viewer[el.dataset.viewerSelect]));
  document.querySelectorAll('[data-floating]').forEach((cb) => setVal(cb, st.floating[cb.dataset.floating]));
  document.querySelectorAll('[data-floating-select]').forEach((el) => setVal(el, st.floating[el.dataset.floatingSelect]));
  setVal($('floatOpacity'), st.floating.opacity);
  setText($('floatOpacityVal'), `${Math.round(st.floating.opacity * 100)}%`);
  $('keepOnTopRow').hidden = (localInfo || s.host)?.type !== 'electron';
  if (info.version) setText($('aboutLine'), `${info.name} ${info.version} · ${t('settings.port')} ${info.port}`);
  const errors = (localInfo || s.host)?.hotkeyErrors || [];
  for (const k of HOTKEYS) {
    const input = hotkeyInputs[k];
    if (!input) continue;
    setVal(input, st.hotkeys[k]);
    input.classList.toggle('invalid', errors.includes(k));
    input.title = errors.includes(k) ? t('settings.hotkeyTaken') : t('settings.hotkeyRecord');
  }
}

// ---------------------------------------------------------------------------
// state -> UI

conn.on('status', (ok) => {
  $('conn').classList.toggle('ok', ok);
  setText($('connText'), ok ? t('top.connected') : t('top.offline'));
});

conn.on('state', async (s) => {
  S = s;
  if (s.settings.language !== lang) {
    lang = s.settings.language;
    langReady = false;
    await loadLanguage(lang);
    langReady = true;
    applyI18n();
    // Rebuild translated pieces.
    rows.forEach((r) => r.el.remove());
    rows.clear();
    presetsKey = displaysKey = networkKey = clipListKey = '';
    buildHotkeys();
    renderLinks();
    setText($('connText'), conn.connected ? t('top.connected') : t('top.offline'));
  }
  render(s);
});

function render(s) {
  const cues = s.rundown.filter(isCueItem);
  const i = cues.findIndex((c) => c.id === s.currentId);
  const cue = cues[i];
  const next = cues[i + 1];
  setText($('nowIndex'), cue ? String(i + 1) : '–');
  setText($('nowTitle'), cue ? cue.title || t('viewer.untitled') : t('now.nothingLoaded'));
  setText($('nowSpeaker'), cue?.speaker || '');
  setText($('nowNext'), next ? `${t('viewer.next')}: ${next.title || t('viewer.untitled')}` : '');
  $('btnBlackout').classList.toggle('danger-on', s.blackout);
  const cl = s.clients || {};
  const screens = (cl.viewer || 0) + (cl.overlay || 0) + (cl.floating || 0);
  setText($('clientsCount'), t(screens === 1 ? 'top.clientsOne' : 'top.clients', { n: screens }));
  renderRundown(s);
  renderShowChip(s);
  renderMessage(s);
  renderBroadcast(s);
  renderOutputs(s);
  renderSettings(s);
}

/** "Auto-start: Keynote at 14:00 (in 12:31)" for the next cue that will start itself. */
function nextAutoStartText() {
  if (!S.settings.autoStartScheduled) return '';
  const now = conn.now();
  let best = null;
  for (const cue of S.rundown) {
    if (!cue.start) continue;
    const at = todayAt(cue.start, now);
    if (at != null && at > now && (!best || at < best.at)) best = { cue, at };
  }
  if (!best) return '';
  return t('now.autoStart', { title: best.cue.title || t('viewer.untitled'), time: best.cue.start, in: formatSeconds(Math.ceil((best.at - now) / 1000)) });
}

// Per-frame: the big clock and live progress.
function frame() {
  if (S) {
    const c = conn.timer();
    setText($('bigTime'), timerText(c));
    const pulse = c.phase === 'overtime' && !!S.rundown.find((x) => x.id === S.currentId)?.flashOvertime;
    const cls = `card now phase-${c.phase}${pulse ? ' pulse-overtime' : ''}`;
    if ($('nowCard').className !== cls) $('nowCard').className = cls;
    $('bigProgress').style.width = `${(c.progress * 100).toFixed(2)}%`;
    const r = rows.get(S.currentId);
    if (r?.f.progress) r.f.progress.style.width = `${(c.progress * 100).toFixed(2)}%`;
    if (Date.now() - lastProjection > 500) renderProjection();

    const stateKey = !c.loaded ? 'idle' : c.running ? 'running' : c.started ? 'paused' : 'ready';
    const pill = $('nowState');
    pill.className = `state-pill ${stateKey}`;
    setText(pill, t(`now.${stateKey}`));
    const btn = $('btnToggle');
    const isClock = c.mode === 'clock';
    btn.classList.toggle('pause', c.running && !isClock);
    btn.disabled = isClock;
    $('btnStop').disabled = !c.started || isClock; // nothing to stop yet
    setText($('toggleLabel'), isClock ? t('transport.live') : c.running ? t('transport.pause') : c.started ? t('transport.resume') : t('transport.start'));

    let ends = '';
    if (c.loaded && c.mode !== 'countup' && c.running) {
      ends = c.remaining > 0
        ? t('now.endsAt', { time: formatClock(conn.now() + c.remaining, S.settings.clock24) })
        : t('now.over', { time: timerText(c).slice(1) });
    }
    setText($('nowEnds'), ends);
    setText($('nowAuto'), nextAutoStartText());
    const clips = conn.clipsNow();
    setText($('nowClips'), clips.map((cl) => `▶ ${cl.name} · ${formatSeconds(Math.ceil(cl.remainingNow))}`).join('   '));
    renderClipList(clips);
    setText($('topClock'), formatClock(conn.now(), S.settings.clock24));
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Network info (addresses for links / QR codes) and language list.
fetch('/api/info').then((r) => r.json()).then((d) => {
  info = d;
  if (lang) {
    renderLinks();
    setText($('aboutLine'), `${d.name} ${d.version} · ${t('settings.port')} ${d.port}`);
  }
});
fetch('/api/locales').then((r) => r.json()).then((list) => {
  $('setLanguage').replaceChildren(...list.map((l) => h('option', { value: l.code }, l.name)));
  if (S) setVal($('setLanguage'), S.settings.language);
});
