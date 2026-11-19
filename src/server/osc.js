// Minimal OSC 1.0/1.1 encoder/decoder + SLIP framing (used by QLab over TCP and CasparCG over UDP).
// Supports the argument types those apps use: i (int32), f (float32), d (float64), h (int64), s (string),
// b (blob), T/F (booleans), N (nil). Bundles are flattened into plain messages.

const pad4 = (n) => (n + 3) & ~3;

function writeString(str) {
  const b = Buffer.from(String(str), 'utf8');
  const out = Buffer.alloc(pad4(b.length + 1));
  b.copy(out);
  return out;
}

/** Encode one OSC message. Args: numbers become float32 unless {type:'i', value}; strings/booleans as-is. */
export function encodeMessage(address, args = []) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    const arg = typeof a === 'object' && a !== null && 'type' in a ? a : { type: typeof a === 'number' ? 'f' : typeof a === 'boolean' ? (a ? 'T' : 'F') : 's', value: a };
    tags += arg.type;
    if (arg.type === 'i') {
      const b = Buffer.alloc(4);
      b.writeInt32BE(arg.value | 0);
      parts.push(b);
    } else if (arg.type === 'f') {
      const b = Buffer.alloc(4);
      b.writeFloatBE(Number(arg.value));
      parts.push(b);
    } else if (arg.type === 's') parts.push(writeString(arg.value));
  }
  return Buffer.concat([writeString(address), writeString(tags), ...parts]);
}

function readString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  return { value: buf.toString('utf8', offset, end), next: pad4(end + 1) };
}

/** Decode a packet into a list of messages [{address, args}] (bundles are flattened). */
export function decodePacket(buf) {
  const out = [];
  decodeInto(buf, out);
  return out;
}

function decodeInto(buf, out) {
  if (buf.length < 4) return;
  if (buf.toString('ascii', 0, 8) === '#bundle\0') {
    let o = 16; // "#bundle\0" + 8-byte timetag
    while (o + 4 <= buf.length) {
      const size = buf.readInt32BE(o);
      o += 4;
      if (size <= 0 || o + size > buf.length) break;
      decodeInto(buf.subarray(o, o + size), out);
      o += size;
    }
    return;
  }
  const addr = readString(buf, 0);
  if (!addr.value.startsWith('/')) return;
  let o = addr.next;
  const args = [];
  if (o < buf.length && buf[o] === 0x2c /* , */) {
    const tags = readString(buf, o);
    o = tags.next;
    for (const t of tags.value.slice(1)) {
      if (t === 'i') args.push(buf.readInt32BE(o)), (o += 4);
      else if (t === 'f') args.push(buf.readFloatBE(o)), (o += 4);
      else if (t === 'd') args.push(buf.readDoubleBE(o)), (o += 8);
      else if (t === 'h') args.push(Number(buf.readBigInt64BE(o))), (o += 8);
      else if (t === 's' || t === 'S') {
        const s = readString(buf, o);
        args.push(s.value);
        o = s.next;
      } else if (t === 'b') {
        const len = buf.readInt32BE(o);
        args.push(buf.subarray(o + 4, o + 4 + len));
        o = pad4(o + 4 + len);
      } else if (t === 'T') args.push(true);
      else if (t === 'F') args.push(false);
      else if (t === 'N') args.push(null);
      else break; // unknown type: stop rather than misread
    }
  }
  out.push({ address: addr.value, args });
}

// ---- SLIP (RFC 1055), used for OSC over TCP by QLab 4/5 ----
const END = 0xc0, ESC = 0xdb, ESC_END = 0xdc, ESC_ESC = 0xdd;

export function slipEncode(buf) {
  const out = [END];
  for (const b of buf) {
    if (b === END) out.push(ESC, ESC_END);
    else if (b === ESC) out.push(ESC, ESC_ESC);
    else out.push(b);
  }
  out.push(END);
  return Buffer.from(out);
}

/** Streaming SLIP decoder: feed TCP chunks, get complete packets via onPacket. */
export function slipDecoder(onPacket) {
  let cur = [];
  let esc = false;
  return (chunk) => {
    for (const b of chunk) {
      if (esc) {
        cur.push(b === ESC_END ? END : b === ESC_ESC ? ESC : b);
        esc = false;
      } else if (b === ESC) esc = true;
      else if (b === END) {
        if (cur.length) onPacket(Buffer.from(cur));
        cur = [];
      } else cur.push(b);
    }
  };
}
