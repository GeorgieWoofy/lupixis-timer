// CasparCG clip timers. CasparCG sends OSC over UDP for every playing layer, once per frame:
//   2.1+/2.3:  /channel/1/stage/layer/10/foreground/file/time  [elapsed, total]
//              /channel/1/stage/layer/10/foreground/file/name  "clip.mp4"   (or .../file/path)
//   2.0.x:     /channel/1/stage/layer/10/file/time [elapsed, total], /file/path
// In casparcg.config add this computer under <osc><predefined-clients> with the port set here (default 6250).
import dgram from 'node:dgram';
import { decodePacket } from '../osc.js';

const LAYER_RE = /^\/channel\/(\d+)\/stage\/layer\/(\d+)\/(?:foreground\/)?(file\/time|file\/name|file\/path|paused)$/;
const STALE_MS = 1000; // no message for this long = the clip stopped

/** "1-10, 1-20, 2-5" -> Set of "channel-layer" keys */
function parseLayers(str) {
  return new Set(String(str || '').split(/[\s,;]+/).map((x) => x.trim().replace(/[:/.]/, '-')).filter(Boolean));
}

export class CasparListener {
  /**
   * @param {{port?:number, filter:'all'|'layers'|'tag', layers?:string, tag?:string}} cfg
   */
  constructor(cfg, onClips, onStatus) {
    this.cfg = cfg;
    this.onClips = onClips;
    this.onStatus = onStatus;
    this.layers = new Map(); // "1-10" -> { name, elapsed, total, paused, seen }
    this.lastKey = '';
    this.layerFilter = parseLayers(cfg.layers);
    const port = cfg.port || 6250;
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock.on('error', (err) => onStatus(`CasparCG: ${err.message}`));
    this.sock.on('message', (buf) => {
      for (const msg of decodePacket(buf)) this.onMessage(msg);
    });
    this.sock.bind(port, () => onStatus(`Listening for CasparCG OSC on port ${port}`));
    this.timer = setInterval(() => this.flush(), 200);
  }

  onMessage({ address, args }) {
    const m = LAYER_RE.exec(address);
    if (!m) return;
    const key = `${m[1]}-${m[2]}`;
    const l = this.layers.get(key) || { name: '', elapsed: 0, total: 0, paused: false, seen: 0 };
    if (m[3] === 'file/time') {
      l.elapsed = Number(args[0]) || 0;
      l.total = Number(args[1]) || 0;
      l.seen = Date.now();
    } else if (m[3] === 'paused') l.paused = !!args[0];
    else l.name = String(args[0] || '').split(/[\\/]/).pop();
    this.layers.set(key, l);
  }

  matches(key, l) {
    const f = this.cfg.filter || 'all';
    if (f === 'layers') return this.layerFilter.has(key);
    if (f === 'tag') return !!this.cfg.tag && l.name.toLowerCase().includes(String(this.cfg.tag).toLowerCase());
    return true;
  }

  flush() {
    const now = Date.now();
    const clips = [];
    for (const [key, l] of this.layers) {
      if (now - l.seen > STALE_MS) {
        this.layers.delete(key);
        continue;
      }
      if (l.total <= 0 || !this.matches(key, l)) continue;
      clips.push({
        key: `caspar:${key}`,
        source: 'caspar',
        name: l.name || `Layer ${key}`,
        duration: l.total,
        elapsed: l.elapsed,
        remaining: Math.max(0, l.total - l.elapsed),
        paused: l.paused,
        at: l.seen,
      });
    }
    // Only report when something visible changed (whole seconds), not every frame.
    const sig = JSON.stringify(clips.map((c) => [c.key, c.name, Math.ceil(c.remaining), c.paused]));
    if (sig !== this.lastKey) {
      this.lastKey = sig;
      this.onClips(clips);
    }
  }

  stop() {
    clearInterval(this.timer);
    try {
      this.sock.close();
    } catch {}
  }
}
