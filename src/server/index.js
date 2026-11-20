// HTTP + WebSocket server. Serves the browser views, the REST API and the live state feed.
// Used both by the desktop app (Electron) and by `npm run server` (browser-only mode).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { Engine, ACTION_NAMES } from './engine.js';
import { loadShow, createSaver } from './store.js';
import { startBeacon } from './discovery.js';
import { ClipManager } from './clips.js';
import { timerText } from '../../public/shared/timecalc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const PKG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.csv': 'text/csv; charset=utf-8',
};

// Short, friendly URLs for each view.
const ROUTES = {
  '/controller': 'controller/index.html',
  '/viewer': 'viewer/index.html',
  '/overlay': 'overlay/index.html',
};

const UPLOAD_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm']);

/**
 * Start the server.
 * @param {{port?:number, host?:string, dataDir:string}} opts
 * @returns {Promise<{engine:Engine, port:number, close:()=>Promise<void>, addresses:()=>string[]}>}
 */
export async function startServer({ port = 4848, host = '0.0.0.0', dataDir, announce = false }) {
  const engine = new Engine(loadShow(dataDir));
  const saver = createSaver(dataDir, () => engine.state);
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  // Saved shows: plain JSON files the user can also copy, back up or share.
  const showsDir = path.join(dataDir, 'shows');
  fs.mkdirSync(showsDir, { recursive: true });
  const showFile = (name) => {
    const safe = String(name || '').replace(/[^\p{L}\p{N} _().,&+-]+/gu, '').trim().slice(0, 80);
    if (!safe) throw new Error('Give the show a name');
    return path.join(showsDir, `${safe}.json`);
  };
  const listShows = () =>
    fs.readdirSync(showsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const file = path.join(showsDir, f);
        let cues = 0;
        try {
          cues = (JSON.parse(fs.readFileSync(file, 'utf8')).rundown || []).filter((c) => !c.kind || c.kind === 'cue').length;
        } catch {}
        return { name: f.slice(0, -5), modified: fs.statSync(file).mtimeMs, cues };
      })
      .sort((a, b) => b.modified - a.modified);

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
  });

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    if (p === '/') return redirect(res, '/controller');
    if (ROUTES[p]) return serveFile(res, path.join(PUBLIC_DIR, ROUTES[p]), { noCache: true });
    if (p.startsWith('/api/')) return handleApi(req, res, url, p.slice(5));
    if (p.startsWith('/uploads/')) return serveFile(res, safeJoin(uploadDir, p.slice(9)), { maxAge: 86400 });
    return serveFile(res, safeJoin(PUBLIC_DIR, p.slice(1)), { noCache: true });
  }

  async function handleApi(req, res, url, route) {
    const query = Object.fromEntries(url.searchParams);

    // GET|POST /api/action/<name>?param=value   (or JSON body)
    if (route.startsWith('action/')) {
      const name = route.slice(7);
      const body = req.method === 'POST' ? await readJson(req) : {};
      try {
        engine.dispatch(name, { ...query, ...body });
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    switch (route) {
      case 'state':
        return sendJson(res, 200, { ...engine.snapshot(), computed: tickPayload() });
      case 'timer':
        return sendJson(res, 200, tickPayload());
      case 'actions':
        return sendJson(res, 200, ACTION_NAMES);
      case 'info':
        return sendJson(res, 200, { name: PKG.productName, version: PKG.version, port: actualPort, addresses: addresses(), hostname: os.hostname() });
      case 'locales': {
        const dir = path.join(PUBLIC_DIR, 'locales');
        const list = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
          const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return { code: f.replace('.json', ''), name: data._meta?.name || f };
        });
        return sendJson(res, 200, list);
      }
      case 'qr': {
        const svg = await QRCode.toString(query.text || '', { type: 'svg', margin: 1, width: 200 });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        return res.end(svg);
      }
      case 'upload': {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        const ext = path.extname(query.name || '').toLowerCase();
        if (!UPLOAD_EXT.has(ext)) return sendJson(res, 400, { ok: false, error: 'Unsupported file type' });
        const buf = await readBody(req, 60 * 1024 * 1024);
        const base = path.basename(query.name, ext).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'file';
        const fileName = `${base}-${Date.now().toString(36)}${ext}`;
        fs.writeFileSync(path.join(uploadDir, fileName), buf);
        return sendJson(res, 200, { ok: true, url: `/uploads/${fileName}` });
      }
      case 'show': {
        if (req.method === 'POST') {
          const show = await readJson(req, 20 * 1024 * 1024);
          engine.dispatch('importShow', { show });
          return sendJson(res, 200, { ok: true });
        }
        const s = engine.state;
        const show = { app: PKG.productName, version: 1, exportedAt: new Date().toISOString(), rundown: s.rundown, messagePresets: s.messagePresets, overlay: s.overlay, theme: s.theme, settings: s.settings };
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Content-Disposition': `attachment; filename="show-${dateStamp()}.json"` });
        return res.end(JSON.stringify(show, null, 2));
      }
      // ---- show library: <data folder>/shows/*.json ----
      case 'shows':
        return sendJson(res, 200, listShows());
      case 'shows/save': {
        const { name } = await readJson(req);
        const file = showFile(name);
        const s = engine.state;
        const show = { app: PKG.productName, version: 1, savedAt: new Date().toISOString(), rundown: s.rundown, messagePresets: s.messagePresets, overlay: { ...s.overlay, onAir: false }, theme: s.theme };
        fs.writeFileSync(file, JSON.stringify(show, null, 2));
        engine.state.show = { name: path.basename(file, '.json'), dirty: false };
        engine.emit('change', { persist: true, action: 'saveShow' });
        return sendJson(res, 200, { ok: true, name: engine.state.show.name });
      }
      case 'shows/load': {
        const { name } = await readJson(req);
        const file = showFile(name);
        if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: 'Show not found' });
        const { settings, ...show } = JSON.parse(fs.readFileSync(file, 'utf8')); // settings belong to the computer, not the show
        engine.state.log = []; // a fresh show starts a fresh show report
        engine.dispatch('importShow', { show, name: path.basename(file, '.json') });
        return sendJson(res, 200, { ok: true });
      }
      case 'shows/delete': {
        const { name } = await readJson(req);
        const file = showFile(name);
        if (fs.existsSync(file)) fs.rmSync(file);
        if (engine.state.show?.name === path.basename(file, '.json')) {
          engine.state.show = { name: '', dirty: true };
          engine.emit('change', { persist: true });
        }
        return sendJson(res, 200, { ok: true });
      }
      case 'report.csv': {
        const rows = [['#', 'Title', 'Speaker', 'Planned', 'Actual', 'Difference', 'Started', 'Ended']];
        engine.state.log.forEach((e, i) => {
          const actual = e.actual ?? (e.endedAt ? null : engine.computed().elapsed);
          rows.push([i + 1, e.title, e.speaker, fmtMs(e.planned), fmtMs(actual), actual == null ? '' : (actual > e.planned ? '+' : '-') + fmtMs(Math.abs(actual - e.planned)), fmtTime(e.startedAt), fmtTime(e.endedAt)]);
        });
        const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
        res.writeHead(200, { 'Content-Type': MIME['.csv'], 'Content-Disposition': `attachment; filename="show-report-${dateStamp()}.csv"` });
        return res.end('﻿' + csv); // BOM so Excel opens UTF-8 correctly
      }
      default:
        return sendJson(res, 404, { ok: false, error: 'Unknown API route' });
    }
  }

  // ---- WebSocket ------------------------------------------------------------
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Count connected clients by role (viewer, overlay, floating, controller, companion, preview).
  const recount = () => {
    const counts = {};
    for (const c of wss.clients) counts[c.role] = (counts[c.role] || 0) + 1;
    engine.setClients(counts);
  };

  wss.on('connection', (ws) => {
    ws.role = 'unknown';
    ws.ticks = false;
    send(ws, { t: 'state', state: engine.snapshot() });
    send(ws, { t: 'clips', ...clipManager.snapshot() });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.t === 'ping') return send(ws, { t: 'pong', id: msg.id, c: msg.c, s: Date.now() });
      if (msg.t === 'hello') {
        ws.role = String(msg.role || 'viewer');
        ws.ticks = !!msg.ticks;
        if (ws.ticks) send(ws, { t: 'tick', ...tickPayload() });
        recount();
        return;
      }
      if (msg.t === 'action') {
        try {
          const result = engine.dispatch(msg.name, msg.params);
          if (msg.id != null) send(ws, { t: 'result', id: msg.id, ok: true, result });
        } catch (err) {
          send(ws, { t: 'result', id: msg.id, ok: false, error: err.message });
        }
      }
    });
    ws.on('close', recount);
    ws.on('error', () => {});
  });

  engine.on('change', ({ persist }) => {
    const msg = JSON.stringify({ t: 'state', state: engine.snapshot() });
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
    if (persist) {
      saver.schedule();
      clipManager.configure(engine.state.settings.integrations);
    }
    lastTick = ''; // force a fresh tick for integrations
  });

  // ---- clip timers from QLab / CasparCG (sent separately: they change several times a second) ----
  const clipManager = new ClipManager();
  let clipTimer = null;
  clipManager.on('change', () => {
    if (clipTimer) return;
    clipTimer = setTimeout(() => {
      clipTimer = null;
      const msg = JSON.stringify({ t: 'clips', ...clipManager.snapshot() });
      for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
    }, 150);
  });
  clipManager.configure(engine.state.settings.integrations);

  // Integrations (Companion, scripts) get pre-formatted time values whenever they change.
  let lastTick = '';
  function tickPayload() {
    const s = engine.state;
    const c = engine.computed();
    const cues = engine.cues(); // group headings and notes don't count
    const i = engine.currentCueIndex();
    const cue = cues[i];
    const next = cues[i + 1];
    return {
      loaded: c.loaded,
      running: c.running,
      mode: c.mode,
      phase: c.phase,
      overtime: c.overtime,
      display: timerText(c),
      remaining: c.loaded && c.mode !== 'countup' ? timerText({ ...c, mode: 'countdown' }) : '',
      elapsed: c.loaded ? timerText({ ...c, mode: 'countup', elapsed: Math.max(0, c.elapsed) }) : '',
      remainingSeconds: c.loaded ? Math.ceil(c.remaining / 1000) : 0,
      elapsedSeconds: c.loaded ? Math.floor(c.elapsed / 1000) : 0,
      progress: Math.round(c.progress * 100),
      cueIndex: i + 1,
      cueCount: cues.length,
      cueTitle: cue?.title || '',
      cueSpeaker: cue?.speaker || '',
      nextTitle: next?.title || '',
      ...clipTick(),
    };
  }
  function clipTick() {
    const clip = clipManager.snapshot().clips[0];
    if (!clip) return { clipName: '', clipRemaining: '', clipRemainingSeconds: 0 };
    const rem = clip.paused ? clip.remaining : Math.max(0, clip.remaining - (Date.now() - clip.at) / 1000);
    const s = Math.ceil(rem);
    return { clipName: clip.name, clipRemaining: `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`, clipRemainingSeconds: s };
  }
  const tickInterval = setInterval(() => {
    const payload = tickPayload();
    const json = JSON.stringify(payload);
    if (json === lastTick) return;
    lastTick = json;
    const msg = JSON.stringify({ t: 'tick', ...payload });
    for (const ws of wss.clients) if (ws.ticks && ws.readyState === 1) ws.send(msg);
  }, 100);

  // ---- listen (falls back to the next free port) ----------------------------
  let actualPort = port;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(actualPort, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt === 9) throw err;
      actualPort++;
    }
  }

  function addresses() {
    const list = [];
    for (const ifs of Object.values(os.networkInterfaces())) {
      for (const a of ifs || []) if (a.family === 'IPv4' && !a.internal) list.push(a.address);
    }
    // Real LAN addresses first; 169.254.x.x (no DHCP) last, since other devices usually can't reach it.
    const rank = (ip) => (ip.startsWith('169.254.') ? 2 : /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(ip) ? 0 : 1);
    return list.sort((a, b) => rank(a) - rank(b));
  }

  // Let other Lupixis Timer apps on the network find this one.
  const beacon = announce ? startBeacon({ port: actualPort, version: PKG.version }) : null;

  return {
    engine,
    port: actualPort,
    addresses,
    beacon,
    showsDir,
    async close() {
      beacon?.stop();
      clipManager.stop();
      clearInterval(tickInterval);
      engine.destroy();
      saver.flush();
      for (const ws of wss.clients) ws.terminate();
      server.closeAllConnections?.(); // don't wait for idle keep-alive connections
      await new Promise((r) => server.close(r));
    },
  };
}

// ---- helpers -----------------------------------------------------------------

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function sendJson(res, status, obj) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function redirect(res, to) {
  res.writeHead(302, { Location: to }).end();
}

function safeJoin(root, rel) {
  const full = path.resolve(root, rel);
  return full.startsWith(path.resolve(root) + path.sep) ? full : null;
}

function serveFile(res, file, { noCache = false, maxAge = 0 } = {}) {
  if (!file) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { ok: false, error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': noCache ? 'no-cache' : `max-age=${maxAge}`,
    });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

const pad = (n) => String(n).padStart(2, '0');
function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtMs(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
