// Controller UI. Every button just sends an action to the server; the server broadcasts the new state
// and `render()` redraws from it. That way several controllers (laptop + phone) always agree.
import { Connection, loadLanguage, applyI18n, t, h, setVal, formatClock } from '/shared/client.js';
import { timerText, parseDuration, formatDurationInput, parseClockTime, formatTimeOfDay, computeSchedule, todayAt, formatSeconds, MODES } from '/shared/timecalc.js';

const $ = (id) => document.getElementById(id);
const conn = new Connection({ role: 'controller' });
let S = null; // latest server state
let lang = null;
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

function createRow(id) {
  const f = {};
  const r = { f, cue: null };
  const update = (patch) => quiet(act('updateCue', { id, patch }));

  r.el = h('div', { class: 'cue', dataset: { id } },
    h('div', { class: 'cue-grid' },
      (f.num = h('span', { class: 'cue-num', title: t('rundown.dragHint') })),
      h('div', { class: 'c-title' },
        (f.title = h('input', { placeholder: t('rundown.titlePlaceholder') })),
        (f.speaker = h('input', { class: 'speaker', placeholder: t('rundown.speakerPlaceholder') })),
      ),
      h('div', { class: 'c-mode' }, (f.mode = h('select', {}, MODES.map((m) => h('option', { value: m }, t(`mode.${m}`)))))),
      h('div', { class: 'c-start' }, (f.start = h('input', { title: t('rundown.startHint') }))),
      h('div', { class: 'c-dur' }, (f.time = h('input'))),
      h('div', { class: 'c-end' }, (f.end = h('input', { title: t('rundown.endHint') }))),
      h('div', { class: 'c-auto' }, (f.auto = h('input', { type: 'checkbox', title: t('rundown.autoHint') }))),
      h('div', { class: 'c-actions' },
        (f.load = h('button', { class: 'btn', title: t('rundown.load') }, svg(ICON_LOAD))),
        (f.go = h('button', { class: 'btn go-now', title: t('rundown.startNow') }, svg(ICON_PLAY))),
        (f.moreBtn = h('button', { class: 'btn', title: t('rundown.details') }, svg(ICON_DOTS))),
      ),
    ),
    (f.more = h('div', { class: 'cue-more', hidden: true },
      // Type lives here in touch mode, where the Type column is hidden to make room.
      h('label', { class: 'field touch-only' }, h('span', {}, t('rundown.colType')), (f.mode2 = h('select', {}, MODES.map((m) => h('option', { value: m }, t(`mode.${m}`)))))),
      h('label', { class: 'field' }, h('span', {}, t('rundown.warning')), (f.warning = h('input'))),
      h('label', { class: 'field' }, h('span', {}, t('rundown.critical')), (f.critical = h('input'))),
      h('label', { class: 'field notes' }, h('span', {}, t('rundown.notes')), (f.notes = h('textarea', { rows: 2 }))),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => quiet(act('addCue', { afterId: id })) }, t('rundown.insertBelow')),
        h('button', { class: 'btn small', onclick: () => quiet(act('duplicateCue', { id })) }, t('rundown.duplicate')),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn small danger', onclick: () => confirm(t('rundown.confirmDelete', { title: r.cue?.title || '' })) && quiet(act('deleteCue', { id })) }, t('common.delete')),
      ),
    )),
    (f.progress = h('div', { class: 'cue-progress' })),
  );

  f.title.onchange = () => update({ title: f.title.value });
  f.speaker.onchange = () => update({ speaker: f.speaker.value });
  f.notes.onchange = () => update({ notes: f.notes.value });
  f.auto.onchange = () => update({ autoAdvance: f.auto.checked });
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
    if (v && parseClockTime(v) == null) return invalid(f.start), (f.start.value = r.cue.start);
    update({ start: v });
  };
  // End: sets the duration from the start time (or the target time for "until time" cues).
  f.end.onchange = () => {
    const v = f.end.value.trim();
    const endSecs = parseClockTime(v);
    if (endSecs == null) return invalid(f.end), (f.end.value = formatTimeOfDay(r.sched?.end));
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
  r.el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
    if (e.key === 'Escape' && e.target.tagName === 'INPUT') e.target.blur();
  });

  // Drag to reorder (grab the number).
  f.num.addEventListener('mousedown', () => (r.el.draggable = true));
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
  return r;
}

