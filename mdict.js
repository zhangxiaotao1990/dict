// MDict (.mdx / .mdd) v2 reader. Works in browsers and Node.
// read(offset, length) -> Promise<Uint8Array>; inflate(bytes) -> Promise<Uint8Array> (zlib format).

// ---------- RIPEMD-128 (used to decrypt the key-block index when Encrypted="2") ----------
const RL = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15, 7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,
  3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12, 1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2];
const RR = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12, 6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,
  15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13, 8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14];
const SL = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8, 7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,
  11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5, 11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12];
const SR = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6, 9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,
  9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5, 15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8];
const KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc];
const KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x00000000];

function rf(j, x, y, z) {
  switch (j >> 4) {
    case 0: return x ^ y ^ z;
    case 1: return (x & y) | (~x & z);
    case 2: return (x | ~y) ^ z;
    default: return (x & z) | (y & ~z);
  }
}
const rol = (x, n) => (x << n) | (x >>> (32 - n));

export function ripemd128(msg) {
  const len = msg.length;
  const padLen = ((len + 8) >> 6 << 6) + 64;
  const buf = new Uint8Array(padLen);
  buf.set(msg);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, (len * 8) >>> 0, true);
  dv.setUint32(padLen - 4, Math.floor(len / 0x20000000), true);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476;
  const X = new Int32Array(16);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = dv.getInt32(off + i * 4, true);
    let al = h0, bl = h1, cl = h2, dl = h3, ar = h0, br = h1, cr = h2, dr = h3, t;
    for (let j = 0; j < 64; j++) {
      t = rol((al + rf(j, bl, cl, dl) + X[RL[j]] + KL[j >> 4]) | 0, SL[j]);
      al = dl; dl = cl; cl = bl; bl = t;
      t = rol((ar + rf(63 - j, br, cr, dr) + X[RR[j]] + KR[j >> 4]) | 0, SR[j]);
      ar = dr; dr = cr; cr = br; br = t;
    }
    t = (h1 + cl + dr) | 0;
    h1 = (h2 + dl + ar) | 0;
    h2 = (h3 + al + br) | 0;
    h3 = (h0 + bl + cr) | 0;
    h0 = t;
  }
  const out = new Uint8Array(16), odv = new DataView(out.buffer);
  [h0, h1, h2, h3].forEach((h, i) => odv.setInt32(i * 4, h, true));
  return out;
}

function decryptKeyInfo(block) {
  const keySrc = new Uint8Array(8);
  keySrc.set(block.subarray(4, 8));
  keySrc.set([0x95, 0x36, 0, 0], 4); // pack('<L', 0x3695)
  const key = ripemd128(keySrc);
  const out = new Uint8Array(block.length);
  out.set(block.subarray(0, 8));
  let prev = 0x36;
  for (let i = 8; i < block.length; i++) {
    const b = block[i];
    let t = ((b >> 4) | (b << 4)) & 0xff;
    t = t ^ prev ^ ((i - 8) & 0xff) ^ key[(i - 8) % 16];
    prev = b;
    out[i] = t;
  }
  return out;
}

// ---------- helpers ----------
const u64 = (dv, o) => dv.getUint32(o) * 0x100000000 + dv.getUint32(o + 4);
const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

function parseHeaderAttrs(s) {
  const attrs = {};
  s.replace(/(\w+)="((?:[^"\\]|\\.)*)"/g, (_, k, v) => { attrs[k] = v; });
  return attrs;
}

