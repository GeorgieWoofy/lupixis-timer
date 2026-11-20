// Desktop app shell (Electron). Runs the same server as browser mode, then adds what a browser can't do:
// the always-on-top floating timer, fullscreen outputs on other monitors, system-wide hotkeys,
// and "connect to another timer" so several laptops can follow one main timer.
import { app, BrowserWindow, screen, globalShortcut, dialog, shell, Menu, ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';
import { startListener } from '../server/discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(__dirname, '../../build/icon.png');
const PRELOAD = path.join(__dirname, 'preload.cjs');

// Optional separate profile (own settings/show/port lock), e.g. for testing next to an installed copy:
//   set LUPIXIS_PROFILE_DIR=C:\temp\lupixis-test && npm start
if (process.env.LUPIXIS_PROFILE_DIR) app.setPath('userData', path.resolve(process.env.LUPIXIS_PROFILE_DIR));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let srv; // this computer's own timer server (always running)
let localBase; // http://localhost:<port>
let remote = null; // { url, name } when following a timer on another computer
let controllerWin = null;
let floatingWin = null;
const outputs = new Map(); // "view@displayId" -> BrowserWindow
let discovered = []; // timers heard on the network
let listener = null;
let quitting = false;

/** The timer everything on this computer currently shows: our own, or the one we're connected to. */
const activeBase = () => remote?.url || localBase;

// ---- small persisted window prefs ----
const prefsFile = () => path.join(app.getPath('userData'), 'window-state.json');
function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writePrefs(patch) {
  try {
    fs.writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), ...patch }, null, 2));
  } catch {}
}

const winIcon = () => (fs.existsSync(ICON) ? ICON : undefined);

// ---- settings of the active timer (ours, or the remote one) ----
let activeSettings = null;
const settings = () => (remote ? activeSettings : srv?.engine.state.settings) || {};
let remotePoll = null;
async function pollRemoteSettings() {
  if (!remote) return;
  try {
    const s = await fetchJson(`${remote.url}/api/state`, 2500);
    activeSettings = s.settings;
    remote.ok = true;
    onSettingsChanged();
  } catch {
    if (remote) remote.ok = false;
  }
  sendUpdate();
}

function onSettingsChanged() {
  registerHotkeys();
  applyFloatingOpacity();
}