function renderRundown(s) {
  const list = $('cueList');
  const cur = s.rundown.findIndex((c) => c.id === s.currentId);
  const sched = computeSchedule(s.rundown);
  s.rundown.forEach((cue, i) => {
    let r = rows.get(cue.id);
    if (!r) rows.set(cue.id, (r = createRow(cue.id)));
    r.cue = cue;
    r.sched = sched[i];
    const f = r.f;
    const sc = sched[i];
    setText(f.num, String(i + 1));
    setVal(f.title, cue.title);
    setVal(f.speaker, cue.speaker);
    setVal(f.mode, cue.mode);
    setVal(f.mode2, cue.mode);
    // Start: own time in the field; otherwise the planned (chained) start as a faint placeholder.
    setVal(f.start, cue.start);
    f.start.placeholder = !cue.start && sc.start != null ? formatTimeOfDay(sc.start) : '--:--';
    f.start.parentElement.classList.toggle('scheduled', !!cue.start && s.settings.autoStartScheduled);
    // Duration: editable, except for "until time" cues where it follows from start → target.
    const isClock = cue.mode === 'clock';
    f.time.disabled = isClock;
    setVal(f.time, isClock ? (sc.start != null && sc.end != null ? formatDurationInput((sc.end - sc.start) * 1000) : '—') : formatDurationInput(cue.duration));
    f.time.placeholder = 'M:SS';
    f.time.title = isClock ? t('rundown.clockDurationHint') : t('rundown.durationHint');
    // End: computed from start + duration (or the target time).
    setVal(f.end, isClock ? cue.target : formatTimeOfDay(sc.end));
    f.end.placeholder = '--:--';
    setVal(f.auto, cue.autoAdvance);
    setVal(f.warning, formatDurationInput(cue.warning));
    setVal(f.critical, formatDurationInput(cue.critical));
    setVal(f.notes, cue.notes);
    r.el.classList.toggle('current', i === cur);
    r.el.classList.toggle('done', cur >= 0 && i < cur);
    if (i !== cur) f.progress.style.width = '0';
  });
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
  const total = s.rundown.filter((c) => c.mode !== 'clock').reduce((a, c) => a + c.duration, 0);
  setText($('rundownTotal'), s.rundown.length ? t('rundown.total', { n: s.rundown.length, time: formatDurationInput(total) }) : '');
}

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
    if (S) renderOutputs(S), renderSettings(S);
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
$('setAutoStart').onchange = () => quiet(act('updateSettings', { patch: { autoStartScheduled: $('setAutoStart').checked } }));
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
    await loadLanguage(lang);
    applyI18n();
    // Rebuild translated pieces.
    rows.forEach((r) => r.el.remove());
    rows.clear();
    presetsKey = displaysKey = '';
    buildHotkeys();
    renderLinks();
    setText($('connText'), conn.connected ? t('top.connected') : t('top.offline'));
  }
  render(s);
});

function render(s) {
  const i = s.rundown.findIndex((c) => c.id === s.currentId);
  const cue = s.rundown[i];
  const next = s.rundown[i + 1];
  setText($('nowIndex'), cue ? String(i + 1) : '–');
  setText($('nowTitle'), cue ? cue.title || t('viewer.untitled') : t('now.nothingLoaded'));
  setText($('nowSpeaker'), cue?.speaker || '');
  setText($('nowNext'), next ? `${t('viewer.next')}: ${next.title || t('viewer.untitled')}` : '');
  $('btnBlackout').classList.toggle('danger-on', s.blackout);
  const cl = s.clients || {};
  setText($('clientsCount'), t('top.clients', { n: (cl.viewer || 0) + (cl.overlay || 0) + (cl.floating || 0) }));
  renderRundown(s);
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
    const cls = `card now phase-${c.phase}`;
    if ($('nowCard').className !== cls) $('nowCard').className = cls;
    $('bigProgress').style.width = `${(c.progress * 100).toFixed(2)}%`;
    const r = rows.get(S.currentId);
    if (r) r.f.progress.style.width = `${(c.progress * 100).toFixed(2)}%`;

    const stateKey = !c.loaded ? 'idle' : c.running ? 'running' : c.started ? 'paused' : 'ready';
    const pill = $('nowState');
    pill.className = `state-pill ${stateKey}`;
    setText(pill, t(`now.${stateKey}`));
    const btn = $('btnToggle');
    const isClock = c.mode === 'clock';
    btn.classList.toggle('pause', c.running && !isClock);
    btn.disabled = isClock;
    setText($('toggleLabel'), isClock ? t('transport.live') : c.running ? t('transport.pause') : c.started ? t('transport.resume') : t('transport.start'));

    let ends = '';
    if (c.loaded && c.mode !== 'countup' && c.running) {
      ends = c.remaining > 0
        ? t('now.endsAt', { time: formatClock(conn.now() + c.remaining, S.settings.viewer.clock24) })
        : t('now.over', { time: timerText(c).slice(1) });
    }
    setText($('nowEnds'), ends);
    setText($('nowAuto'), nextAutoStartText());
    const clips = conn.clipsNow();
    setText($('nowClips'), clips.map((cl) => `▶ ${cl.name} · ${formatSeconds(Math.ceil(cl.remainingNow))}`).join('   '));
    renderClipList(clips);
    setText($('topClock'), formatClock(conn.now(), S.settings.viewer.clock24));
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
