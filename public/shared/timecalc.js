// Pure timing helpers shared by the server (Node) and every browser view.
// Nothing in here touches the DOM or the network, so it is easy to unit-test.

export const MODES = ['countdown', 'countup', 'clock'];

/** An empty timer (nothing loaded). */
export function emptyTimer() {
  return {
    cueId: null,
    mode: 'countdown',
    running: false,
    startedAt: null, // server epoch ms when the current run segment started
    elapsedBefore: 0, // ms accumulated before the current run segment
    duration: 0, // ms planned length (for clock mode: span from load to target)
    targetAt: null, // clock mode: epoch ms we count down to
    warning: 120000,
    critical: 30000,
    loadedAt: null,
  };
}

/**
 * Compute everything a view needs to draw the timer at time `now` (server clock).
 * @returns {{loaded:boolean, running:boolean, mode:string, elapsed:number, remaining:number,
 *   duration:number, overtime:boolean, phase:'idle'|'normal'|'warning'|'critical'|'overtime',
 *   progress:number, started:boolean}}
 */
export function computeTimer(t, now) {
  if (!t || !t.cueId) {
    return { loaded: false, running: false, mode: 'countdown', elapsed: 0, remaining: 0, duration: 0, overtime: false, phase: 'idle', progress: 0, started: false };
  }
  let elapsed;
  let remaining;
  const duration = Math.max(0, t.duration || 0);
  if (t.mode === 'clock') {
    remaining = (t.targetAt ?? now) - now;
    elapsed = duration - remaining;
  } else {
    elapsed = (t.elapsedBefore || 0) + (t.running && t.startedAt != null ? now - t.startedAt : 0);
    remaining = duration - elapsed;
  }
  const hasLimit = t.mode === 'clock' || duration > 0;
  const overtime = hasLimit && remaining < 0;
  let phase = 'normal';
  if (hasLimit) {
    if (overtime) phase = 'overtime';
    else if (remaining <= (t.critical ?? 0)) phase = 'critical';
    else if (remaining <= (t.warning ?? 0)) phase = 'warning';
  }
  const progress = hasLimit && duration > 0 ? clamp(elapsed / duration, 0, 1) : 0;
  return {
    loaded: true,
    running: !!t.running,
    mode: t.mode,
    elapsed,
    remaining,
    duration,
    overtime,
    phase,
    progress,
    started: t.mode === 'clock' || elapsed > 0 || !!t.running,
  };
}

