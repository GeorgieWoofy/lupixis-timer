// QLab (4 and 5) clip timers over OSC/TCP (port 53000, SLIP framing).
// Every 250 ms we ask QLab which cues are running, then ask each one for its elapsed time and duration.
// Only cues that match the filter (cue colour, or a tag in the name/notes) are shown to speakers.
import net from 'node:net';
import { encodeMessage, decodePacket, slipEncode, slipDecoder } from '../osc.js';

const POLL_MS = 250;
const KEYS = ['uniqueID', 'number', 'name', 'type', 'colorName', 'notes', 'actionElapsed', 'duration', 'isPaused'];

export class QLabClient {
  /**
   * @param {{host:string, port?:number, passcode?:string, filter:'color'|'tag'|'all', color?:string, tag?:string}} cfg
   * @param {(clips:object[]) => void} onClips
   * @param {(status:string) => void} onStatus
   */
  constructor(cfg, onClips, onStatus) {
    this.cfg = cfg;
    this.onClips = onClips;
    this.onStatus = onStatus;
    this.clips = new Map();
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    const { host, port = 53000 } = this.cfg;
    if (!host) return this.onStatus('Set the QLab computer\'s IP address');
    this.onStatus(`Connecting to ${host}:${port}…`);
    const sock = net.connect({ host, port });
    this.sock = sock;
    sock.setNoDelay(true);
    sock.setTimeout(5000);
    const feed = slipDecoder((pkt) => {
      for (const msg of decodePacket(pkt)) this.onMessage(msg);
    });
    sock.on('connect', () => {
      sock.setTimeout(0);
      this.onStatus(`Connected to QLab at ${host}`);
      if (this.cfg.passcode) this.send('/connect', [String(this.cfg.passcode)]);
      this.poll = setInterval(() => this.send('/runningOrPausedCues'), POLL_MS);
    });
    sock.on('data', feed);
    sock.on('timeout', () => sock.destroy(new Error('timed out')));
    sock.on('error', (err) => this.onStatus(`QLab: ${err.message}`));
    sock.on('close', () => {
      clearInterval(this.poll);
      this.clips.clear();
      this.onClips([]);
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 3000);
    });
  }

  send(address, args = []) {
    if (this.sock?.writable) this.sock.write(slipEncode(encodeMessage(address, args)));
  }

  onMessage({ address, args }) {
    if (!address.startsWith('/reply/')) return;
    let reply;
    try {
      reply = JSON.parse(args[0]);
    } catch {
      return;
    }
    if (reply.status && reply.status !== 'ok') {
      if (/connect/.test(address)) this.onStatus(`QLab refused the passcode (${reply.status})`);
      return;
    }
    if (address.endsWith('/runningOrPausedCues')) {
      const running = Array.isArray(reply.data) ? reply.data : [];
      const ids = new Set(running.map((c) => c.uniqueID));
      // Forget cues that stopped.
      let changed = false;
      for (const id of this.clips.keys()) if (!ids.has(id)) this.clips.delete(id), (changed = true);
      if (changed) this.emit();
      for (const c of running) {
        if (c.type === 'Group' || c.type === 'Cue List' || c.type === 'Cart') continue;
        this.send(`/cue_id/${c.uniqueID}/valuesForKeys`, [JSON.stringify(KEYS)]);
      }
    } else if (/\/cue_id\/[^/]+\/valuesForKeys$/.test(address)) {
      const d = reply.data || {};
      const id = d.uniqueID || address.split('/')[3];
      if (!this.matches(d)) {
        if (this.clips.delete(id)) this.emit();
        return;
      }
      const duration = Number(d.duration) || 0;
      const elapsed = Number(d.actionElapsed) || 0;
      if (duration <= 0) return; // nothing to count down
      this.clips.set(id, {
        key: `qlab:${id}`,
        source: 'qlab',
        name: d.name || d.number || 'QLab cue',
        duration,
        elapsed,
        remaining: Math.max(0, duration - elapsed),
        paused: !!d.isPaused,
        at: Date.now(),
      });
      this.emit();
    }
  }

  matches(d) {
    const f = this.cfg.filter || 'color';
    if (f === 'all') return true;
    if (f === 'color') return String(d.colorName || '').toLowerCase() === String(this.cfg.color || 'red').toLowerCase();
    const tag = String(this.cfg.tag || '').toLowerCase();
    return !!tag && `${d.name || ''} ${d.notes || ''}`.toLowerCase().includes(tag);
  }

  emit() {
    this.onClips([...this.clips.values()]);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.poll);
    clearTimeout(this.retry);
    this.sock?.destroy();
  }
}
