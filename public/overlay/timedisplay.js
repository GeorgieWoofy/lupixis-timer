// Animated time display for the broadcast graphic.
// Renders hours / minutes / seconds as separate segments so that:
//  - digits can roll (new digit pushes the old one down, with a fade) or cross-fade when they change,
//  - one segment can be coloured with the accent colour (e.g. only the seconds),
//  - the leading zero can be dropped ("5:07"),
//  - hours (and optionally minutes) collapse away with an animation once they are no longer needed.

const ANIM_MS = 380;

export class TimeDisplay {
  constructor(el) {
    this.el = el;
    el.classList.add('td');
    el.innerHTML =
      '<span class="td-text"></span>' +
      '<span class="td-sign"></span>' +
      '<span class="seg seg-h"><span class="digits"></span><span class="sep">:</span></span>' +
      '<span class="seg seg-m"><span class="digits"></span><span class="sep">:</span></span>' +
      '<span class="seg seg-s"><span class="digits"></span></span>';
    this.text = el.querySelector('.td-text');
    this.sign = el.querySelector('.td-sign');
    this.segs = { h: el.querySelector('.seg-h'), m: el.querySelector('.seg-m'), s: el.querySelector('.seg-s') };
    this.last = {};
  }

  /** Show free text instead of digits (e.g. "We're live!" or "--:--"). */
  showText(str) {
    this.el.classList.add('as-text');
    if (this.text.textContent !== str) this.text.textContent = str;
  }

  /**
   * @param {number} totalSeconds whole seconds to show
   * @param {{sign?:string, anim?:'slide'|'fade'|'none', leadingZero?:boolean, hideZeroMinutes?:boolean, highlight?:string}} o
   */
  show(totalSeconds, o = {}) {
    this.el.classList.remove('as-text');
    const t = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const showH = h > 0;
    const showM = showH || m > 0 || !o.hideZeroMinutes;
    const lead = o.leadingZero !== false;
    const pad = (n, first) => (first && !lead ? String(n) : String(n).padStart(2, '0'));

    const vals = {
      h: String(h),
      m: pad(m, !showH),
      s: pad(s, !showH && !showM),
    };
    this.el.dataset.highlight = o.highlight || 'none';
    if (this.sign.textContent !== (o.sign || '')) this.sign.textContent = o.sign || '';
    this.segs.h.classList.toggle('gone', !showH);
    this.segs.m.classList.toggle('gone', !showM);
    // The separator after minutes belongs to minutes; hide it too when minutes are gone.
    for (const k of ['h', 'm', 's']) this.setDigits(this.segs[k], vals[k], o.anim || 'none');
  }

  setDigits(seg, str, anim) {
    const box = seg.firstChild;
    const slots = box.children;
    if (slots.length !== str.length) {
      // Digit count changed (e.g. 10 -> 9 without leading zero): rebuild without animation.
      box.replaceChildren(...[...str].map((ch) => slot(ch)));
      return;
    }
    [...str].forEach((ch, i) => {
      const cur = slots[i].querySelector('.d.cur');
      if (cur.textContent === ch) return;
      if (anim === 'none' || seg.classList.contains('gone')) {
        cur.textContent = ch;
        return;
      }
      // Old digit leaves (down + fade), new digit arrives (from above + fade in).
      cur.classList.remove('cur', 'in');
      cur.classList.add('out', `a-${anim}`);
      setTimeout(() => cur.remove(), ANIM_MS);
      const d = document.createElement('span');
      d.className = `d cur in a-${anim}`;
      d.textContent = ch;
      slots[i].append(d);
    });
  }
}

function slot(ch) {
  const el = document.createElement('span');
  el.className = 'slot';
  const d = document.createElement('span');
  d.className = 'd cur';
  d.textContent = ch;
  el.append(d);
  return el;
}
