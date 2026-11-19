// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTimer, timerText, parseDuration, nextClockTime, emptyTimer, computeSchedule, formatTimeOfDay } from '../public/shared/timecalc.js';

test('schedule chains start/end times and follows explicit starts', () => {
  const sched = computeSchedule([
    { start: '09:00', mode: 'countdown', duration: 30 * 60000 },
    { start: '', mode: 'countdown', duration: 15 * 60000 },
    { start: '10:00', mode: 'countdown', duration: 60 * 60000 },
    { start: '', mode: 'clock', target: '11:30' },
  ]);
  assert.deepEqual(sched.map((s) => [formatTimeOfDay(s.start), formatTimeOfDay(s.end), s.explicit]), [
    ['09:00', '09:30', true],
    ['09:30', '09:45', false],
    ['10:00', '11:00', true],
    ['11:00', '11:30', false],
  ]);
  // No start anywhere: nothing can be computed.
  assert.equal(computeSchedule([{ start: '', mode: 'countdown', duration: 1000 }])[0].end, null);
});

test('engine starts a cue by itself at its start time, anchored to that time', () => {
  const e = new Engine();
  try {
    const at = new Date(Date.now() - 3000); // 3 s ago: inside the 10 s window
    const hhmmss = [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    e.dispatch('replaceRundown', { rundown: [{ title: 'A', duration: 60000 }, { title: 'B', duration: 60000, start: hhmmss }] });
    e.tick();
    assert.equal(e.currentCue().title, 'B');
    assert.equal(e.state.timer.running, true);
    assert.ok(e.computed().elapsed >= 2500, 'countdown counts from the scheduled time');
    e.dispatch('pause');
    e.tick(); // must not fire twice
    assert.equal(e.state.timer.running, false);
  } finally {
    e.destroy();
  }
});
import { Engine } from '../src/server/engine.js';

test('parseDuration understands minutes, M:SS, H:MM:SS and units', () => {
  assert.equal(parseDuration('5'), 300000);
  assert.equal(parseDuration('4:30'), 270000);
  assert.equal(parseDuration('1:00:00'), 3600000);
  assert.equal(parseDuration('90s'), 90000);
  assert.equal(parseDuration('1.5'), 90000);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration(''), null);
});

test('countdown rounds up, overtime counts with +, hold freezes at zero', () => {
  const t = { ...emptyTimer(), cueId: 'a', duration: 60000, running: true, startedAt: 0 };
  assert.equal(timerText(computeTimer(t, 500)), '01:00');
  assert.equal(timerText(computeTimer(t, 59500)), '00:01');
  const over = computeTimer(t, 75000);
  assert.equal(over.phase, 'overtime');
  assert.equal(timerText(over), '+00:15');
  assert.equal(timerText(over, 'hold'), '00:00');
});

test('phases follow warning/critical thresholds', () => {
  const t = { ...emptyTimer(), cueId: 'a', duration: 300000, warning: 120000, critical: 30000, running: true, startedAt: 0 };
  assert.equal(computeTimer(t, 0).phase, 'normal');
  assert.equal(computeTimer(t, 200000).phase, 'warning');
  assert.equal(computeTimer(t, 280000).phase, 'critical');
});

test('nextClockTime picks today, or tomorrow when far in the past', () => {
  const now = new Date(2026, 10, 18, 23, 30).getTime();
  assert.equal(new Date(nextClockTime('00:30', now)).getDate(), 19);
  const evening = new Date(2026, 10, 18, 19, 5).getTime();
  assert.equal(nextClockTime('19:00', evening), new Date(2026, 10, 18, 19, 0).getTime()); // 5 min overtime
});

test('engine: start, pause, add time, next and auto-load', () => {
  const e = new Engine();
  try {
    e.dispatch('replaceRundown', { rundown: [{ title: 'A', duration: 60000 }, { title: 'B', duration: 120000 }] });
    assert.equal(e.currentCue().title, 'A');
    e.dispatch('start');
    assert.equal(e.state.timer.running, true);
    e.dispatch('pause');
    assert.equal(e.state.timer.running, false);
    e.dispatch('addTime', { seconds: 30 });
    assert.equal(e.state.timer.duration, 90000);
    e.dispatch('next');
    assert.equal(e.currentCue().title, 'B');
    assert.equal(e.state.timer.running, false);
    e.dispatch('startNext'); // no cue after B: stays on B
    assert.equal(e.currentCue().title, 'B');
    assert.throws(() => e.dispatch('nope'));
  } finally {
    e.destroy();
  }
});

test('engine: messages and presets', () => {
  const e = new Engine();
  try {
    e.dispatch('showPreset', { index: 1, color: 'red' });
    assert.equal(e.state.message.visible, true);
    assert.equal(e.state.message.text, e.state.messagePresets[0]);
    assert.equal(e.state.message.color, 'red');
    e.dispatch('toggleMessage');
    assert.equal(e.state.message.visible, false);
  } finally {
    e.destroy();
  }
});
