// Browser-only mode: `npm run server`. Same server as the desktop app, without the floating window/outputs.
import path from 'node:path';
import os from 'node:os';
import { startServer } from './index.js';

// Options: --port=4848 --data=<folder>   (or env PORT / LUPIXIS_DATA)
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const port = Number(arg('port') || process.env.PORT) || 4848;
const dataDir = path.resolve(arg('data') || process.env.LUPIXIS_DATA || path.join(os.homedir(), '.lupixis-timer'));

const srv = await startServer({ port, dataDir, announce: !process.argv.includes('--no-announce') });
console.log(`Lupixis Timer server running (data in ${dataDir})`);
console.log(`  Controller: http://localhost:${srv.port}/controller`);
for (const ip of srv.addresses()) console.log(`  On the network: http://${ip}:${srv.port}/controller`);

const shutdown = async () => {
  srv.markCleanExit(); // Ctrl+C = deliberate stop: next start is clean
  await srv.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
