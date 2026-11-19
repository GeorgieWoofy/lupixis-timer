// Regenerates the README screenshots in docs/images using a demo show.
// Run with: npm run screenshots
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/images');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lupixis-shots-'));
  const srv = await startServer({ port: 4960, dataDir });
  const e = srv.engine;
  const base = `http://localhost:${srv.port}`;

  // ---- demo show ----
  e.dispatch('replaceRundown', {
    rundown: [
      { title: 'Doors open', start: '09:00', duration: 30 * 60000 },
      { title: 'Welcome & opening', speaker: 'Host', duration: 10 * 60000 },
      { title: 'Keynote: The future of live events', speaker: 'Jane Doe', duration: 30 * 60000, autoAdvance: true },
      { title: 'Panel discussion', speaker: 'Moderator + 3 guests', duration: 45 * 60000 },
      { title: 'Q&A', duration: 15 * 60000 },
      { title: 'Lunch', mode: 'clock', target: '12:30' },
    ],
  });
  e.dispatch('load', { index: 3, autostart: true });
  e.dispatch('setRemaining', { text: '24:13' });
  e.dispatch('overlayUpdate', { layout: 'fullscreen', progressStyle: 'ring', highlight: 'seconds', label: "We'll be back in", subLabel: 'Panel discussion · 10:45' });
  e.dispatch('updateTheme', { patch: { background: 'color', backgroundColor: '#1c1d1f', logoUrl: '/shared/logo.svg', showLogo: true } });

  fs.mkdirSync(outDir, { recursive: true });
  // One offscreen window, resized per shot (creating/destroying windows rapidly can abort page loads).
  const win = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  async function shot(name, url, width, height, prep) {
    win.setContentSize(width, height);
    for (let attempt = 0; ; attempt++) {
      try {
        await win.loadURL(base + url);
        break;
      } catch (err) {
        if (attempt >= 2) throw err;
        await sleep(500);
      }
    }
    if (prep) await win.webContents.executeJavaScript(prep);
    await sleep(2200);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
    console.log(`docs/images/${name}.png`);
  }

  await shot('controller', '/controller', 1600, 960, "document.querySelector('[data-tab=broadcast]').click()");
  await shot('confidence', '/viewer', 1280, 720);
  e.dispatch('showMessage', { text: 'Please wrap up', color: 'yellow' });
  await shot('confidence-message', '/viewer', 1280, 720);
  e.dispatch('hideMessage');
  e.dispatch('updateSettings', { patch: { floating: { controls: 'always' } } });
  await shot('floating', '/viewer?compact=1&floating=1', 360, 160);
  await shot('broadcast-fullscreen', '/overlay?always=1', 1280, 720);
  e.dispatch('overlayUpdate', { layout: 'lowerthird', progressStyle: 'bar', label: 'Keynote', subLabel: '' });
  e.dispatch('updateTheme', { patch: { background: 'none' } });
  await shot('broadcast-lowerthird', '/overlay?always=1&checker=1', 1280, 720);

  await srv.close();
  app.quit();
});
