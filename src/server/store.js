// Saves the show to <dataDir>/show.json so a restart (or crash) picks up exactly where it left off.
// A running timer survives a restart because it is stored as "started at <timestamp>".
import fs from 'node:fs';
import path from 'node:path';

export function loadShow(dataDir) {
  const file = path.join(dataDir, 'show.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[store] Could not read ${file}: ${err.message}`);
    return null;
  }
}

export function createSaver(dataDir, getState, delay = 400) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'show.json');
  let timer = null;
  const write = () => {
    timer = null;
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(getState(), null, 2));
      fs.renameSync(tmp, file); // atomic replace: never leaves a half-written file
    } catch (err) {
      console.warn(`[store] Save failed: ${err.message}`);
    }
  };
  return {
    schedule() {
      if (!timer) timer = setTimeout(write, delay);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        write();
      }
    },
  };
}
