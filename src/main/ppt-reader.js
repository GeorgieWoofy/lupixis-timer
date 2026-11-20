// Runs ppt-reader.ps1 hidden and turns its output into clip timers.
// Windows only (PowerPoint's automation interface); does nothing elsewhere.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** PowerPoint media item (ms) -> clip timer (seconds), or null if it doesn't pass the filter. */
export function mediaToClip(m, cfg = {}) {
  const filter = cfg.filter || 'video';
  if (filter === 'video' && m.kind !== 'video') return null;
  if (filter === 'tag') {
    const tag = String(cfg.tag || '').toLowerCase();
    if (!tag || !`${m.name} ${m.alt}`.toLowerCase().includes(tag)) return null;
  }
  const start = Math.max(0, m.start || 0);
  const end = m.end > 0 ? m.end : m.len;
  const duration = Math.max(0, end - start);
  if (!(duration > 0)) return null;
  // CurrentPosition is on the file's timeline; treat values before a trimmed start as relative.
  const elapsed = m.pos >= start ? m.pos - start : m.pos;
  return {
    key: `ppt:${m.id}`,
    source: 'ppt',
    name: String(m.name || 'PowerPoint video').replace(/\s*\[[^\]]*\]\s*/g, ' ').trim() || 'PowerPoint video',
    duration: duration / 1000,
    elapsed: Math.max(0, elapsed) / 1000,
    remaining: Math.max(0, duration - elapsed) / 1000,
    paused: m.state === 1,
  };
}

export class PptReader {
  /** @param {(items:object[]) => void} onItems  called with the raw media list whenever it's read */
  constructor(onItems) {
    this.onItems = onItems;
    this.proc = null;
    this.stopped = false;
  }

  start() {
    if (process.platform !== 'win32' || this.proc) return;
    this.stopped = false;
    // Passed inline (-EncodedCommand) so it also works from inside the packaged app (asar).
    const script = fs.readFileSync(path.join(__dirname, 'ppt-reader.ps1'), 'utf8');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    this.proc = proc;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const items = JSON.parse(line);
          this.onItems(Array.isArray(items) ? items : [items]);
        } catch {
          /* ignore partial/odd lines */
        }
      }
    });
    proc.on('error', () => {}); // e.g. PowerShell missing: just no PowerPoint clips (exit handler retries)
    proc.on('exit', () => {
      this.proc = null;
      this.onItems([]);
      if (!this.stopped) this.retry = setTimeout(() => this.start(), 3000); // keep it alive during a show
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.proc?.kill();
    this.proc = null;
  }
}
