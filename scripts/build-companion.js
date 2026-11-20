// Builds the Companion module package (.tgz) and the ready-made page, and copies both into
// public/companion so the timer app can offer them as downloads (Settings → Stream Deck).
// Run: npm run companion   (also runs automatically before npm run dist / dist:mac)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = path.join(root, 'companion-module');
const out = path.join(root, 'public', 'companion');
const run = (cmd) => execSync(cmd, { cwd: mod, stdio: 'inherit' });

run('npm install --no-audit --no-fund');
for (const f of fs.readdirSync(mod)) if (f.endsWith('.tgz')) fs.rmSync(path.join(mod, f));
run('npx companion-module-build');
run('node scripts/make-page.cjs');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const pkg = fs.readdirSync(mod).find((f) => f.endsWith('.tgz'));
if (!pkg) throw new Error('companion-module-build produced no .tgz');
fs.copyFileSync(path.join(mod, pkg), path.join(out, pkg));
fs.copyFileSync(path.join(mod, 'lupixis-timer-page.companionconfig'), path.join(out, 'lupixis-timer-page.companionconfig'));
const version = JSON.parse(fs.readFileSync(path.join(mod, 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(out, 'info.json'), JSON.stringify({ version, module: pkg, page: 'lupixis-timer-page.companionconfig' }, null, 2));
console.log(`public/companion: ${pkg}, lupixis-timer-page.companionconfig (module ${version})`);
