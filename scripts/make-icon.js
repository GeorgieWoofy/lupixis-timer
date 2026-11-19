// Renders public/shared/icon.svg to build/icon.png (512×512) using Electron.
// Run with: npm run icon   (only needed when the logo changes)
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'public/shared/icon.svg'), 'utf8');
const SIZE = 512;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${SIZE}" height="${SIZE}"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  const png = image.resize({ width: SIZE, height: SIZE }).toPNG();
  fs.writeFileSync(path.join(root, 'build/icon.png'), png);
  console.log(`Wrote build/icon.png (${png.length} bytes)`);
  app.quit();
});
