// Protocol tests for the clip-timer integrations and network discovery, using fake QLab/CasparCG peers.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { encodeMessage, decodePacket, slipEncode, slipDecoder } from '../src/server/osc.js';
import { QLabClient } from '../src/server/integrations/qlab.js';
import { CasparListener } from '../src/server/integrations/caspar.js';
import { startBeacon, startListener } from '../src/server/discovery.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error('timed out');
};

test('OSC encode/decode round trip, SLIP framing and bundles', () => {
  const msg = encodeMessage('/cue/1/start', ['hello', 1.5, { type: 'i', value: 7 }]);
  assert.deepEqual(decodePacket(msg), [{ address: '/cue/1/start', args: ['hello', 1.5, 7] }]);

  const packets = [];
  const feed = slipDecoder((p) => packets.push(p));
  const framed = Buffer.concat([slipEncode(msg), slipEncode(encodeMessage('/x', [{ type: 'i', value: 0xc0 }]))]);
  feed(framed.subarray(0, 5));
  feed(framed.subarray(5)); // split across TCP chunks
  assert.equal(packets.length, 2);
  assert.equal(decodePacket(packets[1])[0].args[0], 0xc0);

  const inner = encodeMessage('/a', [1]);
  const size = Buffer.alloc(4);
  size.writeInt32BE(inner.length);
  const bundle = Buffer.concat([Buffer.from('#bundle\0'), Buffer.alloc(8), size, inner, size, inner]);
  assert.equal(decodePacket(bundle).length, 2);
});

test('QLab: shows only running cues with the chosen colour', async () => {
  // Fake QLab: two running cues, one red video and one blue background loop.
  const cues = {
    A: { uniqueID: 'A', number: '1', name: 'Intro video', type: 'Video', colorName: 'red', notes: '', actionElapsed: 10, duration: 70, isPaused: false },
    B: { uniqueID: 'B', number: '2', name: 'BG loop', type: 'Video', colorName: 'blue', notes: '', actionElapsed: 5, duration: 600, isPaused: false },
  };
  const server = net.createServer((sock) => {
    const feed = slipDecoder((pkt) => {
      for (const { address } of decodePacket(pkt)) {
        let data;
        if (address === '/runningOrPausedCues') data = Object.values(cues).map(({ uniqueID, name, type, colorName }) => ({ uniqueID, name, type, colorName }));
        else if (address.endsWith('/valuesForKeys')) data = cues[address.split('/')[2]];
        else continue;
        const reply = JSON.stringify({ workspace_id: 'W', address, status: 'ok', data });
        sock.write(slipEncode(encodeMessage(`/reply${address}`, [reply])));
      }
    });
    sock.on('data', feed);
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let clips = [];
  const statuses = [];
  const q = new QLabClient({ host: '127.0.0.1', port: server.address().port, filter: 'color', color: 'red' }, (c) => (clips = c), (s) => statuses.push(s));
  try {
    await waitFor(() => clips.length === 1);
    assert.equal(clips[0].name, 'Intro video');
    assert.equal(clips[0].remaining, 60);
    assert.ok(statuses.some((s) => s.startsWith('Connected')));
    // Cue stops in QLab -> clip disappears.
    delete cues.A;
    await waitFor(() => clips.length === 0);
  } finally {
    q.stop();
    server.close();
  }
});

test('CasparCG: clips from OSC layer messages, with layer filter and expiry', async () => {
  let clips = [];
  const port = 16250 + Math.floor(Math.random() * 1000);
  const c = new CasparListener({ port, filter: 'layers', layers: '1-10' }, (x) => (clips = x), () => {});
  const sock = dgram.createSocket('udp4');
  const send = (addr, args) => new Promise((r) => sock.send(encodeMessage(addr, args), port, '127.0.0.1', r));
  try {
    await sleep(100);
    for (let i = 0; i < 4; i++) {
      await send('/channel/1/stage/layer/10/foreground/file/name', ['AMB/intro_video.mp4']);
      await send('/channel/1/stage/layer/10/foreground/file/time', [12.5, 42.5]);
      await send('/channel/1/stage/layer/20/foreground/file/time', [1, 300]); // filtered out
      await sleep(100);
    }
    await waitFor(() => clips.length === 1);
    assert.equal(clips[0].name, 'intro_video.mp4');
    assert.equal(clips[0].remaining, 30);
    await waitFor(() => clips.length === 0, 2500); // no more messages = clip ended
  } finally {
    c.stop();
    sock.close();
  }
});

test('discovery: a beacon is heard by a listener', async () => {
  let list = [];
  const l = startListener((x) => (list = x));
  const b = startBeacon({ port: 4999, name: 'test-machine', version: '9.9.9' });
  try {
    const found = await waitFor(() => list.find((x) => x.id === b.id), 5000);
    assert.equal(found.name, 'test-machine');
    assert.equal(found.port, 4999);
  } finally {
    b.stop();
    l.stop();
  }
});

test('PowerPoint media -> clip timers, with trims and filters', async () => {
  const { mediaToClip } = await import('../src/main/ppt-reader.js');
  const video = { id: '256-4', name: 'Sponsor reel [T]', alt: '', kind: 'video', state: 0, pos: 30000, len: 95000, start: 5000, end: 65000 };
  const c = mediaToClip(video, { filter: 'video' });
  assert.equal(c.name, 'Sponsor reel'); // tag hidden from speakers
  assert.equal(c.duration, 60); // trimmed 5 s - 65 s
  assert.equal(c.remaining, 35);
  assert.equal(c.paused, false);
  assert.equal(mediaToClip({ ...video, kind: 'audio' }, { filter: 'video' }), null);
  assert.ok(mediaToClip({ ...video, kind: 'audio' }, { filter: 'all' }));
  assert.equal(mediaToClip({ ...video, name: 'Loop' }, { filter: 'tag', tag: '[T]' }), null);
  assert.equal(mediaToClip({ ...video, end: 0, start: 0, pos: 90000 }, {}).remaining, 5); // untrimmed
});

test('server accepts pushed PowerPoint clips only when enabled, and drops silent senders', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { startServer } = await import('../src/server/index.js');
  const srv = await startServer({ port: 4972, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lupixis-ppt-')) });
  const push = (clips) => fetch(`http://localhost:${srv.port}/api/clips/external`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'ppt', sender: 'PRESENTER-PC', clips }) }).then((r) => r.json());
  const clip = { key: 'ppt:1-2', name: 'Intro', duration: 60, elapsed: 10, remaining: 50, paused: false };
  try {
    assert.equal((await push([clip])).ignored, true, 'off by default');
    srv.engine.dispatch('updateSettings', { patch: { integrations: { ppt: { enabled: true } } } });
    await push([clip]);
    const { getSnapshot } = { getSnapshot: () => fetch(`http://localhost:${srv.port}/api/timer`).then((r) => r.json()) };
    const t = await getSnapshot();
    assert.equal(t.clipName, 'Intro');
    await new Promise((r) => setTimeout(r, 4200)); // sender goes quiet
    assert.equal((await getSnapshot()).clipName, '');
  } finally {
    await srv.close();
  }
});

test('server moves to the next port when 4848-style port is busy', async () => {
  const net = await import('node:net');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { startServer } = await import('../src/server/index.js');
  const blocker = net.createServer().listen(4975, '0.0.0.0');
  await new Promise((r) => blocker.once('listening', r));
  const srv = await startServer({ port: 4975, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lupixis-port-')) });
  try {
    assert.equal(srv.port, 4976);
  } finally {
    await srv.close();
    blocker.close();
  }
});
