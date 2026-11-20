// Collects "clip timers" (video/audio playing in QLab or CasparCG) and reports them to the server,
// which forwards them to every screen. Restarts the integrations whenever their settings change.
import { EventEmitter } from 'node:events';
import { QLabClient } from './integrations/qlab.js';
import { CasparListener } from './integrations/caspar.js';

export class ClipManager extends EventEmitter {
  constructor() {
    super();
    this.sources = {}; // name -> client
    this.clips = {}; // name -> clip list
    this.status = {}; // name -> text
    this.cfgKey = '';
    this.external = new Map(); // clips pushed in by desktop apps (PowerPoint)
    // Drop pushed-in clips whose sender went quiet (laptop closed, app quit).
    this.pruneTimer = setInterval(() => {
      if (!this.external?.size) return;
      const before = this.external.size;
      this.pruneExternal();
      if (this.external.size !== before) this.changed();
    }, 1000);
    this.pruneTimer.unref?.();
  }

  /** Apply integration settings; (re)starts only what changed. */
  configure(integrations = {}) {
    const key = JSON.stringify(integrations);
    if (key === this.cfgKey) return;
    this.cfgKey = key;
    this.restart('qlab', integrations.qlab, (cfg, onClips, onStatus) => new QLabClient(cfg, onClips, onStatus));
    this.restart('caspar', integrations.caspar, (cfg, onClips, onStatus) => new CasparListener(cfg, onClips, onStatus));
    // PowerPoint is read by the desktop app(s) and pushed in (setExternal); here we only track on/off.
    this.pptEnabled = !!integrations.ppt?.enabled;
    if (!this.pptEnabled) {
      this.status.ppt = 'off';
      for (const k of this.external?.keys() || []) if (k.startsWith('ppt:')) this.external.delete(k);
    }
    this.pruneExternal();
    this.changed();
  }

  restart(name, cfg, create) {
    const sig = JSON.stringify(cfg || {});
    if (this.sources[name]?.sig === sig) return;
    this.sources[name]?.client.stop();
    delete this.sources[name];
    this.clips[name] = [];
    if (!cfg?.enabled) {
      this.status[name] = 'off';
      return this.changed();
    }
    const client = create(
      cfg,
      (clips) => {
        this.clips[name] = clips;
        this.changed();
      },
      (status) => {
        this.status[name] = status;
        this.changed();
      },
    );
    this.sources[name] = { client, sig };
  }

  /**
   * Clips pushed in from outside (PowerPoint, read by the desktop app on the presenting computer).
   * Each sender reports its full list about 3x per second; a sender that goes quiet for 3 s is dropped.
   */
  setExternal(source, sender, clips) {
    this.external ??= new Map();
    const now = Date.now();
    const list = (clips || []).slice(0, 10).map((c) => ({
      key: `${source}:${sender}:${String(c.key || c.name)}`,
      source,
      name: String(c.name || 'Clip').slice(0, 120),
      duration: Math.max(0, Number(c.duration) || 0),
      elapsed: Math.max(0, Number(c.elapsed) || 0),
      remaining: Math.max(0, Number(c.remaining) || 0),
      paused: !!c.paused,
      at: now, // stamped here, so every screen counts down on the server's clock
    }));
    this.external.set(`${source}:${sender}`, { source, sender, clips: list, seen: now });
    this.pruneExternal();
    this.changed();
  }

  pruneExternal() {
    if (!this.external) return;
    const now = Date.now();
    for (const [k, v] of this.external) if (now - v.seen > 3000) this.external.delete(k);
    if (this.pptEnabled) {
      const senders = [...this.external.values()].filter((v) => v.source === 'ppt').map((v) => v.sender);
      this.status.ppt = senders.length ? `Watching PowerPoint on ${senders.join(', ')}` : 'Waiting for the desktop app on the presenting computer';
    }
  }

  snapshot() {
    this.pruneExternal();
    const external = this.external ? [...this.external.values()].flatMap((v) => v.clips) : [];
    return { clips: [...Object.values(this.clips).flat(), ...external], status: { ...this.status } };
  }

  changed() {
    this.emit('change', this.snapshot());
  }

  stop() {
    clearInterval(this.pruneTimer);
    for (const s of Object.values(this.sources)) s.client.stop();
    this.sources = {};
  }
}