/** Run an action on the active timer (used by hotkeys). */
async function dispatch(name, params = {}) {
  if (name === 'app') return handleCommand(params);
  if (!remote) return srv.engine.dispatch(name, params);
  await fetch(`${remote.url}/api/action/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
}

// ---- controller ----
function createController() {
  const prefs = readPrefs().controller || {};
  controllerWin = new BrowserWindow({
    width: prefs.width || 1440,
    height: prefs.height || 900,
    x: prefs.x,
    y: prefs.y,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#1c1d1f',
    title: 'Lupixis Timer',
    icon: winIcon(),
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD },
  });
  if (prefs.maximized) controllerWin.maximize();
  controllerWin.loadURL(`${activeBase()}/controller`);
  devtoolsShortcut(controllerWin);
  openLinksExternally(controllerWin);
  // If the remote timer disappears, the page can't load: fall back to our own timer.
  controllerWin.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && remote && url.startsWith(remote.url)) {
      dialog.showMessageBox(controllerWin, { type: 'warning', message: `Could not reach ${remote.name}`, detail: 'Switching back to this computer\'s own timer.' });
      disconnect();
    }
  });

  controllerWin.on('close', (e) => {
    if (quitting) return;
    const choice = dialog.showMessageBoxSync(controllerWin, {
      type: 'question',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Quit Lupixis Timer?',
      message: 'Quit Lupixis Timer?',
      detail: 'All timer outputs, the floating window and browser/OBS connections will stop.',
    });
    if (choice !== 0) return e.preventDefault();
    writePrefs({ controller: { ...controllerWin.getNormalBounds(), maximized: controllerWin.isMaximized() }, reconnect: remote ? { url: remote.url, name: remote.name } : null });
    quitting = true;
    app.quit();
  });
}

// ---- floating always-on-top timer ----
function openFloating() {
  if (floatingWin && !floatingWin.isDestroyed()) {
    if (floatingWin.isMinimized()) floatingWin.restore();
    return floatingWin.show();
  }
  const saved = readPrefs().floating;
  const visible = saved && screen.getAllDisplays().some((d) => rectInside(saved, d.workArea));
  const wa = screen.getPrimaryDisplay().workArea;
  const bounds = visible ? saved : { width: 300, height: 140, x: wa.x + wa.width - 320, y: wa.y + 20 };

  floatingWin = new BrowserWindow({
    ...bounds,
    minWidth: 120,
    minHeight: 50,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    maximizable: false,
    minimizable: true, // the control bar has a minimise button; restore from the taskbar
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: true,
    backgroundColor: '#000000',
    title: 'Lupixis Timer – floating timer',
    icon: winIcon(),
    webPreferences: { preload: PRELOAD },
  });
  // 'screen-saver' is the highest level: stays above PowerPoint's fullscreen slideshow/presenter view.
  floatingWin.setAlwaysOnTop(true, 'screen-saver');
  floatingWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // macOS spaces
  floatingWin.loadURL(`${activeBase()}/viewer?compact=1&floating=1`);
  applyFloatingOpacity();
  const save = () => floatingWin && !floatingWin.isDestroyed() && writePrefs({ floating: floatingWin.getBounds() });
  floatingWin.on('moved', save);
  floatingWin.on('resized', save);
  floatingWin.on('closed', () => {
    stopDrag();
    floatingWin = null;
    updateHost();
  });
  updateHost();
}

function closeFloating() {
  if (floatingWin && !floatingWin.isDestroyed()) floatingWin.close();
}

function applyFloatingOpacity() {
  if (!floatingWin || floatingWin.isDestroyed()) return;
  const o = Number(settings().floating?.opacity) || 1;
  floatingWin.setOpacity(Math.min(1, Math.max(0.3, o)));
}

// Dragging the frameless floating window: the page reports mouse down/up and we follow the cursor.
// (CSS drag regions would block hover and clicks on Windows.)
let drag = null;
function stopDrag() {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  if (floatingWin && !floatingWin.isDestroyed()) writePrefs({ floating: floatingWin.getBounds() });
}
ipcMain.on('floating:drag-start', () => {
  if (!floatingWin || floatingWin.isDestroyed()) return;
  stopDrag();
  const c = screen.getCursorScreenPoint();
  const b = floatingWin.getBounds();
  const started = Date.now();
  drag = {
    timer: setInterval(() => {
      if (!floatingWin || floatingWin.isDestroyed() || Date.now() - started > 60000) return stopDrag();
      const p = screen.getCursorScreenPoint();
      floatingWin.setBounds({ x: b.x + p.x - c.x, y: b.y + p.y - c.y, width: b.width, height: b.height });
    }, 10),
  };
});
ipcMain.on('floating:drag-end', stopDrag);
ipcMain.on('floating:minimize', () => {
  stopDrag();
  floatingWin?.minimize();
});
ipcMain.on('floating:close', () => closeFloating());
// Esc pressed inside a fullscreen output page closes that output (only output windows, never the controller).
ipcMain.on('output:close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && [...outputs.values()].includes(win)) win.close();
});

// Some fullscreen apps (PowerPoint included) grab the top spot when they start a slideshow.
// Re-asserting every couple of seconds keeps the floating timer visible without stealing focus.
setInterval(() => {
  if (!floatingWin || floatingWin.isDestroyed() || floatingWin.isMinimized() || drag) return;
  if (settings().floatingKeepOnTop === false) return;
  floatingWin.setAlwaysOnTop(true, 'screen-saver');
  floatingWin.moveTop();
}, 2000);

// ---- fullscreen outputs ----
function openOutput(displayId, view) {
  const key = `${view}@${displayId}`;
  if (outputs.has(key)) return outputs.get(key).focus();
  const display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
  if (!display) throw new Error('Display not found');
  // One output per display: replace anything already shown there.
  for (const [k, w] of outputs) if (k.endsWith(`@${displayId}`)) w.close();

  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow({
    x, y, width, height,
    frame: false,
    fullscreen: true,
    backgroundColor: '#000000',
    title: `Lupixis Timer – ${view}`,
    icon: winIcon(),
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD },
  });
  win.setMenu(null);
  win.view = view;
  win.loadURL(outputUrl(view));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') win.close(); // Esc closes a fullscreen output
  });
  win.on('closed', () => {
    outputs.delete(key);
    updateHost();
  });
  outputs.set(key, win);
  updateHost();
}
const outputUrl = (view) => (view === 'overlay' ? `${activeBase()}/overlay?bg=black` : `${activeBase()}/viewer`);

function closeOutput(displayId, view) {
  outputs.get(`${view}@${displayId}`)?.close();
}

// ---- screen takeover (like a dedicated timer box) ----
// Per-computer setting: fill every secondary screen with the confidence monitor or the broadcast graphic,
// on start and whenever a screen is plugged in. Unplugged screens close their output instead of jumping
// onto the main screen.
const takeover = () => readPrefs().takeover || 'none'; // none | viewer | overlay
function applyTakeover() {
  const view = takeover();
  if (view === 'none') return;
  const primary = screen.getPrimaryDisplay().id;
  for (const d of screen.getAllDisplays()) {
    if (d.id === primary) continue;
    const busy = [...outputs.keys()].some((k) => k.endsWith(`@${d.id}`));
    if (!busy) openOutput(String(d.id), view);
  }
}
function closeOrphanOutputs() {
  const ids = new Set(screen.getAllDisplays().map((d) => String(d.id)));
  for (const [k, w] of outputs) if (!ids.has(k.split('@')[1])) w.close();
}

// ---- connect to a timer on another computer ----
async function connect(url, name) {
  url = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  if (!/:\d+$/.test(url)) url += ':4848';
  const info = await fetchJson(`${url}/api/info`, 3000).catch(() => null);
  if (!info) throw new Error(`No Lupixis Timer answered at ${url}`);
  const own = new Set(['localhost', '127.0.0.1', ...srv.addresses()]);
  if (own.has(new URL(url).hostname) && Number(new URL(url).port) === srv.port) throw new Error('That is this computer');
  remote = { url, name: name || info.hostname || new URL(url).hostname, ok: true };
  srv.beacon?.setEnabled(false); // don't advertise ourselves as a main timer while following another
  activeSettings = null;
  await pollRemoteSettings();
  clearInterval(remotePoll);
  remotePoll = setInterval(pollRemoteSettings, 2000);
  reloadAll();
}

function disconnect() {
  remote = null;
  activeSettings = null;
  clearInterval(remotePoll);
  srv.beacon?.setEnabled(true);
  hotkeyKey = '';
  onSettingsChanged();
  reloadAll();
}

/** Point every window at the active timer. */
function reloadAll() {
  controllerWin?.loadURL(`${activeBase()}/controller`);
  if (floatingWin && !floatingWin.isDestroyed()) floatingWin.loadURL(`${activeBase()}/viewer?compact=1&floating=1`);
  for (const w of outputs.values()) w.loadURL(outputUrl(w.view));
  updateHost();
}

// ---- info for the controller's "This computer" section ----
let hotkeyErrors = [];
function desktopInfo() {
  const primary = screen.getPrimaryDisplay().id;
  return {
    type: 'electron',
    platform: process.platform,
    hostname: os.hostname(),
    mode: remote ? 'remote' : 'main',
    remote: remote ? { url: remote.url, name: remote.name, ok: remote.ok } : null,
    discovered: discovered.filter((d) => d.id !== srv?.beacon?.id),
    floatingOpen: !!(floatingWin && !floatingWin.isDestroyed()),
    displays: screen.getAllDisplays().map((d) => ({ id: String(d.id), width: d.size.width, height: d.size.height, primary: d.id === primary, label: d.label || '' })),
    outputs: [...outputs.keys()].map((k) => {
      const [view, displayId] = k.split('@');
      return { view, displayId };
    }),
    hotkeyErrors,
    lastRemote: readPrefs().reconnect || readPrefs().lastRemote || null,
    takeover: takeover(),
  };
}

function sendUpdate() {
  if (controllerWin && !controllerWin.isDestroyed()) controllerWin.webContents.send('desktop:update', desktopInfo());
}

/** Our own server also shows this info (so phones/Companion controlling this computer see its screens). */
function updateHost() {
  if (srv) srv.engine.setHost(desktopInfo());
  sendUpdate();
}

ipcMain.handle('desktop:info', () => desktopInfo());
ipcMain.handle('desktop:command', async (_e, name, params = {}) => {
  if (name === 'connect') {
    await connect(params.url, params.name);
    writePrefs({ lastRemote: { url: remote.url, name: remote.name } });
    return desktopInfo();
  }
  if (name === 'disconnect') return disconnect(), desktopInfo();
  if (name === 'openShowsFolder') {
    await shell.openPath(srv.showsDir);
    return desktopInfo();
  }
  if (name === 'setTakeover') {
    writePrefs({ takeover: ['viewer', 'overlay'].includes(params.view) ? params.view : 'none' });
    applyTakeover();
    updateHost();
    return desktopInfo();
  }
  if (name === 'toggleSecondScreen') {
    // One-tap "timer on the other screen": first non-primary display, confidence view.
    const d = screen.getAllDisplays().find((x) => x.id !== screen.getPrimaryDisplay().id);
    if (!d) throw new Error('No second screen connected');
    const key = [...outputs.keys()].find((k) => k.endsWith(`@${d.id}`));
    if (key) outputs.get(key).close();
    else openOutput(String(d.id), params.view || 'viewer');
    return desktopInfo();
  }
  handleCommand({ command: name, ...params });
  return desktopInfo();
});

// ---- commands from the controller / Companion (action "app") ----
function handleCommand(p) {
  switch (p.command) {
    case 'openFloating': return openFloating();
    case 'closeFloating': return closeFloating();
    case 'toggleFloating': return floatingWin && !floatingWin.isDestroyed() ? closeFloating() : openFloating();
    case 'openOutput': return openOutput(p.displayId, p.view === 'overlay' ? 'overlay' : 'viewer');
    case 'closeOutput': return closeOutput(p.displayId, p.view === 'overlay' ? 'overlay' : 'viewer');
    case 'closeAllOutputs': return [...outputs.values()].forEach((w) => w.close());
    case 'showController': return controllerWin?.show(), controllerWin?.focus();
    default: throw new Error(`Unknown app command "${p.command}"`);
  }
}

// ---- global hotkeys (act on the active timer, local or remote) ----
const HOTKEY_ACTIONS = {
  toggle: ['toggle'],
  next: ['next'],
  previous: ['previous'],
  addMinute: ['addTime', { seconds: 60 }],
  subtractMinute: ['addTime', { seconds: -60 }],
  blackout: ['blackout'],
  toggleMessage: ['toggleMessage'],
  toggleFloating: ['app', { command: 'toggleFloating' }],
};
let hotkeyKey = '';
function registerHotkeys() {
  const hk = settings().hotkeys;
  if (!hk) return;
  const key = JSON.stringify(hk);
  if (key === hotkeyKey) return;
  hotkeyKey = key;
  globalShortcut.unregisterAll();
  hotkeyErrors = [];
  for (const [name, accel] of Object.entries(hk)) {
    if (!accel || !HOTKEY_ACTIONS[name]) continue;
    const [action, params] = HOTKEY_ACTIONS[name];
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => {
        Promise.resolve(dispatch(action, params)).catch((err) => console.warn(`[hotkey] ${name}: ${err.message}`));
      });
    } catch {
      ok = false;
    }
    if (!ok) hotkeyErrors.push(name);
  }
  updateHost();
}

// ---- misc ----
async function fetchJson(url, timeout = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function devtoolsShortcut(win) {
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) win.webContents.toggleDevTools();
    // F11: controller fullscreen (handy on a touchscreen all-in-one)
    if (input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
}
ipcMain.on('controller:fullscreen', () => controllerWin?.setFullScreen(!controllerWin.isFullScreen()));

function openLinksExternally(win) {
  // "Open ↗" links in the controller open in the system browser rather than a bare Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function rectInside(r, area) {
  return r.x >= area.x - 50 && r.y >= area.y - 50 && r.x + r.width <= area.x + area.width + 50 && r.y + r.height <= area.y + area.height + 50;
}

// ---- lifecycle ----
app.on('second-instance', () => {
  if (!controllerWin) return;
  if (controllerWin.isMinimized()) controllerWin.restore();
  controllerWin.focus();
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    srv = await startServer({ port: 4848, dataDir: app.getPath('userData'), announce: true });
  } catch (err) {
    dialog.showErrorBox('Lupixis Timer could not start', err.message);
    app.exit(1);
    return;
  }
  localBase = `http://localhost:${srv.port}`;
  srv.engine.on('host-command', (p) => {
    try {
      handleCommand(p);
    } catch (err) {
      console.warn(`[app] ${err.message}`);
    }
  });
  srv.engine.on('change', ({ persist }) => persist && !remote && onSettingsChanged());
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, updateHost);
  screen.on('display-removed', closeOrphanOutputs);
  screen.on('display-added', () => setTimeout(applyTakeover, 1200)); // let Windows settle the new screen first

  listener = startListener((list) => {
    discovered = list;
    sendUpdate();
  });

  // Reconnect to the timer we were following when the app was last closed (if it's still there).
  const re = readPrefs().reconnect;
  if (re?.url) await connect(re.url, re.name).catch(() => writePrefs({ reconnect: null }));

  registerHotkeys();
  updateHost();
  createController();
  applyTakeover();
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  listener?.stop();
  await srv?.close();
});

app.on('window-all-closed', () => app.quit());
