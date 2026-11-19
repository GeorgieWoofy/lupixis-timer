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
  }

  /** Apply integration settings; (re)starts only what changed. */
  configure(integrations = {}) {
    const key = JSON.stringify(integrations);
    if (key === this.cfgKey) return;
    this.cfgKey = key;
    this.restart('qlab', integrations.qlab, (cfg, onClips, onStatus) => new QLabClient(cfg, onClips, onStatus));
    this.restart('caspar', integrations.caspar, (cfg, onClips, onStatus) => new CasparListener(cfg, onClips, onStatus));
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

  snapshot() {
    return { clips: Object.values(this.clips).flat(), status: { ...this.status } };
  }

  changed() {
    this.emit('change', this.snapshot());
  }

  stop() {
    for (const s of Object.values(this.sources)) s.client.stop();
    this.sources = {};
  }
}