// Search key normalisation: case/accent-insensitive, punctuation folded to single spaces.
export function normKey(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’ʼ.]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export class MDict {
  constructor(read, inflate, { isMdd = false } = {}) {
    this.read = read;
    this.inflate = inflate;
    this.isMdd = isMdd;
    this.cache = new Map(); // record-block LRU
  }

  async block(raw) {
    const type = raw[0];
    const data = raw.subarray(8);
    if (type === 0) return data;
    if (type === 2) return this.inflate(data);
    throw new Error('Unsupported block compression type ' + type);
  }

  async init() {
    let pos = 0;
    const hl = view(await this.read(0, 4)).getUint32(0);
    const hb = await this.read(4, hl);
    const header = new TextDecoder('utf-16le').decode(hb).replace(/\0+$/, '');
    this.attrs = parseHeaderAttrs(header);
    pos = 4 + hl + 4;
    const ver = parseFloat(this.attrs.GeneratedByEngineVersion || '2');
    if (ver < 2) throw new Error('Only MDict v2 files are supported (this file is v' + ver + ')');
    const enc = parseInt(this.attrs.Encrypted || '0', 10) || 0;
    if (enc & 1) throw new Error('This dictionary uses registration-code encryption and cannot be opened');
    let encoding = (this.attrs.Encoding || '').toUpperCase();
    if (this.isMdd || encoding === '' || encoding === 'UTF-16') encoding = this.isMdd ? 'UTF-16LE' : 'UTF-8';
    if (encoding === 'GBK' || encoding === 'GB2312') encoding = 'GB18030';
    this.encoding = encoding;
    const wide = encoding === 'UTF-16LE';
    const dec = new TextDecoder(encoding.toLowerCase());

    // key block section header
    const kh = view(await this.read(pos, 40));
    const numKeyBlocks = u64(kh, 0);
    this.numEntries = u64(kh, 8);
    const kbiSize = u64(kh, 24);
    const kbSize = u64(kh, 32);
    pos += 44;
    let kbi = await this.read(pos, kbiSize);
    pos += kbiSize;
    if (enc & 2) kbi = decryptKeyInfo(kbi);
    kbi = await this.block(kbi);

    // key block info -> compressed sizes
    const kv = view(kbi);
    const compSizes = [];
    let p = 0;
    const tw = wide ? 2 : 1;
    for (let i = 0; i < numKeyBlocks; i++) {
      p += 8;
      const fs = kv.getUint16(p); p += 2 + (fs + 1) * tw;
      const ls = kv.getUint16(p); p += 2 + (ls + 1) * tw;
      compSizes.push(u64(kv, p)); p += 16;
    }

    // key blocks
    const kbAll = await this.read(pos, kbSize);
    pos += kbSize;
    const keys = new Array(this.numEntries);
    const offsets = new Float64Array(this.numEntries + 1);
    let n = 0, kp = 0;
    for (let i = 0; i < numKeyBlocks; i++) {
      const d = await this.block(kbAll.subarray(kp, kp + compSizes[i]));
      kp += compSizes[i];
      const dv = view(d);
      let q = 0;
      while (q < d.length) {
        offsets[n] = u64(dv, q); q += 8;
        let e = q;
        if (wide) { while (e < d.length - 1 && (d[e] | d[e + 1])) e += 2; }
        else { while (e < d.length && d[e]) e++; }
        keys[n++] = dec.decode(d.subarray(q, e));
        q = e + tw;
      }
    }
    keys.length = n;
    this.numEntries = n;
    this.keys = keys;
    this.offsets = offsets;

    // record block info
    const rh = view(await this.read(pos, 32));
    const numRecBlocks = u64(rh, 0);
    const rbiSize = u64(rh, 16);
    pos += 32;
    const rbi = view(await this.read(pos, rbiSize));
    pos += rbiSize;
    this.recComp = new Float64Array(numRecBlocks + 1);   // file offset of each block
    this.recDecomp = new Float64Array(numRecBlocks + 1); // decompressed offset of each block
    let co = pos, dco = 0;
    for (let i = 0; i < numRecBlocks; i++) {
      this.recComp[i] = co; this.recDecomp[i] = dco;
      co += u64(rbi, i * 16); dco += u64(rbi, i * 16 + 8);
    }
    this.recComp[numRecBlocks] = co; this.recDecomp[numRecBlocks] = dco;
    offsets[n] = dco;
    this.numRecBlocks = numRecBlocks;
    return this;
  }

  async recordBlock(i) {
    let b = this.cache.get(i);
    if (b) { this.cache.delete(i); this.cache.set(i, b); return b; }
    const raw = await this.read(this.recComp[i], this.recComp[i + 1] - this.recComp[i]);
    b = await this.block(raw);
    this.cache.set(i, b);
    if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value);
    return b;
  }

  findBlock(off) {
    let lo = 0, hi = this.numRecBlocks - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.recDecomp[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // Raw record bytes for key index i.
  async record(i) {
    const start = this.offsets[i];
    // records are stored in key order; the record ends where the next distinct offset begins
    let j = i + 1;
    while (j < this.numEntries && this.offsets[j] <= start) j++;
    const end = this.offsets[j];
    let b = this.findBlock(start);
    const parts = [];
    let cur = start;
    while (cur < end && b < this.numRecBlocks) {
      const data = await this.recordBlock(b);
      const base = this.recDecomp[b];
      const s = cur - base, e = Math.min(end - base, data.length);
      parts.push(data.subarray(s, e));
      cur = base + e;
      b++;
    }
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
    let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
  }

  async text(i) {
    const bytes = await this.record(i);
    return new TextDecoder(this.encoding.toLowerCase()).decode(bytes).replace(/[\0\s]+$/, '');
  }
}