/** Format whole seconds as M:SS / MM:SS / H:MM:SS. */
export function formatSeconds(totalSeconds, { padMinutes = true } = {}) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${padMinutes ? String(m).padStart(2, '0') : m}:${ss}`;
}

/**
 * The text shown on screens for a computed timer.
 * Countdowns round up (so "00:01" is shown until the very last moment), overtime counts up with a "+".
 * @param {'overtime'|'hold'} overtimeStyle 'hold' freezes at 00:00 (used for public/broadcast graphics)
 */
export function timerText(c, overtimeStyle = 'overtime') {
  if (!c.loaded) return '--:--';
  if (c.mode === 'countup') return formatSeconds(c.elapsed / 1000);
  if (c.remaining > 0) return formatSeconds(Math.ceil(c.remaining / 1000));
  if (overtimeStyle === 'hold') return formatSeconds(0);
  return '+' + formatSeconds(-c.remaining / 1000);
}

/**
 * Parse a user-typed duration. Plain number = minutes ("5" -> 5 min),
 * "5:30" = 5 min 30 s, "1:05:00" = 1 h 5 min. Also accepts "90s", "2m", "1h".
 * @returns {number|null} milliseconds
 */
export function parseDuration(input) {
  if (input == null) return null;
  const str = String(input).trim().toLowerCase().replace(',', '.');
  if (!str) return null;
  const unit = str.match(/^(\d+(?:\.\d+)?)\s*(h|m|min|s|sec)$/);
  if (unit) {
    const n = parseFloat(unit[1]);
    const mult = unit[2].startsWith('h') ? 3600000 : unit[2].startsWith('m') ? 60000 : 1000;
    return Math.round(n * mult);
  }
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 60000);
  const parts = str.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  const [h, m, s] = nums.length === 3 ? nums : [0, nums[0], nums[1]];
  return ((h * 60 + m) * 60 + s) * 1000;
}

/** Format milliseconds for an editable duration field: "5:00", "1:05:00". */
export function formatDurationInput(ms) {
  return formatSeconds(Math.round((ms || 0) / 1000), { padMinutes: false });
}

/** Parse "HH:MM", "HH:MM:SS" (24 h) or "2:30 PM" / "2:30pm" into seconds since midnight, or null. */
export function parseClockTime(str) {
  const m = String(str || '').trim().match(/^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([ap]\.?m?\.?)?$/i);
  if (!m) return null;
  let h = +m[1];
  const min = +m[2], s = +(m[3] || 0);
  const ampm = m[4]?.[0].toLowerCase();
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm === 'p' ? 12 : 0);
  }
  if (h > 23 || min > 59 || s > 59) return null;
  return h * 3600 + min * 60 + s;
}

/**
 * Next occurrence of a wall-clock time (local time of the machine running this code).
 * A target that is more than 12 h in the past is assumed to mean tomorrow,
 * so "00:30" set at 23:30 counts down one hour, while "19:00" set at 19:05 shows 5 min overtime.
 */
export function nextClockTime(str, now) {
  const secs = parseClockTime(str);
  if (secs == null) return null;
  const d = new Date(now);
  // setHours (rather than midnight + seconds) keeps this correct on daylight-saving days
  d.setHours(Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60, 0);
  if (d.getTime() < now - 12 * 3600000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * Seconds since midnight -> "HH:MM" (or "HH:MM:SS" when seconds aren't zero). Wraps past midnight.
 * With h24 = false: "2:30 PM".
 */
export function formatTimeOfDay(secs, h24 = true) {
  if (secs == null || !Number.isFinite(secs)) return '';
  const s = ((Math.round(secs) % 86400) + 86400) % 86400;
  const p = (n) => String(n).padStart(2, '0');
  const hh = Math.floor(s / 3600);
  const rest = `${p(Math.floor(s / 60) % 60)}${s % 60 ? ':' + p(s % 60) : ''}`;
  if (h24) return `${p(hh)}:${rest}`;
  return `${hh % 12 || 12}:${rest} ${hh >= 12 ? 'PM' : 'AM'}`;
}

/** "+2:15" / "−0:30" style signed difference for seconds (rounded). */
export function formatDelta(secs) {
  const s = Math.round(secs);
  return `${s < 0 ? '−' : '+'}${formatSeconds(Math.abs(s), { padMinutes: false })}`;
}

/**
 * Planned schedule of a rundown, in seconds since midnight (values may exceed 86400 after midnight).
 * A cue's start is its own start time if set, otherwise the previous cue's planned end.
 * End = start + duration, or the target time for "until time" cues.
 * @returns {{start:number|null, end:number|null, explicit:boolean}[]}
 */
export function computeSchedule(rundown) {
  const out = [];
  let prevEnd = null;
  for (const cue of rundown) {
    // Group headings and notes don't take time.
    if (cue.kind && cue.kind !== 'cue') {
      out.push({ start: null, end: null, explicit: false });
      continue;
    }
    const own = parseClockTime(cue.start);
    let start = own ?? prevEnd;
    if (own != null && prevEnd != null) {
      // Keep the timeline moving forward across midnight.
      while (start < prevEnd - 43200) start += 86400;
    }
    let end = null;
    if (cue.mode === 'clock') {
      const target = parseClockTime(cue.target);
      if (target != null) {
        end = target;
        if (start != null) while (end < start) end += 86400;
      }
    } else if (start != null) {
      end = start + Math.round((cue.duration || 0) / 1000);
    }
    out.push({ start, end, explicit: own != null });
    prevEnd = end;
  }
  return out;
}

/** Epoch ms of today's occurrence of a "HH:MM[:SS]" time (local time), or null. */
export function todayAt(str, now) {
  const secs = parseClockTime(str);
  if (secs == null) return null;
  const d = new Date(now);
  d.setHours(Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60, 0);
  return d.getTime();
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
