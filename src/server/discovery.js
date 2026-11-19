// Find Lupixis Timer machines on the local network without typing IP addresses.
// Every machine running the timer server broadcasts a small UDP "beacon" every 2 s on port 4849;
// the desktop app listens and lists what it hears. No internet, no extra dependencies.
import dgram from 'node:dgram';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const DISCOVERY_PORT = 4849;
const MAGIC = 'lupixis-timer';

/** Broadcast addresses of every IPv4 interface (plus the global one). */
function broadcastAddresses() {
  const list = new Set(['255.255.255.255']);
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const a of ifs || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      list.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...list];
}

/**
 * Start announcing this timer. Returns { id, stop() }.
 * @param {{port:number, name?:string, version?:string}} info
 */
export function startBeacon({ port, name = os.hostname(), version = '' }) {
  const id = randomUUID();
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let timer = null;
  let enabled = true;
  sock.on('error', () => {}); // a busy network must never crash the timer
  sock.bind(() => {
    try {
      sock.setBroadcast(true);
    } catch {}
    const send = () => {
      if (!enabled) return;
      const msg = Buffer.from(JSON.stringify({ app: MAGIC, id, name, port, version }));
      for (const addr of broadcastAddresses()) sock.send(msg, DISCOVERY_PORT, addr, () => {});
    };
    send();
    timer = setInterval(send, 2000);
  });
  return {
    id,
    setEnabled(v) {
      enabled = v;
    },
    stop() {
      clearInterval(timer);
      try {
        sock.close();
      } catch {}
    },
  };
}

/**
 * Listen for beacons. `onChange(list)` gets the current list of timers seen in the last 7 s:
 * [{ id, name, host, port, version, url }]
 */
export function startListener(onChange) {
  const seen = new Map();
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const emit = () => onChange([...seen.values()].map(({ lastSeen, ...rest }) => rest));
  sock.on('error', () => {});
  sock.on('message', (buf, rinfo) => {
    let m;
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (m.app !== MAGIC || !m.id || !m.port) return;
    const isNew = !seen.has(m.id);
    // The same machine may be heard on several interfaces; keep the first address.
    const prev = seen.get(m.id);
    const host = prev?.host || rinfo.address;
    seen.set(m.id, { id: m.id, name: String(m.name || host), host, port: m.port, version: m.version || '', url: `http://${host}:${m.port}`, lastSeen: Date.now() });
    if (isNew) emit();
  });
  sock.bind(DISCOVERY_PORT);
  const prune = setInterval(() => {
    let changed = false;
    for (const [id, t] of seen) if (Date.now() - t.lastSeen > 7000) seen.delete(id), (changed = true);
    if (changed) emit();
  }, 2000);
  return {
    list: () => [...seen.values()],
    stop() {
      clearInterval(prune);
      try {
        sock.close();
      } catch {}
    },
  };
}
