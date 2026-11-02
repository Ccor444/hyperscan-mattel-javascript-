// gerador de instruções válidas aleatórias (PRNG determinístico)
export function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; }; }
const F0 = [0,2,4,6,8,9,0xa,0xc,0xe,0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,0x19,0x1a,0x1b,0x1e,0x1f,0x20,0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x29,0x2b,0x2d,0x2f,0x30,0x31,0x34,0x35,0x36,0x37,0x38,0x39,0x3c,0x3d,0x40,0x41,0x42,0x44,0x46,0x48,0x4a,0x50,0x52,0x54,0x56,0x58,0x59,0x5a,0x5b,0x5c,0x5d,0x5e,0x5f,0x70,0x71,0x74,0x75,0x76,0x77,0x78,0x79,0x7c,0x7d];
const OPS = [0,0,0,0,1,5,1,5,2,4,4,8,12,13,16,17,18,19,20,21,22,23,3,7,6,24];
export function word(R) {
  const t = R() % 10;
  if (t < 6) { // 32 bits
    const op = OPS[R() % OPS.length];
    let P = (R() & 0x1ffffff) | 0; P = (P & 0x1ffffff) >>> 0;
    P = (op << 25 | P) >>> 0;
    if (op === 0) P = ((P & ~0x3ff) | F0[R() % F0.length]) >>> 0;
    if (op === 1 || op === 5) P = ((P & ~(7 << 17)) | ([0,2,4,5,6][R() % 5] << 17)) >>> 0;
    if (op === 6) { const k = R() % 6; P = ((P & ~0x3ff) | [0, 1, 0, 1, 0xc4, 0x84][k]) >>> 0; if (k < 4) P = (P & ~0x1f) | (k & 1); }
    if (op === 2 || op === 4) { /* saltos: deixa aleatório */ }
    const lo = P & 0x7fff, hi = (P >>> 15) & 0x7fff;
    return ((R() & 0x80000000) | (hi << 16) | 0x8000 | lo) >>> 0;
  }
  const h = () => { // 16 bits válido
    const op = R() % 8, rd = R() & 15, ra = R() & 15; let fn = R() & 15;
    if (op === 0) fn = [0,1,2,3,4,5,8,9,10,11,12][R() % 11];
    if (op === 1) { const k = [0x000,0x001,0x100,0x101,0x002,0x003][R() % 6]; return (1 << 12) | (k & 0xf0f) | (rd << 4) | ((k & 0xf0f) ? 0 : 0) | ((R() & 15) << 8 & ((k & 0xf00) ? 0 : 0xf00)); }
    if (op === 6) { const f3 = [0,1,3,4,5,6,7][R() % 7]; return (6 << 12) | (rd << 8) | ((R() & 31) << 3) | f3; }
    if (op === 7) { const k = [0,4,1,5,3,7][R() % 6]; return (7 << 12) | (rd << 8) | ((R() & 31) << 3) | k; }
    return (op << 12) | (rd << 8) | (ra << 4) | fn;
  };
  const mode = R() % 3;
  if (mode === 0) return h() & 0x7fff;                         // só low
  return (((R() & 1) << 31) | ((h() & 0x7fff) << 16) | (h() & 0x7fff)) >>> 0 & ~0x8000 | (mode === 1 ? 0 : 0);
}
export function makeBios(seed, size = 1 << 20) {
  const R = rng(seed), b = new Uint8Array(size), dv = new DataView(b.buffer);
  for (let i = 0; i < size; i += 4) dv.setUint32(i, word(R), true);
  return b;
}
