// =============================================================================
// HyperScan JS — arquivo único (emulador + UI + worklet inline)
// Módulos antigos (bus, disc, servo, spu, io, ppu, jit, cpu, cdhle, idle,
// fastpaths, hyperscan, savestate) foram fundidos aqui. O antigo
// audio-worklet.js é carregado via Blob URL (não precisa de arquivo à parte).
// =============================================================================

'use strict';

// -------- helpers compartilhados --------
const sx = (v, b) => (v << (32 - b)) >> (32 - b);
const U  = (n) => (n >>> 0);

// =============================================================================
// BUS (ex-bus.js)
// =============================================================================
class Bus {
  constructor({ ramSize = 16 << 20, bios } = {}) {
    this.ram = new Uint8Array(ramSize);
    this.bios = bios;
    this.dv = new DataView(this.ram.buffer);
    this.bdv = new DataView(bios.buffer, bios.byteOffset, bios.byteLength);
    this.mmio = [];
    this.unmapped = new Map();
    this.codeWords = new Uint8Array(0x100000);
    this.onCodeWrite = null;
    this.logMMIO = false;
  }
  addMMIO(base, size, name, dev) { this.mmio.push({ base: base >>> 0, size, name, ...dev }); }
  _region(a) {
    a >>>= 0;
    const seg = a >>> 24, o = a & 0xffffff;
    if (seg === 0x9e || seg === 0x9f) return { k: 'bios', o };
    if (seg === 0x80 || seg === 0xa0) return { k: 'ram', o };
    return null;
  }
  _find(a) { a >>>= 0; for (const m of this.mmio) if (a >= m.base && a < m.base + m.size) return m; return null; }
  _miss(a, w, sz) { if (this.unmapped.size < 2000) { const k = (a >>> 0).toString(16) + (w ? 'W' : 'R'); this.unmapped.set(k, (this.unmapped.get(k) || 0) + 1); } return 0; }
  read(a, sz) {
    a >>>= 0;
    const seg = a >>> 24;
    if (seg === 0xa0 || seg === 0x80) { const o = a & 0xffffff; return sz === 4 ? this.dv.getUint32(o, true) : sz === 2 ? this.dv.getUint16(o, true) : this.ram[o]; }
    if (seg === 0x9f || seg === 0x9e) { const o = a & 0xffffff; if (o + sz > this.bios.length) return 0; return sz === 4 ? this.bdv.getUint32(o, true) : sz === 2 ? this.bdv.getUint16(o, true) : this.bios[o]; }
    const m = this._find(a);
    if (m) { const v = m.read ? m.read(a - m.base, sz) >>> 0 : 0; if (this.logMMIO) console.log(`R${sz * 8} ${m.name}+${(a - m.base).toString(16)} = ${v.toString(16)}`); return v; }
    return this._miss(a, 0, sz);
  }
  write(a, v, sz) {
    a >>>= 0;
    const seg = a >>> 24;
    if (seg === 0xa0 || seg === 0x80) { const o = a & 0xffffff; if (sz === 4) this.dv.setUint32(o, v >>> 0, true); else if (sz === 2) this.dv.setUint16(o, v & 0xffff, true); else this.ram[o] = v; if (o < 0x400000 && (this.codeWords[o >>> 2] | this.codeWords[(o + sz - 1) >>> 2]) !== 0) this.onCodeWrite(o); return; }
    const m = this._find(a);
    if (m) { if (this.logMMIO) console.log(`W${sz * 8} ${m.name}+${(a - m.base).toString(16)} = ${(v >>> 0).toString(16)}`); if (m.write) m.write(a - m.base, v >>> 0, sz); return; }
    this._miss(a, 1, sz);
  }
  r8(a) { a >>>= 0; const s = a >>> 24; if (s === 0xa0 || s === 0x80) return this.ram[a & 0xffffff]; if (s === 0x9f || s === 0x9e) { const o = a & 0xffffff; return o < this.bios.length ? this.bios[o] : 0; } return this.read(a, 1); }
  r16(a) { a >>>= 0; const s = a >>> 24; if (s === 0xa0 || s === 0x80) return this.dv.getUint16(a & 0xffffff, true); if (s === 0x9f || s === 0x9e) { const o = a & 0xffffff; return o + 2 <= this.bios.length ? this.bdv.getUint16(o, true) : 0; } return this.read(a, 2); }
  r32(a) { a >>>= 0; const s = a >>> 24; if (s === 0xa0 || s === 0x80) return this.dv.getUint32(a & 0xffffff, true); if (s === 0x9f || s === 0x9e) { const o = a & 0xffffff; return o + 4 <= this.bios.length ? this.bdv.getUint32(o, true) : 0; } return this.read(a, 4); }
  w8(a, v) { a >>>= 0; const s = a >>> 24; if (s === 0xa0 || s === 0x80) { const o = a & 0xffffff; this.ram[o] = v; if (o < 0x400000 && this.codeWords[o >>> 2] !== 0) this.onCodeWrite(o); } else this.write(a, v, 1); }
  w16(a, v) { a >>>= 0; const s = a >>> 24; if (s === 0xa0 || s === 0x80) { const o = a & 0xffffff; this.dv.setUint16(o, v & 0xffff, true); if (o < 0x400000 && (this.codeWords[o >>> 2] | this.codeWords[(o + 1) >>> 2]) !== 0) this.onCodeWrite(o); } else this.write(a, v, 2); }
  w32(a, v) { a >>>= 0; const s = a >>> 24; if (s === 0xa0 || s === 0x80) { const o = a & 0xffffff; this.dv.setUint32(o, v >>> 0, true); if (o < 0x400000 && (this.codeWords[o >>> 2] | this.codeWords[(o + 3) >>> 2]) !== 0) this.onCodeWrite(o); } else this.write(a, v, 4); }
}

// =============================================================================
// DISC (ex-disc.js)
// =============================================================================
class Disc {
  constructor(buf) {
    this.u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const sync = [0,255,255,255,255,255,255,255,255,255,255,0];
    const raw = sync.every((v, i) => this.u8[i] === v);
    this.sectorSize = raw ? 2352 : 2048;
    this.dataOff = raw ? (this.u8[15] === 2 ? 24 : 16) : 0;
    this.sectors = Math.floor(this.u8.length / this.sectorSize);
    this.root = null;
    const pvd = this.readSector(16);
    if (String.fromCharCode(...pvd.subarray(1, 6)) === 'CD001') {
      const dv = new DataView(pvd.buffer, pvd.byteOffset);
      this.volumeId = String.fromCharCode(...pvd.subarray(40, 72)).trim();
      this.root = { lba: dv.getUint32(158, true), size: dv.getUint32(166, true) };
    }
  }
  readSector(lba) {
    const o = lba * this.sectorSize + this.dataOff;
    return this.u8.subarray(o, o + 2048);
  }
  readSectors(lba, n) {
    const out = new Uint8Array(n * 2048);
    for (let i = 0; i < n; i++) out.set(this.readSector(lba + i), i * 2048);
    return out;
  }
  list(dir = this.root) {
    const data = this.readSectors(dir.lba, Math.ceil(dir.size / 2048));
    const dv = new DataView(data.buffer);
    const out = [];
    for (let i = 0; i < dir.size;) {
      const len = data[i];
      if (!len) { i = (Math.floor(i / 2048) + 1) * 2048; continue; }
      const nl = data[i + 32];
      let name = String.fromCharCode(...data.subarray(i + 33, i + 33 + nl));
      if (nl === 1 && (name === '\0' || name === '\x01')) { i += len; continue; }
      out.push({ name: name.replace(/;1$/, ''), lba: dv.getUint32(i + 2, true), size: dv.getUint32(i + 10, true), dir: !!(data[i + 25] & 2) });
      i += len;
    }
    return out;
  }
  find(path) {
    let dir = this.root, ent = null;
    for (const part of path.split('/').filter(Boolean)) {
      ent = this.list(dir).find(e => e.name.toUpperCase() === part.toUpperCase());
      if (!ent) return null;
      dir = ent;
    }
    return ent;
  }
  readFile(path) {
    const e = this.find(path);
    return e ? this.readSectors(e.lba, Math.ceil(e.size / 2048)).subarray(0, e.size) : null;
  }
}

// =============================================================================
// SERVO (ex-servo.js)
// =============================================================================
class Servo {
  constructor() {
    this.reg = new Uint8Array(0x1000);
    this.addr = 0; this.data = 0; this.ctrl = 0;
    this.cpu = null;
    this.r79 = { 0xa002de34: 0x20 };
    this.reg[0x79] = 0xa0;
    this.other = new Map();
    this.log = []; this.logMax = 400; this.trace = false;
    this.hooks = { read: null, write: null };
    this.im = new Uint32Array(0x10000); this.pm = new Uint32Array(0x10000);
  }
  mailbox(cmd) {
    const r = this.reg, a = (r[0x500] << 8) | r[0x501];
    switch (cmd) {
      case 0x02: this.im[a] = r[0x502] | r[0x503] << 8 | r[0x504] << 16; break;
      case 0x12: this.pm[a] = r[0x502] | r[0x503] << 8; break;
      case 0x03: { const v = this.im[a]; r[0x507] = v & 0xff; r[0x508] = (v >> 8) & 0xff; r[0x509] = (v >> 16) & 0xff; break; }
      case 0x13: { const v = this.pm[a]; r[0x507] = v & 0xff; r[0x508] = (v >> 8) & 0xff; r[0x509] = 0; break; }
    }
  }
  command(v) {
    const r = this.reg;
    this.cmdLog = this.cmdLog || [];
    if (this.cmdLog.length < 200) this.cmdLog.push(`cmd 0x40d=${v.toString(16)} p409=${r[0x409].toString(16)} p40a=${r[0x40a].toString(16)} p40b=${r[0x40b].toString(16)} p40c=${r[0x40c].toString(16)} p40e=${r[0x40e].toString(16)}`);
  }
  note(s) { if (this.trace && this.log.length < this.logMax) this.log.push(s); }
  read(off) {
    switch (off) {
      case 0x04: return this.addr;
      case 0x08: return this.data;
      case 0x0c: return this.ctrl;
    }
    const v = this.other.get(off) ?? 0;
    this.note(`R other +${off.toString(16)} -> ${v.toString(16)}`);
    return v;
  }
  write(off, v) {
    switch (off) {
      case 0x04: this.addr = v & 0xfff; return;
      case 0x08: this.data = v & 0xff; return;
      case 0x0c: {
        if ((v & 0xff) === 0) {
          const old = this.reg[this.addr];
          let val = this.data;
          if (this.hooks.write) { const r = this.hooks.write(this.addr, val, this); if (r !== undefined) val = r; }
          this.reg[this.addr] = val;
          if (this.addr === 0x505) this.mailbox(val);
          if (this.addr === 0x40d && (val & 0x80)) { this.command(val); val &= 0x3f; this.reg[this.addr] = val; }
          this.note(`W reg[${this.addr.toString(16)}] = ${val.toString(16)} (era ${old.toString(16)})`);
        } else if ((v & 0xff) === 1) {
          let val = this.reg[this.addr];
          if (this.addr === 0x79 && this.cpu) { const lr = this.cpu.r[3] >>> 0; if (this.r79[lr] !== undefined) val = this.r79[lr]; }
          if (this.addr === 0x7d && this.reg[0x30] === 2) val = 0x30;
          if (this.hooks.read) { const r = this.hooks.read(this.addr, val, this); if (r !== undefined) val = r; }
          this.data = val;
          this.note(`R reg[${this.addr.toString(16)}] -> ${val.toString(16)}`);
        }
        this.ctrl = 0; return;
      }
    }
    this.other.set(off, v); this.note(`W other +${off.toString(16)} = ${v.toString(16)}`);
  }
}

// =============================================================================
// SPU (ex-spu.js)
// =============================================================================
const AUDIO_RATE = 44100, WAVE_BASE = 0xa0800000;
const DAC_CLOCK = 54000000;
const MAME_FRAME_HZ = 70312.5;
const ENV_CLK_FRAMES = [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 8192, 8192, 8192, 8192];
const VOLSEL = [1 / 32, 1 / 8, 1 / 2, 1];
const RING = 32768;
const WAVE_INC = 281250 * 65536 / (524288 * AUDIO_RATE);
const IMA_STEPS = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
const clamp16 = v => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

class SPU {
  constructor(io, bus) {
    this.io = io; this.bus = bus;
    this.regs = io.spu;
    this.ch = Array.from({ length: 24 }, () => ({
      active: false, waddr: 0, loop: 0, tone: 0, kind: 'pcm8', phaseAcc: 0, wp: 0, bp: 0, shift: 0, nib: 0,
      sig: 0, stepIdx: 0, hdr: 0, rem: 0, p0: 0, last: 0, prev: 0, acc: 0,
      envClk: 4, envAddr: 0, envAcc: 0, started: -1, samples: 0,
    }));
    this.ring = new Float32Array(AUDIO_RATE * 2 * 2); this.rd = 0; this.wr = 0; this.count = 0;
    this.pos = 0; this.underruns = 0;
    this.underrunRuns = 0; this._underrunActive = false;
    this.done = 0;
    this.mameAcc = 0; this.frameAcc = 0;
    this.xl = this.xr = this.yl = this.yr = 0;
    this.fifo = new Int16Array(RING * 2); this.fHead = 0; this.fTail = 0; this.fFrac = 0;
    this.dmaOn = false; this.dmaHalf = 0; this.dmaLeft = 0; this.dacStereo = false; this.halfFrames = 0; this.dacRate = 0;
    this.waveIn = [0, 0];
    this.peak = 0; this.samplesOut = 0; this.starts = 0; this.muted = false;
    if (this.regs.get(0x1054) === undefined) this.regs.set(0x1054, 0x3f);
    if (this.regs.get(0x1050) === undefined) this.regs.set(0x1050, 0x3f);
    if (this.regs.get(0x1004) === undefined) this.regs.set(0x1004, 0x7f);
  }
  reg(o) { return this.regs.get(o) ?? 0; }
  attrBase(ch) { return (ch < 16 ? 0x000 : 0x400) + (ch & 15) * 0x40; }
  phaseBase(ch) { return (ch < 16 ? 0x800 : 0xc00) + (ch & 15) * 0x40; }
  fiqEnable() { return (this.reg(0x1008) | (this.reg(0x1408) << 16)) >>> 0; }
  read(off) {
    if (off === 0x103c) return this.busyBits() & 0xffff;
    if (off === 0x143c) return this.busyBits() >>> 16;
    return this.regs.get(off) ?? 0;
  }
  busyBits() { let b = 0; for (let c = 0; c < 24; c++) if (this.ch[c].active) b |= 1 << c; return b >>> 0; }
  write(off, v) {
    v >>>= 0;
    if (off === 0x1000 || off === 0x1400) {
      this.sync();
      const base = off === 0x1400 ? 16 : 0, old = this.reg(off) & 0xffff, nv = v & 0xffff;
      this.regs.set(off, nv);
      for (let b = 0; b < 16; b++) {
        const was = (old >> b) & 1, now = (nv >> b) & 1, c = base + b;
        if (now && !was) this.startChannel(c);
        else if (!now && was) this.stopChannel(c, false);
      }
      this.updateIrq(); return;
    }
    if (off === 0x102c || off === 0x142c) {
      this.sync();
      const cur = this.reg(off);
      this.regs.set(off, (cur & ~(v & 0xffff)) >>> 0);
      this.updateIrq(); return;
    }
    if (off === 0x1004) { this.sync(); this.regs.set(off, v & 0x7f); return; }
    if (off === 0x1034) { this.sync(); this.regs.set(off, v & 0xffff); return; }
    if (off === 0x1040) { this.sync(); this.waveIn[0] = (v << 16) >> 16; this.regs.set(off, v & 0xffff); return; }
    if (off === 0x1044) { this.sync(); this.waveIn[1] = (v << 16) >> 16; this.regs.set(off, v & 0xffff); return; }
    if (off === 0x1064) {
      this.sync(); this.regs.set(off, v & 0xffff);
      this.configDac();
      if ((this.reg(0x1088) & 0x4000) && !this.dmaOn) this.startDma();
      return;
    }
    if (off === 0x1080) { this.sync(); this.regs.set(off, v >>> 0); return; }
    if (off === 0x1084) { this.regs.set(off, v & 0xffff); return; }
    if (off === 0x1088) {
      this.sync();
      const was = this.reg(off), pend = (was & 0x8000) && !(v & 0x8000);
      const ctrl = ((v & 0x7fff) | (pend ? 0x8000 : 0)) & 0xffff;
      this.regs.set(off, ctrl);
      if (!(was & 0x4000) && (ctrl & 0x4000)) { this.configDac(); this.startDma(); }
      else if ((was & 0x4000) && !(ctrl & 0x4000)) this.stopDma();
      this.updateIrq(); return;
    }
    this.regs.set(off, v & 0xffff);
  }
  configDac() {
    const ctrl = this.reg(0x1088), phase = this.reg(0x1064);
    this.dacStereo = (ctrl & 4) !== 0;
    const bytes = 1024 << (ctrl & 3);
    this.halfFrames = (bytes / 2) / (this.dacStereo ? 2 : 1) / 2;
    this.dacRate = phase ? DAC_CLOCK / (phase + 1) : 0;
  }
  startDma() {
    this.configDac();
    if (!this.dacRate || !this.halfFrames) return;
    this.dmaOn = true; this.dmaHalf = 0; this.fHead = 0; this.fTail = 0; this.fFrac = 0;
    this.fetchHalf(0);
    this.fetchHalf(1);
    this.dmaLeft = this.halfFrames * AUDIO_RATE / this.dacRate;
  }
  stopDma() { this.dmaOn = false; }
  fetchHalf(h) {
    const base = (this.reg(0x1080) >>> 0), words = this.halfFrames * (this.dacStereo ? 2 : 1);
    let addr = base + h * words * 2;
    for (let f = 0; f < this.halfFrames; f++) {
      const l = (this.bus.r16(addr) ^ 0x8000) << 16 >> 16; addr += 2;
      let r = l;
      if (this.dacStereo) { r = (this.bus.r16(addr) ^ 0x8000) << 16 >> 16; addr += 2; }
      const slot = ((this.fHead + f) % RING) * 2;
      this.fifo[slot] = l; this.fifo[slot + 1] = r;
    }
    this.fHead += this.halfFrames;
  }
  updateIrq() {
    const pend = (this.reg(0x1088) & 0x8000) !== 0 || ((this.reg(0x102c) | (this.reg(0x142c) << 16)) & this.fiqEnable()) !== 0;
    this.io.setSrc(0, pend);
  }
  startChannel(c) {
    const a = this.attrBase(c), C = this.ch[c];
    const mode = this.reg(a + 4), sel = this.reg(a + 0x34);
    C.waddr = ((mode & 0x3f) << 16 | this.reg(a)) >>> 0;
    C.loop = ((((mode >>> 6) & 0x3f) << 16) | this.reg(a + 8)) >>> 0;
    C.tone = (mode >>> 12) & 3;
    C.kind = (mode >>> 15) & 1 ? ((sel >>> 15) & 1 ? 'a36' : 'ima') : ((mode >>> 14) & 1 ? 'pcm16' : 'pcm8');
    C.wp = C.waddr; C.bp = C.waddr * 2; C.shift = 0; C.nib = 0; C.sig = 0; C.stepIdx = 0; C.hdr = 0; C.rem = 0; C.p0 = 0;
    C.last = 0; C.prev = 0; C.acc = 0; C.phaseAcc = 0; C.samples = 0; C.active = true; C.started = C.waddr;
    C.envAddr = (((this.reg(a + 0x1c) & 0x3f) << 16) | this.reg(a + 0x20)) >>> 0;
    this.regs.set(a + 0x14, ((this.reg(a + 0x14) & 0x00ff) | ((this.reg(a + 0x18) & 0xff) << 8)) >>> 0);
    this.starts++;
  }
  stopChannel(c, natural) {
    const C = this.ch[c];
    C.active = false; C.started = -1;
    const en = c < 16 ? 0x1000 : 0x1400, bit = c & 15;
    this.regs.set(en, (this.reg(en) & ~(1 << bit)) >>> 0);
    if (natural) {
      const sf = c < 16 ? 0x102c : 0x142c;
      this.regs.set(sf, (this.reg(sf) | (1 << bit)) >>> 0);
      this.updateIrq();
    }
  }
  wordAt(waddr) { return this.bus.r16(WAVE_BASE + waddr * 2) & 0xffff; }
  fetch(c) {
    const C = this.ch[c], bus = this.bus;
    if (C.kind === 'a36' && C.rem === 0 && C.tone !== 0) { C.hdr = this.wordAt(C.wp); C.rem = 8; C.wp++; }
    const w = C.tone === 0 ? (this.reg(this.attrBase(c) + 0x2c) & 0xffff) : this.wordAt(C.wp);
    if (C.tone !== 0 && w === 0xffff) {
      if (C.kind === 'pcm16' || ((C.kind === 'ima' || C.kind === 'a36') && C.nib === 0)) return this.endOrLoop(c);
    }
    switch (C.kind) {
      case 'pcm8': {
        const b = C.tone === 0 ? (w & 0xff) : (bus.r8(WAVE_BASE + C.bp) & 0xff);
        if (C.tone !== 0 && b === 0xff) return this.endOrLoop(c);
        C.prev = C.last; C.last = (b - 0x80) << 8;
        if (C.tone !== 0) { C.bp++; }
        return true;
      }
      case 'pcm16': {
        C.prev = C.last; C.last = (w ^ 0x8000) << 16 >> 16; C.wp++;
        return true;
      }
      case 'ima': {
        const nib = (w >>> (C.nib * 4)) & 15;
        const step = IMA_STEPS[C.stepIdx]; let d = step >> 3;
        if (nib & 4) d += step; if (nib & 2) d += step >> 1; if (nib & 1) d += step >> 2;
        if (nib & 8) d = -d;
        C.sig = clamp16(C.sig + d); C.stepIdx = Math.max(0, Math.min(88, C.stepIdx + IMA_INDEX[nib & 7]));
        C.prev = C.last; C.last = C.sig;
        if (++C.nib >= 4) { C.nib = 0; C.wp++; }
        return true;
      }
      case 'a36': {
        const shift = C.hdr & 15, filter = (C.hdr >> 4) & 0x3f, f0 = (filter & 0x20) ? filter - 64 : filter;
        const nib = (w >>> (C.nib * 4)) & 15;
        let sd = ((nib << 12) << 16) >> 16; sd = (sd >> shift) + (((C.p0 * f0) + 32) >> 12); sd = (sd << 16) >> 16;
        C.p0 = sd; C.prev = C.last; C.last = sd;
        if (++C.nib >= 4) { C.nib = 0; C.wp++; C.rem--; }
        return true;
      }
    }
    return true;
  }
  endOrLoop(c) {
    const C = this.ch[c];
    if (C.tone === 2) {
      C.wp = C.loop; C.bp = C.loop * 2;
      C.nib = 0; C.shift = 0; C.rem = 0;
      C.sig = 0; C.stepIdx = 0;
      C.hdr = 0; C.p0 = 0;
      return true;
    }
    return false;
  }
  tickEnvelope(c) {
    const a = this.attrBase(c), C = this.ch[c];
    const d0 = this.reg(a + 0x14), e0 = this.reg(a + 0x10), e1 = this.reg(a + 0x18), lc = this.reg(a + 0x28);
    let count = (d0 >> 8) & 0xff, edd = d0 & 0x7f;
    const inc = e0 & 0x7f, sign = (e0 & 0x80) !== 0, target = (e0 >> 8) & 0x7f;
    const setCount = k => this.regs.set(a + 0x14, ((this.reg(a + 0x14) & 0x00ff) | (k << 8)) >>> 0);
    const setEdd = k => this.regs.set(a + 0x14, ((this.reg(a + 0x14) & 0xff80) | k) >>> 0);
    const load = () => this.reg(a + 0x18) & 0xff;
    if (count > 0) { count--; setCount(count); }
    if (count !== 0) return;
    let ne = edd;
    if (ne !== target) {
      if (sign) {
        ne -= inc; if (ne > edd) ne = 0; else if (ne < target) ne = target;
        if (ne === 0) { setEdd(0); this.stopChannel(c, true); return; }
      } else { ne += inc; if (ne >= target) ne = target; }
    }
    if (ne === target) {
      if (e1 & 0x100) {
        const rc = ((e1 >> 9) & 0x7f) - 1;
        if (rc === 0) {
          const base = (((this.reg(a + 0x1c) & 0x3f) << 16) | this.reg(a + 0x20)) >>> 0;
          this.regs.set(a + 0x10, this.wordAt(base)); this.regs.set(a + 0x18, this.wordAt(base + 1)); this.regs.set(a + 0x28, this.wordAt(base + 2));
          C.envAddr = (base + (lc & 0x1ff)) >>> 0;
        } else this.regs.set(a + 0x18, ((e1 & ~0xfe00) | (rc << 9)) >>> 0);
      } else {
        this.regs.set(a + 0x10, this.wordAt(C.envAddr)); this.regs.set(a + 0x18, this.wordAt(C.envAddr + 1));
        C.envAddr = (C.envAddr + 2) >>> 0;
      }
      setCount(load());
    } else setCount(load());
    setEdd(ne);
  }
  envClk(c) {
    let nib;
    if (c < 4) nib = (this.reg(0x1018) >>> (c * 4)) & 0xf;
    else if (c < 8) nib = (this.reg(0x101c) >>> ((c - 4) * 4)) & 0xf;
    else if (c < 12) nib = (this.reg(0x1020) >>> ((c - 8) * 4)) & 0xf;
    else nib = (this.reg(0x1024) >>> ((c - 12) * 4)) & 0xf;
    return ENV_CLK_FRAMES[nib];
  }
  sync() {
    const cpu = this.io.cpu;
    if (!cpu) return;
    const ips = (this.io.frameLen || 1500000) * 59.94;
    const target = Math.floor(cpu.cycles * AUDIO_RATE / ips);
    if (target > this.done) { this.render(target - this.done); this.done = target; }
  }
  render(n) {
    const volsel = VOLSEL[(this.reg(0x1034) >> 6) & 3], noint = (this.reg(0x1034) & 0x200) !== 0;
    const master = (this.reg(0x1004) & 0x7f) / 127;
    const envMode = this.reg(0x1054), fifoOn = (this.reg(0x1034) & 0x1000) !== 0 && this.dmaOn && this.dacRate > 0;
    const fStep = fifoOn ? Math.floor(this.dacRate * 65536 / AUDIO_RATE) : 0;
    const frameStep = MAME_FRAME_HZ / AUDIO_RATE;
    for (let s = 0; s < n; s++) {
      let mixL = 0, mixR = 0, dacL = 0, dacR = 0;
      this.mameAcc += frameStep;
      while (this.mameAcc >= 1) {
        this.mameAcc -= 1;
        for (let c = 0; c < 16; c++) {
          const C = this.ch[c];
          if (!C.active || ((envMode >> c) & 1)) continue;
          if (C.envClk > 0) C.envClk--;
          if (C.envClk === 0) { this.tickEnvelope(c); C.envClk = this.envClk(c); }
        }
      }
      if (fifoOn) {
        let pos = this.fTail + (this.fFrac >>> 16);
        if (pos >= this.fHead) pos = this.fHead ? this.fHead - 1 : 0;
        const slot = (pos % RING) * 2;
        dacL = this.fifo[slot]; dacR = this.fifo[slot + 1];
        this.fFrac += fStep;
      } else { mixL += this.waveIn[0]; mixR += this.waveIn[1]; }
      for (let c = 0; c < 24; c++) {
        const C = this.ch[c]; if (!C.active) continue;
        const a = this.attrBase(c), phase = this.reg(this.phaseBase(c)) & 0x7ffff;
        if (!phase) continue;
        C.phaseAcc += phase * WAVE_INC;
        let alive = true;
        while (C.phaseAcc >= 0x10000) {
          C.phaseAcc -= 0x10000;
          if (!this.fetch(c)) { alive = false; break; }
        }
        if (!alive) { C.active = false; C.started = -1; this.stopChannel(c, true); continue; }
        let sm = C.last;
        if (!noint) { const lf = C.phaseAcc >>> 8; sm = ((C.last * lf) >> 8) + ((C.prev * (256 - lf)) >> 8); }
        const w3 = this.reg(a + 0xc), vol = w3 & 0x7f, pan = (w3 >> 8) & 0x7f;
        const edd = this.reg(a + 0x14) & 0x7f;
        const v = Math.trunc(sm * vol * edd / (127 * 127));
        let pl, pr;
        if (pan < 64) { pl = 127; pr = pan * 2; } else { pl = (127 - pan) * 2; pr = 127; }
        mixL += (v * pl) >> 7; mixR += (v * pr) >> 7;
      }
      if (this.dmaOn) {
        this.fTail += this.fFrac >>> 16; this.fFrac &= 0xffff;
        if (this.fTail > this.fHead) this.fTail = this.fHead;
        this.dmaLeft -= 1;
        if (this.dmaLeft <= 0) {
          this.dmaHalf ^= 1; this.fetchHalf(this.dmaHalf);
          this.io.spu.set(0x1088, (this.reg(0x1088) | 0x8000) >>> 0);
          this.dmaLeft += this.halfFrames * AUDIO_RATE / this.dacRate;
          this.updateIrq();
        }
      }
      let oL = clamp16(Math.trunc((mixL * master + dacL) * volsel)), oR = clamp16(Math.trunc((mixR * master + dacR) * volsel));
      let lo = oL / 32768, ro = oR / 32768;
      const yl = lo - this.xl + 0.9990 * this.yl, yr = ro - this.xr + 0.9990 * this.yr; this.xl = lo; this.xr = ro; this.yl = yl; this.yr = yr;
      lo = Math.max(-1, Math.min(1, yl)); ro = Math.max(-1, Math.min(1, yr));
      this.peak = Math.max(this.peak, Math.abs(lo), Math.abs(ro));
      if (this.count + 2 > this.ring.length) { this.rd = (this.rd + 2) % this.ring.length; this.count -= 2; }
      this.ring[this.wr] = this.muted ? 0 : lo; this.ring[this.wr + 1] = this.muted ? 0 : ro;
      this.wr = (this.wr + 2) % this.ring.length; this.count += 2; this.samplesOut++;
    }
  }
  pull(n, ratio = 1) {
    const out = new Float32Array(n * 2), cap = this.ring.length;
    if (this.holdL === undefined) { this.holdL = 0; this.holdR = 0; }
    for (let i = 0; i < n; i++) {
      if (this.count < 4) {
        if (!this._underrunActive) { this._underrunActive = true; this.underrunRuns++; }
        this.underruns++;
        this.holdL *= 0.9965; this.holdR *= 0.9965;
        out[2 * i] = this.holdL; out[2 * i + 1] = this.holdR;
        continue;
      }
      this._underrunActive = false;
      const r1 = (this.rd + 2) % cap, f = this.pos;
      const l = this.ring[this.rd] * (1 - f) + this.ring[r1] * f, r = this.ring[this.rd + 1] * (1 - f) + this.ring[r1 + 1] * f;
      out[2 * i] = l; out[2 * i + 1] = r; this.holdL = l; this.holdR = r;
      this.pos += ratio;
      while (this.pos >= 1 && this.count >= 4) { this.pos -= 1; this.rd = (this.rd + 2) % cap; this.count -= 2; }
    }
    return out;
  }
  buffered() { return this.count >> 1; }
  drain(maxFrames) {
    const n = Math.min(maxFrames, this.count >> 1), out = new Float32Array(n * 2);
    for (let i = 0; i < n * 2; i++) { out[i] = this.ring[this.rd]; this.rd = (this.rd + 1) % this.ring.length; }
    this.count -= n * 2; return out;
  }
}

// =============================================================================
// IO (ex-io.js)
// =============================================================================
const EMPTY = [];
class IO {
  constructor() {
    this.uartOut = []; this.onUartChar = null;
    this.unmodeled = new Map();
    this.tveCtl = 0; this.tveFade = 0; this.tvAddr = [0, 0, 0]; this.bufctl = 3;
    this.cpu = null;
    this.servo = new Servo();
    this.timerDiv = +(globalThis.process?.env?.TIMERDIV) || 64;
    this.asserted = [0, 0];
    this.mask = [0xffffffff, 0xffffffff];
    this.ppu = new Map();
    this.ppuCtrl = 0; this.ppuStatus = 0;
    this.timers = Array.from({ length: 6 }, () => ({ ctrl: 0, ccp: 0, preload: 0, up: 0, rate: 0 }));
    this.frameCycles = 0; this.frameLen = 1500000;
    this.rasterLines = 525; this.rasterVis = 240; this.vblankLines = 0;
    this.frames = 0;
    this.spu = new Map(); this.spuTimer = new Float64Array(32); this.spuPlayFrames = 3; this.softFifo = 0; this.softIrqEn = 0; this.softIrqSts = 0; this.softThr = 0; this.softSamples = 0; this.softAcc = 0; this.beat = { en: 0, sts: 0, base: 0, cnt: 0, acc: 0 }; this.spuLog = [];
    this.i2c = { cr: 0, intr: 0, cvr: 0, id: 0, addr: 0, wdata: 0, rdata: 0 };
    this.padIn = [[0, 0, 0x7f, 0x7f], [0, 0, 0x7f, 0x7f]]; this.padLatch = [[0, 0, 0, 0], [0, 0, 0, 0]];
    this._audioAcc = 0;
  }
  attach(bus, cpu) {
    if (cpu) this.cpu = cpu;
    this.spuChip = new SPU(this, bus);
    for (const base of [0x08000000, 0x88000000]) {
      bus.addMMIO(base, 0x01000000, 'io', { read: (o, sz) => this.read(o, sz), write: (o, v, sz) => this.write(o, v, sz) });
    }
  }
  spuRead(off) {
    if (off === 0x1014) return ((this.beat.en << 15) | (this.beat.sts << 14) | (this.beat.cnt & 0x3fff)) >>> 0;
    if (this.spuChip) return this.spuChip.read(off) >>> 0;
    return this.spu.get(off) ?? 0;
  }
  spuWrite(off, v) {
    if (off === 0x1010) this.beat.base = v & 0x7ff;
    else if (off === 0x1014) { this.beat.en = (v >>> 15) & 1; this.beat.cnt = v & 0x3fff; this.beat.acc = 0; if (!this.beat.en) this.beat.sts = 0; }
    if (this.spuChip) this.spuChip.write(off, v >>> 0);
    else this.spu.set(off, v >>> 0);
    if (this.spuLog.length < 60 && off >= 0x1000) this.spuLog.push(`+${off.toString(16)}=${(v >>> 0).toString(16)}`);
  }
  i2cSlaveRead(addr) {
    const port = (addr >> 4) & 15, a = addr & 15;
    if (port >= 2) return 0xffff;
    if (a < 4) { this.padLatch[port][a] = this.padIn[port][a]; return this.padLatch[port][a]; }
    const L = this.padLatch[port]; return (((L[0] + L[1] + L[2] + L[3]) << 2) | port) & 0xffff;
  }
  setSrc(n, on) { const w = n >> 5, b = 1 << (n & 31); this.asserted[w] = on ? (this.asserted[w] | b) >>> 0 : (this.asserted[w] & ~b) >>> 0; }
  pendingList() {
    if (((this.asserted[0] & ~this.mask[0]) | (this.asserted[1] & ~this.mask[1])) === 0) return EMPTY;
    const o = [];
    for (let n = 0; n < 40; n++) { const w = n >> 5, b = 1 << (n & 31); if ((this.asserted[w] & b) && !(this.mask[w] & b)) o.push(n); }
    return o;
  }
  nextEventCycles() {
    let n = this.frameLen - this.frameCycles;
    for (let i = 0; i < 6; i++) { const T = this.timers[i]; if (T.ctrl & 0x80000000) n = Math.min(n, Math.ceil((0x10000 - T.up) * this.timerDiv)); }
    return Math.max(1, Math.min(n, 200000));
  }
  tick(cycles) {
    this.frameCycles += cycles;
    if (this.frameCycles >= this.frameLen) {
      this.frameCycles -= this.frameLen; this.frames++;
      this.ppuStatus |= 1;
      if (this.onFrame) this.onFrame();
    }
    this.setSrc(10, (this.ppuStatus & 1) && (this.ppuCtrl & 1));
    let t = false;
    for (let i = 0; i < 6; i++) {
      const T = this.timers[i];
      if (T.ctrl & 0x80000000) {
        T.up += cycles / this.timerDiv;
        if (T.up >= 0x10000) { T.up = T.preload & 0xffff; T.ctrl |= 0x04000000; }
      }
      if ((T.ctrl & 0x08000000) && (T.ctrl & 0x04000000)) t = true;
    }
    this.setSrc(7, t);
    this._audioAcc += cycles;
    if (this._audioAcc >= 8192) { this._audioAcc = 0; if (this.spuChip) this.spuChip.sync(); }
    const B = this.beat;
    if (B.en && B.base * B.cnt > 0) { B.acc += cycles; const per = B.base * B.cnt * 14.208 * this.frameLen / 16667; if (B.acc >= per) { B.acc -= per; B.sts = 1; } }
    this.setSrc(1, B.en && B.sts);
    const I = this.i2c;
    if (I.busy > 0 && (I.busy -= cycles) <= 0) {
      I.busy = 0; if (I.cr & 0x40) I.rdata = this.i2cSlaveRead(I.addr); I.cr |= (I.start & 1 ? 0x08 : 0) | (I.start & 2 ? 0x10 : 0) | (I.start & 4 ? 0x20 : 0); I.intr |= 1;
    }
    this.setSrc(24, (I.intr & 3) === 3);
    if (this.cpu) {
      const p = this.pendingList();
      if (p.length) { this.cpu.sleeping = this.cpu.sleeping; if (this.cpu.interrupt(p[0])) this.cpu.sleeping = false; }
    }
  }
  read(o, sz) {
    const seg = o >>> 16, off = o & 0xffff;
    if (seg === 0x15) return this.uartRead(off);
    if (seg === 0x0a) return this.intcRead(off);
    if (seg === 0x01) return this.ppuRead(off);
    if (seg === 0x16) return this.timerRead(off);
    if (seg === 0x13) return this.i2cRead(off);
    if (seg === 0x05) return this.spuRead(off);
    if (seg === 0x06) return this.servo.read(off);
    if (seg === 0x03 && off === 0) return this.tveCtl;
    if (seg === 0x07 && off < 12) return this.tvAddr[off >> 2];
    this.note(o, 'R');
    return sz === 4 ? 0xffffffff : sz === 2 ? 0xffff : 0xff;
  }
  write(o, v, sz) {
    const seg = o >>> 16, off = o & 0xffff;
    if (seg === 0x15) return this.uartWrite(off, v);
    if (seg === 0x0a) return this.intcWrite(off, v);
    if (seg === 0x01) return this.ppuWrite(off, v);
    if (seg === 0x16) return this.timerWrite(off, v);
    if (seg === 0x13) return this.i2cWrite(off, v);
    if (seg === 0x05) return this.spuWrite(off, v);
    if (seg === 0x06) return this.servo.write(off, v);
    if (seg === 0x03) { if (off === 0) this.tveCtl = v & 0xffff; else if (off === 0x0c) this.tveFade = v & 0xff; }
    else if (seg === 0x07 && off < 12) this.tvAddr[off >> 2] = v >>> 0;
    else if (seg === 0x09 && off === 0x20) this.bufctl = v & 3;
    this.note(o, 'W');
  }
  note(o, k) { const key = '0x88' + o.toString(16).padStart(6, '0') + k; this.unmodeled.set(key, (this.unmodeled.get(key) || 0) + 1); }
  intcRead(off) {
    const p = this.pendingList(); let lo = 0, hi = 0;
    for (const n of p) { if (n < 32) lo |= 1 << n; else hi |= 1 << (n - 32); }
    switch (off) { case 0x00: return lo >>> 0; case 0x04: return hi; case 0x20: return this.mask[0]; case 0x24: return this.mask[1]; }
    return 0;
  }
  intcWrite(off, v) { if (off === 0x20) this.mask[0] = v >>> 0; else if (off === 0x24) this.mask[1] = v >>> 0; }
  ppuRead(off) {
    if (off === 0x80) return this.ppuCtrl; if (off === 0x84) return this.ppuStatus;
    if (off === 0x94) {
      const vpos = Math.floor(this.frameCycles * this.rasterLines / this.frameLen), line = (this.vblankLines + vpos % this.rasterLines) >>> 0;
      if (this.spinRaster && this.cpu) { const lineCycles = this.frameLen / this.rasterLines; this.pendingLineSkip = Math.ceil(lineCycles - (this.frameCycles % lineCycles)); }
      return line;
    }
    return this.ppu.get(off) ?? 0;
  }
  ppuWrite(off, v) {
    if (off === 0x80) { this.ppuCtrl = v & 7; return; }
    if (off === 0x84) { this.ppuStatus &= ~v; return; }
    this.ppu.set(off, v);
  }
  timerRead(off) {
    const n = off >>> 12, r = off & 0xfff; if (n > 5) return 0; const T = this.timers[n];
    switch (r) { case 0: return T.ctrl >>> 0; case 4: return T.ccp >>> 0; case 8: return T.preload >>> 0; case 0x10: return Math.floor(T.up) >>> 0; }
    return 0;
  }
  timerWrite(off, v) {
    const n = off >>> 12, r = off & 0xfff; if (n > 5) return; const T = this.timers[n];
    if (r === 0) { const F = 0x04000000; const keep = T.ctrl & F & ~v; T.ctrl = ((v & ~F) | keep) >>> 0; if ((v & 0x80000000) && !T.wasEn) T.up = T.preload & 0xffff; T.wasEn = !!(v & 0x80000000); T.wlog = (T.wlog || []).concat(v.toString(16)).slice(-4); }
    else if (r === 4) T.ccp = v; else if (r === 8) { T.preload = v; }
  }
  i2cRead(off) {
    const I = this.i2c;
    switch (off) { case 0x20: return I.cr; case 0x24: return I.intr; case 0x28: return I.cvr; case 0x2c: return I.id; case 0x30: return I.addr; case 0x34: return I.wdata; case 0x38: return I.rdata; }
    return 0;
  }
  i2cWrite(off, v) {
    const I = this.i2c;
    switch (off) {
      case 0x20: {
        I.cr = v & ~0x38 & ~0x7;
        if (v & 7) { I.start = v & 7; I.busy = 2000; }
        break;
      }
      case 0x24: I.intr = (v & 2) | ((I.intr & 1) & v); break;
      case 0x28: I.cvr = v; break; case 0x2c: I.id = v; break; case 0x30: I.addr = v; break; case 0x34: I.wdata = v; break;
    }
  }
  uartRead(off) {
    switch (off) { case 0x00: return 0; case 0x04: return 0; case 0x08: return 0; case 0x0c: return 0; case 0x10: return 0x90; }
    return 0;
  }
  uartWrite(off, v) {
    if (off === 0) { const c = v & 0xff; this.uartOut.push(c); if (this.onUartChar) this.onUartChar(c); }
  }
}

// =============================================================================
// PPU (ex-ppu.js)
// =============================================================================
const SCREEN_W = 320, SCREEN_H = 240;
function ppuSize(machine) {
  if (machine.io.tveCtl) { const t = machine.io.tveCtl & 0xc; return t === 4 ? [640, 480] : t === 8 ? [640, 240] : [320, 240]; }
  const r = (machine.io.ppu.get(0) ?? 0) & 3; return r === 1 ? [640, 480] : r === 2 ? [640, 240] : [320, 240];
}
const TX = [
  { x: 0x20, y: 0x24, attr: 0x28, ctl: 0x2c, ptr: 0x30, blend: 0x38, buf: 0xa0 },
  { x: 0x3c, y: 0x40, attr: 0x44, ctl: 0x48, ptr: 0x4c, blend: 0x54, buf: 0xac },
  { x: 0x58, y: 0x5c, attr: 0x60, ctl: 0x64, ptr: 0x68, blend: 0x70, buf: 0xb8 },
];
const L5 = new Uint8Array(32), L6 = new Uint8Array(64);
for (let v = 0; v < 32; v++) L5[v] = (v << 3) | (v >> 2);
for (let v = 0; v < 64; v++) L6[v] = (v << 2) | (v >> 4);
const _fadeCache = new Map(), _tmpClamp = new Uint8ClampedArray(1);
function fadeLUT(f) {
  let t = _fadeCache.get(f); if (t) return t;
  t = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) { _tmpClamp[0] = v * f / 255; t[v] = _tmpClamp[0]; }
  _fadeCache.set(f, t); return t;
}

function renderPPU(machine, out) {
  const P = machine.io.ppu, bus = machine.bus, g = (o) => (P.get(o) ?? 0) >>> 0, [W, H] = ppuSize(machine);
  const dv = bus.dv, ramLen = bus.ram.length;
  const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const out32 = LE ? new Uint32Array(out.buffer, out.byteOffset, out.length >> 2) : null;
  if (out32) out32.fill(0xff000000); else { out.fill(0); for (let i = 3; i < out.length; i += 4) out[i] = 255; }
  let drew = false;
  const ctrl = g(0), blendMode = g(0x0c), transrgb = g(0x10);
  const transOn = (transrgb & 0x10000) !== 0, transV = transrgb & 0xffff;
  const pal1 = new Uint16Array(512), pal2 = new Uint16Array(512);
  for (let i = 0; i < 512; i++) { pal1[i] = g(0x1000 + 4 * i) & 0xffff; pal2[i] = g(0x1800 + 4 * i) & 0xffff; }
  const putBlend = (x, y, r, gg, b, blend) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4, sub = blendMode & 1, l0 = blend, l1 = 63 - blend;
    const R = sub ? (out[o] * l0 / 63 | 0) - (r * l1 / 63 | 0) : (out[o] * l0 / 63 | 0) + (r * l1 / 63 | 0);
    const G = sub ? (out[o + 1] * l0 / 63 | 0) - (gg * l1 / 63 | 0) : (out[o + 1] * l0 / 63 | 0) + (gg * l1 / 63 | 0);
    const B = sub ? (out[o + 2] * l0 / 63 | 0) - (b * l1 / 63 | 0) : (out[o + 2] * l0 / 63 | 0) + (b * l1 / 63 | 0);
    out[o] = R; out[o + 1] = G; out[o + 2] = B; drew = true;
  };
  const argb1555 = (x, y, v, blend) => {
    if (v & 0x8000) return;
    const r = L5[(v >> 10) & 31], gg = L5[(v >> 5) & 31], b = L5[v & 31];
    if (blend) { putBlend(x, y, r, gg, b, blend); return; }
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4; out[o] = r; out[o + 1] = gg; out[o + 2] = b; out[o + 3] = 255; drew = true;
  };
  const rgb565 = (x, y, v, blend) => {
    if (transOn && transV === v) return;
    const r = L5[(v >> 11) & 31], gg = L6[(v >> 5) & 63], b = L5[v & 31];
    if (blend) { putBlend(x, y, r, gg, b, blend); return; }
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4; out[o] = r; out[o + 1] = gg; out[o + 2] = b; out[o + 3] = 255; drew = true;
  };
  const put = (x, y, r, gg, b, blend) => {
    if (blend) { putBlend(x, y, r, gg, b, blend); return; }
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4; out[o] = r; out[o + 1] = gg; out[o + 2] = b; out[o + 3] = 255; drew = true;
  };
  const blitBitmap = (L, ctl, posy, posx, blend) => {
    const nptr = g(L.ptr) >>> 0, buf = g(L.buf) >>> 0, maxX = W + posx, maxY = H + posy, is565 = (ctl & 0x1000) !== 0;
    if (out32 && !blend) {
      for (let y = 0; y < maxY; y++) {
        const dy = y - posy; if (dy < 0 || dy >= H) continue;
        const line = (ctl & 0x04) ? 0 : y, rowBase = (buf + ((bus.r32(nptr + line * 4) * 2) >>> 0)) >>> 0, rowOut = dy * W;
        const inRam = (rowBase >>> 24) === 0xa0 && (rowBase & 0xffffff) + maxX * 2 <= ramLen, ro = rowBase & 0xffffff;
        for (let x = 0; x < maxX; x += 2) {
          const data = inRam ? dv.getUint32(ro + x * 2, true) : bus.r32(rowBase + x * 2);
          for (let b = 0; b < 2; b++) {
            const v = (data >>> (16 * b)) & 0xffff, dx = x + b - posx;
            if (dx < 0 || dx >= W) continue;
            let r, gg, bl;
            if (is565) { if (transOn && transV === v) continue; r = L5[(v >> 11) & 31]; gg = L6[(v >> 5) & 63]; bl = L5[v & 31]; }
            else { if (v & 0x8000) continue; r = L5[(v >> 10) & 31]; gg = L5[(v >> 5) & 31]; bl = L5[v & 31]; }
            out32[rowOut + dx] = r | (gg << 8) | (bl << 16) | 0xff000000; drew = true;
          }
        }
      }
      return;
    }
    for (let y = 0; y < maxY; y++) {
      const line = (ctl & 0x04) ? 0 : y, txStart = (bus.r32(nptr + line * 4) * 2) >>> 0, rowBase = buf + txStart;
      const dy = y - posy;
      for (let x = 0; x < maxX; x += 2) {
        const data = bus.r32(rowBase + x * 2);
        for (let b = 0; b < 2; b++) {
          const v = (data >>> (16 * b)) & 0xffff, dx = x + b - posx;
          if (is565) rgb565(dx, dy, v, blend); else argb1555(dx, dy, v, blend);
        }
      }
    }
  };
  const blitCharacter = (L, ctl, attr, posy, posx, blend) => {
    const nptr = g(L.ptr) >>> 0, buf = g(L.buf) >>> 0, hsize = 8 << ((attr >> 4) & 3), vsize = 8 << ((attr >> 6) & 3);
    const bitPixel = ((attr & 3) + 1) << 1, penBank = ((attr >> 8) & 31) * 0x10, pixelWord = 32 / bitPixel, charsLine = 1024 / hsize, penMask = (1 << bitPixel) - 1;
    const maxX = Math.floor((W + posx) / vsize) + 1, maxY = Math.floor((H + posy) / hsize) + 1, is565 = (ctl & 0x1000) !== 0;
    const fast = out32 && !blend && bitPixel !== 6;
    for (let y = 0; y <= maxY; y++) for (let x = 0; x <= maxX; x++) {
      const line = (ctl & 0x04) ? 0 : y, addr = line * charsLine + x, charId = bus.r16(nptr + addr * 2) & 0xffff, charAddr = buf + charId * hsize * vsize;
      if (fast) {
        const cellX = x * hsize - posx, cellY = y * vsize - posy;
        for (let cy = 0; cy < vsize; cy++) {
          const py = cellY + cy; if (py < 0 || py >= H) continue;
          const lineAddr = charAddr + cy * hsize, rowOut = py * W;
          for (let gr = 0; gr < hsize / pixelWord; gr++) {
            let lastK = -1, data = 0;
            for (let i = 0; i < pixelWord; i++) {
              const cx = gr * pixelWord + i, px = cellX + cx;
              if (px < 0 || px >= W) continue;
              const k = (cx * bitPixel) >> 3;
              if (k !== lastK) { data = bus.r32(lineAddr + k); lastK = k; }
              const pen = (data >>> ((cx % pixelWord) * bitPixel)) & penMask, pix = pal1[(penBank + pen) & 0x1ff];
              if (is565) { if (transOn && transV === pix) continue; out32[rowOut + px] = L5[(pix >> 11) & 31] | (L6[(pix >> 5) & 63] << 8) | (L5[pix & 31] << 16) | 0xff000000; }
              else { if (pix & 0x8000) continue; out32[rowOut + px] = L5[(pix >> 10) & 31] | (L5[(pix >> 5) & 31] << 8) | (L5[pix & 31] << 16) | 0xff000000; }
              drew = true;
            }
          }
        }
        continue;
      }
      for (let cy = 0; cy < vsize; cy++) {
        const lineAddr = charAddr + cy * hsize, py = y * vsize + cy - posy;
        for (let cx = 0; cx < hsize; cx++) {
          const data = bus.r32(lineAddr + Math.floor((cx * bitPixel) / 8)), pen = (data >>> ((cx % pixelWord) * bitPixel)) & penMask;
          const pix = pal1[(penBank + pen) & 0x1ff], px = x * hsize + cx - posx;
          if (is565) rgb565(px, py, pix, blend); else argb1555(px, py, pix, blend);
        }
      }
    }
  };
  const spBuf = g(0xd0) >>> 0;
  const blitSprite = (i) => {
    const control = g(0x4000 + 8 * i), attr = g(0x4004 + 8 * i);
    const num = control & 0xffff; if (num === 0) return;
    let sx = (control >>> 16) & 0x3ff, sy = (attr >>> 16) & 0x3ff;
    const hsize = 8 << ((attr >> 4) & 3), vsize = 8 << ((attr >> 6) & 3), bitPixel = ((attr & 3) + 1) << 1, flip = (attr >> 2) & 3;
    const penBank = ((attr >> 8) & 31) * 0x10, blend = (attr & 0x8000) ? 0x3f - ((attr >>> 26) & 0x3f) : 0;
    const pixelWord = 32 / bitPixel, pixelByte = 8 / bitPixel, wordLine = hsize / pixelWord, penMask = (1 << bitPixel) - 1;
    const base = spBuf + num * (hsize * vsize * bitPixel / 8);
    if (sx > W - 1) sx = (sx & 0x3ff) - 0x400;
    if (sy > H - 1) sy = (sy & 0x3ff) - 0x400;
    for (let y = 0; y < vsize; y++) for (let x = 0; x < wordLine; x++) {
      let data = bus.r32(base + (y * wordLine + x) * 4);
      for (let k = 0; k < 4; k++) {
        for (let b = 0; b < pixelByte; b++) {
          const bitpos = k * pixelByte + b, pen = (data >>> (8 - (b + 1) * bitPixel)) & penMask;
          const px = (flip & 1) ? sx + (hsize - (x * pixelWord + bitpos)) : sx + x * pixelWord + bitpos;
          const py = (flip & 2) ? sy + (vsize - y) : sy + y;
          const v = pal2[(penBank + pen) & 0x1ff];
          if (out32 && !blend) {
            if (!(v & 0x8000) && px >= 0 && py >= 0 && px < W && py < H) { out32[py * W + px] = L5[(v >> 10) & 31] | (L5[(v >> 5) & 31] << 8) | (L5[v & 31] << 16) | 0xff000000; drew = true; }
          } else argb1555(px, py, v, blend);
        }
        data >>>= 8;
      }
    }
  };
  if (ctrl & 0x1000) {
    const spCtl = g(4), spMax = g(8) & 0x1ff;
    for (let depth = 0; depth < 4; depth++) {
      for (let l = 0; l < 3; l++) {
        const L = TX[l], ctl = g(L.ctl), attr = g(L.attr);
        if (!(ctl & 8) || ((attr >> 13) & 3) !== depth) continue;
        const blend = (ctl & 0x100) ? g(L.blend) & 0x3f : 0;
        let posx = g(L.x) & 0x3ff; if (posx & 0x200) posx -= 0x400;
        let posy = g(L.y) & 0x1ff; if (posy & 0x100) posy -= 0x200;
        if (ctl & 1) blitBitmap(L, ctl, posy, posx, blend); else blitCharacter(L, ctl, attr, posy, posx, blend);
      }
      if (spCtl & 1) for (let i = 0; i <= spMax; i++) if (((g(0x4004 + 8 * i) >> 13) & 3) === depth) blitSprite(i);
    }
  }
  const io = machine.io;
  if (io.bufctl < 3 && io.tvAddr[io.bufctl]) {
    const base = io.tvAddr[io.bufctl], inter = (io.tveCtl & 1) !== 0;
    for (let y = 0; y < H; y += (inter ? 1 : 2)) for (let x = 0; x < W; x++) {
      const v = bus.r16(base + (y * W + x) * 2), r = L5[(v >> 11) & 31], gg = L6[(v >> 5) & 63], b = L5[v & 31];
      put(x, y, r, gg, b, 0); if (!inter) put(x, y + 1, r, gg, b, 0);
    }
    drew = true;
  }
  if (io.tveFade) {
    const f = 255 - io.tveFade, lut = fadeLUT(f);
    for (let i = 0; i < W * H * 4; i += 4) { out[i] = lut[out[i]]; out[i + 1] = lut[out[i + 1]]; out[i + 2] = lut[out[i + 2]]; }
  }
  return drew;
}

// =============================================================================
// JIT (ex-jit.js)
// =============================================================================
const MAXLEN = 128;
const RAM_X = (a) => `((${a} >>> 24) | 32) === 0xa0`;
const L32 = (aExpr, dst) => `{ const q = (${aExpr}) >>> 0; ${dst} = ${RAM_X('q')} ? dv.getInt32(q & 0xffffff, true) : bus.r32(q); }`;
const L16S = (aExpr, dst) => `{ const q = (${aExpr}) >>> 0; ${dst} = ${RAM_X('q')} ? (dv.getUint16(q & 0xffffff, true) << 16) >> 16 : (bus.r16(q) << 16) >> 16; }`;
const L16U = (aExpr, dst) => `{ const q = (${aExpr}) >>> 0; ${dst} = ${RAM_X('q')} ? dv.getUint16(q & 0xffffff, true) : bus.r16(q); }`;
const L8S = (aExpr, dst) => `{ const q = (${aExpr}) >>> 0; ${dst} = ${RAM_X('q')} ? (ram[q & 0xffffff] << 24) >> 24 : (bus.r8(q) << 24) >> 24; }`;
const L8U = (aExpr, dst) => `{ const q = (${aExpr}) >>> 0; ${dst} = ${RAM_X('q')} ? ram[q & 0xffffff] : bus.r8(q); }`;
const S32 = (aExpr, v) => `{ const q = (${aExpr}) >>> 0; if (${RAM_X('q')}) { const o = q & 0xffffff; dv.setInt32(o, ${v}, true); if (o < 0x400000 && (cw[o >>> 2] | cw[(o + 3) >>> 2]) !== 0) cpu.onCodeWrite(o); } else bus.w32(q, ${v}); }`;
const S16 = (aExpr, v) => `{ const q = (${aExpr}) >>> 0; if (${RAM_X('q')}) { const o = q & 0xffffff; dv.setUint16(o, ${v}, true); if (o < 0x400000 && (cw[o >>> 2] | cw[(o + 1) >>> 2]) !== 0) cpu.onCodeWrite(o); } else bus.w16(q, ${v}); }`;
const S8 = (aExpr, v) => `{ const q = (${aExpr}) >>> 0; if (${RAM_X('q')}) { const o = q & 0xffffff; ram[o] = ${v}; if (o < 0x400000 && cw[o >>> 2] !== 0) cpu.onCodeWrite(o); } else bus.w8(q, ${v}); }`;
const condExpr = (cc) => cc === 4 ? 'cpu.Z === 1' : cc === 5 ? 'cpu.Z === 0' : `cpu.cond(${cc}, true)`;

function buildBlock(cpu, startPc) {
  const bus = cpu.bus, hm = cpu.hookMask;
  const out = []; let pc = startPc >>> 0, k = 0, term = false;
  while (k < MAXLEN) {
    if (k > 0) {
      if ((pc & 0xfff) === 0) break;
      if (hm !== undefined && hm[(pc & 0xffffff) >>> 1] && (pc >>> 24) === 0xa0) break;
    }
    let size, e;
    if (pc & 2) { size = 2; e = emit16(cpu, bus.r16(pc) & 0x7fff, pc, k); }
    else {
      const w = bus.r32(pc);
      if ((w >>> 15) & 1) { size = 4; e = emit32(cpu, ((((w >>> 16) & 0x7fff) << 15) | (w & 0x7fff)) >>> 0, pc, k); }
      else if (!(w >>> 31)) { size = 2; e = emit16(cpu, w & 0x7fff, pc, k); }
      else break;
    }
    out.push(e.code); k++; pc = (pc + size) >>> 0;
    if (e.term) { term = true; break; }
  }
  if (k === 0) return null;
  if (!term) out.push(`return ${U(pc)};`);
  return { src: 'return function(){\n' + out.join('\n') + '\n};', len: k, endPc: pc };
}

function compileBlock(cpu, src) { return new Function('cpu', 'r', 'bus', 'cr', 'dv', 'ram', 'cw', src)(cpu, cpu.r, cpu.bus, cpu.cr, cpu.bus.dv, cpu.bus.ram, cpu.bus.codeWords); }

const chk = (k1, nxt) => `if (cpu.jx !== 0 || (cpu.irqSrc >= 0 && (cr[0] & 1))) { cpu.jn = ${k1}; cpu.jx = 0; return ${U(nxt)}; }`;

function emit32(cpu, P, pc, k) {
  const nxt = (pc + 4) >>> 0, nxtR = nxt | 0, op = P >>> 25, rD = (P >>> 20) & 31, rA = (P >>> 15) & 31, rB = (P >>> 10) & 31, cu = P & 1;
  const generic = { code: `{ const p = cpu.exec32(${U(pc)}, ${P}, ${nxt}); if (p !== ${nxt}) { cpu.jn = ${k + 1}; return p; } ${chk(k + 1, nxt)} }`, term: false };
  const ok = (code) => ({ code, term: false }), st = (code) => ({ code: code + ' ' + chk(k + 1, nxt), term: false });
  const link = cu ? `r[3] = ${nxtR};` : '';
  switch (op) {
    case 1: case 5: {
      const f3 = (P >>> 17) & 7, imm = (P >>> 1) & 0xffff, s = op === 5 ? (imm << 16) : ((imm << 16) >> 16), u = op === 5 ? (imm << 16) : imm;
      switch (f3) {
        case 0: return ok(cu ? `r[${rD}] = cpu.add(r[${rD}], ${s}, 1);` : `r[${rD}] = (r[${rD}] + ${s}) | 0;`);
        case 2: return ok(`cpu.sub(r[${rD}], ${s}, 1);`);
        case 4: return ok(cu ? `r[${rD}] = cpu.logic(r[${rD}] & ${u}, 1);` : `r[${rD}] = r[${rD}] & ${u};`);
        case 5: return ok(cu ? `r[${rD}] = cpu.logic(r[${rD}] | ${u}, 1);` : `r[${rD}] = r[${rD}] | ${u};`);
        case 6: return ok(cu ? `r[${rD}] = cpu.logic(${s}, 1);` : `r[${rD}] = ${s};`);
        default: return generic;
      }
    }
    case 2: return { code: `{ ${link} return ${U(((pc & 0xfe000000) | (P & 0x01fffffe)) >>> 0)}; }`, term: true };
    case 4: {
      const cc = (P >>> 10) & 31, t = U(pc + sx((((P >>> 15) & 0x3ff) << 10) | (P & 0x3fe), 20));
      if (cc === 15) return { code: `{ ${link} return ${t}; }`, term: true };
      return { code: `if (${condExpr(cc)}) { ${link} return ${t}; } return ${nxt};`, term: true };
    }
    case 8: { const imm = sx((P >>> 1) & 0x3fff, 14); return ok(cu ? `r[${rD}] = cpu.add(r[${rA}], ${imm}, 1);` : `r[${rD}] = (r[${rA}] + ${imm}) | 0;`); }
    case 12: { const imm = (P >>> 1) & 0x3fff; return ok(cu ? `r[${rD}] = cpu.logic(r[${rA}] & ${imm}, 1);` : `r[${rD}] = r[${rA}] & ${imm};`); }
    case 13: { const imm = (P >>> 1) & 0x3fff; return ok(cu ? `r[${rD}] = cpu.logic(r[${rA}] | ${imm}, 1);` : `r[${rD}] = r[${rA}] | ${imm};`); }
    case 16: { const off = sx(P & 0x7fff, 15); return ok(L32(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 17: { const off = sx(P & 0x7fff, 15); return ok(L16S(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 18: { const off = sx(P & 0x7fff, 15); return ok(L16U(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 19: { const off = sx(P & 0x7fff, 15); return ok(L8S(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 20: { const off = sx(P & 0x7fff, 15); return st(S32(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 21: { const off = sx(P & 0x7fff, 15); return st(S16(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 22: { const off = sx(P & 0x7fff, 15); return ok(L8U(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 23: { const off = sx(P & 0x7fff, 15); return st(S8(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 3: case 7: {
      const imm = sx((P >>> 3) & 0xfff, 12), kk = P & 7;
      if (op === 3) {
        const pre = `{ const a = (r[${rA}] + ${imm}) | 0; r[${rA}] = a; `;
        if (kk === 4) return st(`${pre}${S32('a', `r[${rD}]`)} }`);
        if (kk === 0) return ok(`${pre}${L32('a', `r[${rD}]`)} }`);
        return kk >= 4 ? st(`${pre}cpu.mem(${kk}, ${rD}, a >>> 0); }`) : ok(`${pre}cpu.mem(${kk}, ${rD}, a >>> 0); }`);
      }
      const pre = `{ const a = r[${rA}] >>> 0; `;
      if (kk === 0) return ok(`${pre}${L32('a', `r[${rD}]`)} r[${rA}] = (a + ${imm}) | 0; }`);
      if (kk === 4) return st(`${pre}${S32('a', `r[${rD}]`)} r[${rA}] = (a + ${imm}) | 0; }`);
      return kk >= 4 ? st(`${pre}cpu.mem(${kk}, ${rD}, a); r[${rA}] = (a + ${imm}) | 0; }`) : ok(`${pre}cpu.mem(${kk}, ${rD}, a); r[${rA}] = (a + ${imm}) | 0; }`);
    }
    case 0: {
      const f = P & 0x3ff, cc = (P >>> 10) & 15;
      switch (f) {
        case 0x000: return ok('');
        case 0x008: case 0x009: if (cc === 15) return { code: `{ const a = r[${rA}]; ${(f & 1) ? `r[3] = ${nxtR};` : ''} return a >>> 0; }`, term: true }; return generic;
        case 0x010: return ok(`r[${rD}] = (r[${rA}] + r[${rB}]) | 0;`);
        case 0x011: return ok(`r[${rD}] = cpu.add(r[${rA}], r[${rB}], 1);`);
        case 0x014: return ok(`r[${rD}] = (r[${rA}] - r[${rB}]) | 0;`);
        case 0x015: return ok(`r[${rD}] = cpu.sub(r[${rA}], r[${rB}], 1);`);
        case 0x018: case 0x019: return ok(`{ const a = r[${rA}], b = r[${rB}]; cpu.sub(a, b, 1); ${(rD & 3) === 0 ? 'cpu.T = a === b ? 1 : 0;' : (rD & 3) === 1 ? 'cpu.T = cpu.N;' : ''} }`);
        case 0x020: return ok(`r[${rD}] = r[${rA}] & r[${rB}];`);
        case 0x021: return ok(`r[${rD}] = cpu.logic(r[${rA}] & r[${rB}], 1);`);
        case 0x022: return ok(`r[${rD}] = r[${rA}] | r[${rB}];`);
        case 0x023: return ok(`r[${rD}] = cpu.logic(r[${rA}] | r[${rB}], 1);`);
        case 0x026: return ok(`r[${rD}] = r[${rA}] ^ r[${rB}];`);
        case 0x056: return cc === 15 ? ok(`r[${rD}] = r[${rA}];`) : generic;
        case 0x058: return ok(`r[${rD}] = (r[${rA}] << 24) >> 24;`);
        case 0x05a: return ok(`r[${rD}] = (r[${rA}] << 16) >> 16;`);
        case 0x05c: return ok(`r[${rD}] = r[${rA}] & 0xff;`);
        case 0x05e: return ok(`r[${rD}] = r[${rA}] & 0xffff;`);
        case 0x070: return ok(`r[${rD}] = r[${rA}] << ${rB};`);
        case 0x071: return ok(`r[${rD}] = cpu.logic(r[${rA}] << ${rB}, 1);`);
        case 0x074: return ok(`r[${rD}] = r[${rA}] >>> ${rB};`);
        case 0x075: return ok(`r[${rD}] = cpu.logic(r[${rA}] >>> ${rB}, 1);`);
        case 0x076: return ok(`r[${rD}] = r[${rA}] >> ${rB};`);
        case 0x077: return ok(`r[${rD}] = cpu.logic(r[${rA}] >> ${rB}, 1);`);
        default: return generic;
      }
    }
    default: return generic;
  }
}

function emit16(cpu, h, pc, k) {
  const nxt = (pc + 2) >>> 0, nxtR = nxt | 0, op = (h >>> 12) & 7, rd = (h >>> 8) & 15, ra = (h >>> 4) & 15, fn = h & 15;
  const generic = { code: `{ const p = cpu.exec16(${U(pc)}, ${h}, ${nxt}); if (p !== ${nxt}) { cpu.jn = ${k + 1}; return p; } ${chk(k + 1, nxt)} }`, term: false };
  const ok = (code) => ({ code, term: false }), st = (code) => ({ code: code + ' ' + chk(k + 1, nxt), term: false });
  switch (op) {
    case 0:
      if (fn === 0) return ok('');
      if (fn === 3) return ok(`r[${rd}] = r[${ra}];`);
      if (fn === 4) return rd === 15 ? { code: `return r[${ra}] >>> 0;`, term: true } : generic;
      return generic;
    case 2:
      switch (fn) {
        case 8: return ok(L32(`r[${ra}]`, `r[${rd}]`));
        case 12: return st(S32(`r[${ra}]`, `r[${rd}]`));
        case 14: { const hi = (h & 0x80) !== 0, d = hi ? 16 + rd : rd, base = hi ? (ra & 7) : ra; return st(`r[${base}] = (r[${base}] - 4) | 0; ${S32(`r[${base}]`, `r[${d}]`)}`); }
        case 10: { const hi = (h & 0x80) !== 0, d = hi ? 16 + rd : rd, base = hi ? (ra & 7) : ra; return ok(`${L32(`r[${base}]`, `r[${d}]`)} r[${base}] = (r[${base}] + 4) | 0;`); }
        case 0: return ok(`r[${rd}] = cpu.add(r[${rd}], r[${ra}], 1);`);
        case 1: return ok(`r[${rd}] = cpu.sub(r[${rd}], r[${ra}], 1);`);
        case 3: return ok(`cpu.sub(r[${rd}], r[${ra}], 1);`);
        default: return generic;
      }
    case 3: { const t = U((pc & 0xfffff000) | (h & 0xffe)); return { code: `{ ${(h & 1) ? `r[3] = ${nxtR};` : ''} return ${t}; }`, term: true }; }
    case 4: {
      const t = U(pc + sx(h & 0xff, 8) * 2);
      if (rd === 15) return { code: `return ${t};`, term: true };
      return { code: `if (${condExpr(rd)}) return ${t}; return ${nxt};`, term: true };
    }
    case 5: return ok(`r[${rd}] = ${h & 0xff};`);
    case 7: {
      const i5 = (h >>> 3) & 31, kk = h & 7;
      if (kk === 0) return ok(L32(`(r[2] >>> 0) + ${i5 << 2}`, `r[${rd}]`));
      if (kk === 4) return st(S32(`(r[2] >>> 0) + ${i5 << 2}`, `r[${rd}]`));
      return generic;
    }
    default: return generic;
  }
}

// =============================================================================
// CPU (ex-cpu.js)
// =============================================================================
class UnknownOp extends Error {}

class SCore7 {
  constructor(bus) {
    this.bus = bus;
    this.r = new Int32Array(32);
    this.cr = new Uint32Array(32);
    this.sr = new Uint32Array(32);
    this.cel = 0; this.ceh = 0;
    this.N = this.Z = this.C = this.V = this.T = 0;
    this.pc = 0; this.cycles = 0; this.sleeping = false;
    this.useCache = true;
    this.c32W = new Uint32Array(0x140000); this.c32F = new Array(0x140000).fill(undefined);
    this.c16W = new Uint16Array(0x280000); this.c16F = new Array(0x280000).fill(undefined);
    this.useJit = true; this.jn = 0; this.jx = 0;
    this.bState = new Uint8Array(0x280000); this.bLen = new Uint8Array(0x280000); this.bF = new Array(0x280000).fill(undefined);
    this.pageBlocks = new Array(0x500).fill(null);
    this.codeWords = this.bus.codeWords; this.bus.onCodeWrite = (o) => this.onCodeWrite(o);
    this.cs = 0; this.irqSrc = -1;
  }
  reset(pc) { this.r.fill(0); this.cr.fill(0); this.cr[29] = 0x20000000; this.pc = pc >>> 0; this.cycles = 0; this.N = this.Z = this.C = this.V = this.T = 0; this.irqSrc = -1; }
  getCR(i) { return i === 1 ? ((this.V | this.C << 1 | this.Z << 2 | this.N << 3 | this.T << 4) | (this.cr[1] & 0x3e0)) >>> 0 : this.cr[i]; }
  setCR(i, v) { if (i === 1) { this.V = v & 1; this.C = (v >> 1) & 1; this.Z = (v >> 2) & 1; this.N = (v >> 3) & 1; this.T = (v >> 4) & 1; } this.cr[i] = v >>> 0; }
  setNZ(v) { this.N = v >>> 31; this.Z = v === 0 ? 1 : 0; }
  add(a, b, cu, cin = 0) {
    const full = (a >>> 0) + (b >>> 0) + cin, res = full | 0;
    if (cu) { this.setNZ(res); this.C = full > 0xffffffff ? 1 : 0; this.V = (~(a ^ b) & (a ^ res)) >>> 31; }
    return res;
  }
  sub(a, b, cu, cin = 1) {
    const bw = 1 - cin, res = (a - b - bw) | 0;
    if (cu) { this.setNZ(res); this.C = (a >>> 0) >= (b >>> 0) + bw ? 1 : 0; this.V = ((a ^ b) & (a ^ res)) >>> 31; }
    return res;
  }
  logic(v, cu) { if (cu) this.setNZ(v); return v; }
  cond(c, cnt = false) {
    switch (c) {
      case 0: return this.C === 1; case 1: return this.C === 0;
      case 2: return this.C === 1 && this.Z === 0; case 3: return this.C === 0 || this.Z === 1;
      case 4: return this.Z === 1; case 5: return this.Z === 0;
      case 6: return this.Z === 0 && this.N === this.V; case 7: return this.Z === 1 || this.N !== this.V;
      case 8: return this.N === this.V; case 9: return this.N !== this.V;
      case 10: return this.N === 1; case 11: return this.N === 0;
      case 12: return this.V === 1; case 13: return this.V === 0;
      case 14: { const n = this.sr[0]; if (cnt && n) this.sr[0] = n - 1; return n !== 0; }
      case 15: return true;
      default: return false;
    }
  }
  addHook(addr, fn) { this.jitFlush(); if (!this.hooks) { this.hooks = new Map(); this.hookMask = new Uint8Array(1 << 23); } this.hooks.set(addr >>> 0, fn); this.hookMask[(addr & 0xffffff) >>> 1] = 1; }
  step() {
    if (this.irqSrc >= 0 && (this.cr[0] & 1)) { this.interrupt(this.irqSrc); }
    const pc = this.pc;
    if (this.hookMask !== undefined && this.hookMask[(pc & 0xffffff) >>> 1] && (pc >>> 24) === 0xa0) { const h = this.hooks.get(pc); if (h && h(this)) { this.cycles++; return; } }
    const seg = pc >>> 24; let k32 = -1;
    if (this.useCache) {
      if (seg === 0xa0 || seg === 0x80) { const o = pc & 0xffffff; if (o < 0x400000) k32 = o; }
      else if (seg === 0x9f || seg === 0x9e) k32 = 0x400000 + (pc & 0xfffff);
    }
    if (k32 >= 0) {
      const b = this.bus;
      if (pc & 2) {
        const h = b.r16(pc) & 0x7fff, k = k32 >>> 1; let f;
        if (this.c16W[k] === h && (f = this.c16F[k]) !== undefined) { this.pc = f(); this.cycles++; return; }
        f = this.decode16(h, pc, (pc + 2) >>> 0); this.c16W[k] = h; this.c16F[k] = f; this.pc = f(); this.cycles++; return;
      }
      const w = b.r32(pc);
      if ((w >>> 15) & 1) {
        const k = k32 >>> 2; let f;
        if (this.c32W[k] === w && (f = this.c32F[k]) !== undefined) { this.pc = f(); this.cycles++; return; }
        const P = ((((w >>> 16) & 0x7fff) << 15) | (w & 0x7fff)) >>> 0;
        f = this.decode32(P, pc, (pc + 4) >>> 0); this.c32W[k] = w; this.c32F[k] = f; this.pc = f(); this.cycles++; return;
      }
      if (!(w >>> 31)) {
        const h = w & 0x7fff, k = k32 >>> 1; let f;
        if (this.c16W[k] === h && (f = this.c16F[k]) !== undefined) { this.pc = f(); this.cycles++; return; }
        f = this.decode16(h, pc, (pc + 2) >>> 0); this.c16W[k] = h; this.c16F[k] = f; this.pc = f(); this.cycles++; return;
      }
    }
    this.stepSlow(pc);
  }
  jitFlush() { if (this.bState === undefined) return; this.bState.fill(0); this.bF.fill(undefined); this.pageBlocks.fill(null); this.codeWords.fill(0); this.jx = 0; }
  onCodeWrite(o) {
    const page = o >>> 12, list = this.pageBlocks[page];
    if (list !== null) { for (const kk of list) { this.bState[kk] = 0; this.bF[kk] = undefined; } this.pageBlocks[page] = null; }
    this.codeWords.fill(0, page * 1024, page * 1024 + 1024); this.jx = 1;
  }
  jitTranslate(pc, off, kk) {
    const b = buildBlock(this, pc);
    if (b === null || b.len < 2) { this.bState[kk] = 2; return 2; }
    let f; try { f = compileBlock(this, b.src); } catch (e) { this.bState[kk] = 2; return 2; }
    this.bF[kk] = f; this.bLen[kk] = b.len; this.bState[kk] = 1;
    const page = kk >>> 11; (this.pageBlocks[page] || (this.pageBlocks[page] = [])).push(kk);
    if (off < 0x400000) { const a = (pc & 0xffffff) >>> 2, z = ((b.endPc - 1) & 0xffffff) >>> 2; for (let w = a; w <= z; w++) this.codeWords[w] = 1; }
    return 1;
  }
  runN(n) {
    if (!this.useCache) { for (let i = 0; i < n; i++) this.step(); return; }
    const bus = this.bus, ramDv = bus.dv, cr = this.cr, c32W = this.c32W, c32F = this.c32F, c16W = this.c16W, c16F = this.c16F, hm = this.hookMask, jit = this.useJit, bState = this.bState, bLen = this.bLen, bF = this.bF;
    let pc = this.pc, done = 0, synced = 0;
    try {
      while (done < n) {
        if (this.irqSrc >= 0 && (cr[0] & 1)) { this.pc = pc; this.cycles += done - synced; synced = done; this.interrupt(this.irqSrc); pc = this.pc; }
        if (hm !== undefined && hm[(pc & 0xffffff) >>> 1] && (pc >>> 24) === 0xa0) {
          const h = this.hooks.get(pc);
          if (h) { this.pc = pc; this.cycles += done - synced; synced = done; const handled = h(this); pc = this.pc; if (handled) { done++; this.cycles++; synced++; continue; } }
        }
        const seg = pc >>> 24; let off = -1;
        if (seg === 0xa0 || seg === 0x80) { const o = pc & 0xffffff; if (o < 0x400000) off = o; }
        else if (seg === 0x9f || seg === 0x9e) off = 0x400000 + (pc & 0xfffff);
        if (off < 0) {
          this.pc = pc; this.cycles += done - synced; synced = done; this.stepSlow(pc); pc = this.pc; done++; synced++; continue;
        }
        if (jit && n - done >= 8) {
          const kk = off >>> 1; let stt = bState[kk];
          if (stt === 0) stt = this.jitTranslate(pc, off, kk);
          if (stt === 1) { const bl = bLen[kk]; if (done + bl <= n) { pc = bF[kk](); const j = this.jn; if (j !== 0) { done += j; this.jn = 0; } else done += bl; continue; } }
        }
        let f;
        if (pc & 2) {
          const hw = bus.r16(pc) & 0x7fff, k = off >>> 1;
          if (c16W[k] === hw && (f = c16F[k]) !== undefined) { pc = f(); done++; continue; }
          f = this.decode16(hw, pc, (pc + 2) >>> 0); c16W[k] = hw; c16F[k] = f; pc = f(); done++; continue;
        }
        const w = (seg === 0xa0 || seg === 0x80) ? ramDv.getUint32(pc & 0xffffff, true) : bus.r32(pc);
        if ((w >>> 15) & 1) {
          const k = off >>> 2;
          if (c32W[k] === w && (f = c32F[k]) !== undefined) { pc = f(); done++; continue; }
          const P = ((((w >>> 16) & 0x7fff) << 15) | (w & 0x7fff)) >>> 0;
          f = this.decode32(P, pc, (pc + 4) >>> 0); c32W[k] = w; c32F[k] = f; pc = f(); done++; continue;
        }
        if (!(w >>> 31)) {
          const hw = w & 0x7fff, k = off >>> 1;
          if (c16W[k] === hw && (f = c16F[k]) !== undefined) { pc = f(); done++; continue; }
          f = this.decode16(hw, pc, (pc + 2) >>> 0); c16W[k] = hw; c16F[k] = f; pc = f(); done++; continue;
        }
        this.pc = pc; this.cycles += done - synced; synced = done; this.stepSlow(pc); pc = this.pc; done++; synced++;
      }
    } catch (e) { this.pc = pc; this.cycles += done - synced; this.jn = 0; this.jx = 0; throw e; }
    this.pc = pc; this.cycles += done - synced;
  }
  stepSlow(pc) {
    const b = this.bus;
    let next;
    if (pc & 2) { next = this.exec16(pc, b.r16(pc) & 0x7fff, (pc + 2) >>> 0); }
    else {
      const w = b.r32(pc), lo = w & 0x7fff, p0 = (w >>> 15) & 1, hi = (w >>> 16) & 0x7fff, p1 = w >>> 31;
      if (p0) next = this.exec32(pc, ((hi << 15) | lo) >>> 0, (pc + 4) >>> 0);
      else if (p1) next = this.exec16(pc, this.T ? lo : hi, (pc + 4) >>> 0);
      else next = this.exec16(pc, lo, (pc + 2) >>> 0);
    }
    this.pc = next >>> 0; this.cycles++;
  }
  decode32(P, pc, nxt) {
    const cpu = this, r = this.r, bus = this.bus, op = P >>> 25, rD = (P >>> 20) & 31, rA = (P >>> 15) & 31, rB = (P >>> 10) & 31, cu = P & 1;
    const generic = () => cpu.exec32(pc, P, nxt);
    switch (op) {
      case 1: case 5: {
        const f3 = (P >>> 17) & 7, imm = (P >>> 1) & 0xffff, s = op === 5 ? (imm << 16) : ((imm << 16) >> 16), u = op === 5 ? (imm << 16) : imm;
        switch (f3) {
          case 0: return cu ? () => { r[rD] = cpu.add(r[rD], s, 1); return nxt; } : () => { r[rD] = (r[rD] + s) | 0; return nxt; };
          case 2: return () => { cpu.sub(r[rD], s, 1); return nxt; };
          case 4: return cu ? () => { r[rD] = cpu.logic(r[rD] & u, 1); return nxt; } : () => { r[rD] = r[rD] & u; return nxt; };
          case 5: return cu ? () => { r[rD] = cpu.logic(r[rD] | u, 1); return nxt; } : () => { r[rD] = r[rD] | u; return nxt; };
          case 6: return cu ? () => { r[rD] = cpu.logic(s, 1); return nxt; } : () => { r[rD] = s; return nxt; };
          default: return generic;
        }
      }
      case 2: { const t = ((pc & 0xfe000000) | (P & 0x01fffffe)) >>> 0; return cu ? () => { r[3] = nxt; return t; } : () => t; }
      case 4: {
        const cc = (P >>> 10) & 31, t = (pc + sx((((P >>> 15) & 0x3ff) << 10) | (P & 0x3fe), 20)) >>> 0;
        if (cc === 15) return cu ? () => { r[3] = nxt; return t; } : () => t;
        if (cc === 4) return cu ? () => { if (cpu.Z === 1) { r[3] = nxt; return t; } return nxt; } : () => (cpu.Z === 1 ? t : nxt);
        if (cc === 5) return cu ? () => { if (cpu.Z === 0) { r[3] = nxt; return t; } return nxt; } : () => (cpu.Z === 0 ? t : nxt);
        return () => { if (cpu.cond(cc, true)) { if (cu) r[3] = nxt; return t; } return nxt; };
      }
      case 8: { const imm = sx((P >>> 1) & 0x3fff, 14); return cu ? () => { r[rD] = cpu.add(r[rA], imm, 1); return nxt; } : () => { r[rD] = (r[rA] + imm) | 0; return nxt; }; }
      case 12: { const imm = (P >>> 1) & 0x3fff; return cu ? () => { r[rD] = cpu.logic(r[rA] & imm, 1); return nxt; } : () => { r[rD] = r[rA] & imm; return nxt; }; }
      case 13: { const imm = (P >>> 1) & 0x3fff; return cu ? () => { r[rD] = cpu.logic(r[rA] | imm, 1); return nxt; } : () => { r[rD] = r[rA] | imm; return nxt; }; }
      case 16: { const off = sx(P & 0x7fff, 15); return () => { r[rD] = bus.r32(r[rA] + off); return nxt; }; }
      case 17: { const off = sx(P & 0x7fff, 15); return () => { r[rD] = (bus.r16(r[rA] + off) << 16) >> 16; return nxt; }; }
      case 18: { const off = sx(P & 0x7fff, 15); return () => { r[rD] = bus.r16(r[rA] + off); return nxt; }; }
      case 19: { const off = sx(P & 0x7fff, 15); return () => { r[rD] = (bus.r8(r[rA] + off) << 24) >> 24; return nxt; }; }
      case 20: { const off = sx(P & 0x7fff, 15); return () => { bus.w32(r[rA] + off, r[rD]); return nxt; }; }
      case 21: { const off = sx(P & 0x7fff, 15); return () => { bus.w16(r[rA] + off, r[rD]); return nxt; }; }
      case 22: { const off = sx(P & 0x7fff, 15); return () => { r[rD] = bus.r8(r[rA] + off); return nxt; }; }
      case 23: { const off = sx(P & 0x7fff, 15); return () => { bus.w8(r[rA] + off, r[rD]); return nxt; }; }
      case 3: case 7: {
        const imm = sx((P >>> 3) & 0xfff, 12), k = P & 7;
        if (op === 3) {
          if (k === 4) return () => { const a = (r[rA] + imm) | 0; r[rA] = a; bus.w32(a >>> 0, r[rD]); return nxt; };
          if (k === 0) return () => { const a = (r[rA] + imm) | 0; r[rA] = a; r[rD] = bus.r32(a >>> 0); return nxt; };
          return () => { const a = (r[rA] + imm) | 0; r[rA] = a; cpu.mem(k, rD, a >>> 0); return nxt; };
        }
        if (k === 0) return () => { const a = r[rA] >>> 0; r[rD] = bus.r32(a); r[rA] = (a + imm) | 0; return nxt; };
        if (k === 4) return () => { const a = r[rA] >>> 0; bus.w32(a, r[rD]); r[rA] = (a + imm) | 0; return nxt; };
        return () => { const a = r[rA] >>> 0; cpu.mem(k, rD, a); r[rA] = (a + imm) | 0; return nxt; };
      }
      case 0: {
        const f = P & 0x3ff, cc = (P >>> 10) & 15;
        switch (f) {
          case 0x000: return () => nxt;
          case 0x008: case 0x009: if (cc === 15) return (f & 1) ? () => { const a = r[rA]; r[3] = nxt; return a >>> 0; } : () => r[rA] >>> 0; return generic;
          case 0x010: return () => { r[rD] = (r[rA] + r[rB]) | 0; return nxt; };
          case 0x011: return () => { r[rD] = cpu.add(r[rA], r[rB], 1); return nxt; };
          case 0x014: return () => { r[rD] = (r[rA] - r[rB]) | 0; return nxt; };
          case 0x015: return () => { r[rD] = cpu.sub(r[rA], r[rB], 1); return nxt; };
          case 0x018: case 0x019: return () => { const a = r[rA], bb = r[rB]; cpu.sub(a, bb, 1); const t = rD & 3; if (t === 0) cpu.T = a === bb ? 1 : 0; else if (t === 1) cpu.T = cpu.N; return nxt; };
          case 0x020: return () => { r[rD] = r[rA] & r[rB]; return nxt; };
          case 0x021: return () => { r[rD] = cpu.logic(r[rA] & r[rB], 1); return nxt; };
          case 0x022: return () => { r[rD] = r[rA] | r[rB]; return nxt; };
          case 0x023: return () => { r[rD] = cpu.logic(r[rA] | r[rB], 1); return nxt; };
          case 0x026: return () => { r[rD] = r[rA] ^ r[rB]; return nxt; };
          case 0x056: return cc === 15 ? () => { r[rD] = r[rA]; return nxt; } : generic;
          case 0x058: return () => { r[rD] = (r[rA] << 24) >> 24; return nxt; };
          case 0x05a: return () => { r[rD] = (r[rA] << 16) >> 16; return nxt; };
          case 0x05c: return () => { r[rD] = r[rA] & 0xff; return nxt; };
          case 0x05e: return () => { r[rD] = r[rA] & 0xffff; return nxt; };
          case 0x070: return () => { r[rD] = r[rA] << rB; return nxt; };
          case 0x071: return () => { r[rD] = cpu.logic(r[rA] << rB, 1); return nxt; };
          case 0x074: return () => { r[rD] = r[rA] >>> rB; return nxt; };
          case 0x075: return () => { r[rD] = cpu.logic(r[rA] >>> rB, 1); return nxt; };
          case 0x076: return () => { r[rD] = r[rA] >> rB; return nxt; };
          case 0x077: return () => { r[rD] = cpu.logic(r[rA] >> rB, 1); return nxt; };
          default: return generic;
        }
      }
      default: return generic;
    }
  }
  decode16(h, pc, nxt) {
    const cpu = this, r = this.r, bus = this.bus, op = (h >>> 12) & 7, rd = (h >>> 8) & 15, ra = (h >>> 4) & 15, fn = h & 15;
    const generic = () => cpu.exec16(pc, h, nxt);
    switch (op) {
      case 0:
        if (fn === 0) return () => nxt;
        if (fn === 3) return () => { r[rd] = r[ra]; return nxt; };
        if (fn === 4) return rd === 15 ? () => r[ra] >>> 0 : generic;
        return generic;
      case 2: {
        switch (fn) {
          case 8: return () => { r[rd] = bus.r32(r[ra] >>> 0); return nxt; };
          case 12: return () => { bus.w32(r[ra] >>> 0, r[rd]); return nxt; };
          case 14: { const hi = (h & 0x80) !== 0, d = hi ? 16 + rd : rd, base = hi ? (ra & 7) : ra; return () => { r[base] = (r[base] - 4) | 0; bus.w32(r[base] >>> 0, r[d]); return nxt; }; }
          case 10: { const hi = (h & 0x80) !== 0, d = hi ? 16 + rd : rd, base = hi ? (ra & 7) : ra; return () => { r[d] = bus.r32(r[base] >>> 0); r[base] = (r[base] + 4) | 0; return nxt; }; }
          case 0: return () => { r[rd] = cpu.add(r[rd], r[ra], 1); return nxt; };
          case 1: return () => { r[rd] = cpu.sub(r[rd], r[ra], 1); return nxt; };
          case 3: return () => { cpu.sub(r[rd], r[ra], 1); return nxt; };
          default: return generic;
        }
      }
      case 3: { const t = ((pc & 0xfffff000) | (h & 0xffe)) >>> 0; return (h & 1) ? () => { r[3] = nxt; return t; } : () => t; }
      case 4: {
        const t = (pc + sx(h & 0xff, 8) * 2) >>> 0;
        if (rd === 15) return () => t;
        if (rd === 4) return () => (cpu.Z === 1 ? t : nxt);
        if (rd === 5) return () => (cpu.Z === 0 ? t : nxt);
        return () => (cpu.cond(rd, true) ? t : nxt);
      }
      case 5: { const v = h & 0xff; return () => { r[rd] = v; return nxt; }; }
      case 7: {
        const i5 = (h >>> 3) & 31, k = h & 7;
        if (k === 0) { const o = i5 << 2; return () => { r[rd] = bus.r32((r[2] >>> 0) + o); return nxt; }; }
        if (k === 4) { const o = i5 << 2; return () => { bus.w32((r[2] >>> 0) + o, r[rd]); return nxt; }; }
        return generic;
      }
      default: return generic;
    }
  }
  mem(kind, rD, addr) {
    const r = this.r, b = this.bus;
    switch (kind) {
      case 0: r[rD] = b.r32(addr); break;
      case 1: r[rD] = (b.r16(addr) << 16) >> 16; break;
      case 2: r[rD] = b.r16(addr); break;
      case 3: r[rD] = (b.r8(addr) << 24) >> 24; break;
      case 4: b.w32(addr, r[rD]); break;
      case 5: b.w16(addr, r[rD]); break;
      case 6: r[rD] = b.r8(addr); break;
      case 7: b.w8(addr, r[rD]); break;
    }
  }
  exec32(pc, P, next) {
    const r = this.r, op = P >>> 25, rD = (P >>> 20) & 31, rA = (P >>> 15) & 31, rB = (P >>> 10) & 31, cu = P & 1;
    switch (op) {
      case 0: {
        const f = P & 0x3ff, a = r[rA], bb = r[rB], cc = (P >>> 10) & 15;
        switch (f) {
          case 0x000: break;
          case 0x002: case 0x006: break;
          case 0x004: break;
          case 0x008: case 0x009: if (this.cond(cc, true)) { if (f & 1) r[3] = next; next = a >>> 0; } break;
          case 0x00a: break;
          case 0x00c: r[rD] = this.bus.r32(a >>> 0); break;
          case 0x00e: this.bus.w32(a >>> 0, r[rD]); break;
          case 0x010: case 0x011: r[rD] = this.add(a, bb, f & 1); break;
          case 0x012: case 0x013: r[rD] = this.add(a, bb, f & 1, this.C); break;
          case 0x014: case 0x015: r[rD] = this.sub(a, bb, f & 1); break;
          case 0x016: case 0x017: r[rD] = this.sub(a, bb, f & 1, this.C); break;
          case 0x018: case 0x019: { this.sub(a, bb, 1); const t = rD & 3; if (t === 0) this.T = a === bb ? 1 : 0; else if (t === 1) this.T = this.N; break; }
          case 0x01a: case 0x01b: { this.sub(a, 0, 1); const t = rD & 3; if (t === 0) this.T = a === 0 ? 1 : 0; else if (t === 1) this.T = this.N; break; }
          case 0x01e: case 0x01f: r[rD] = this.sub(0, bb, f & 1); break;
          case 0x020: case 0x021: r[rD] = this.logic(a & bb, f & 1); break;
          case 0x022: case 0x023: r[rD] = this.logic(a | bb, f & 1); break;
          case 0x024: case 0x025: r[rD] = this.logic(~a, f & 1); break;
          case 0x026: case 0x027: r[rD] = this.logic(a ^ bb, f & 1); break;
          case 0x029: r[rD] = this.logic(a & ~(1 << rB), 1); break;
          case 0x02b: r[rD] = this.logic(a | (1 << rB), 1); break;
          case 0x02d: { const t = a & (1 << rB); this.Z = t ? 0 : 1; this.N = t >>> 31; break; }
          case 0x02f: r[rD] = this.logic(a ^ (1 << rB), 1); break;
          case 0x030: case 0x031: r[rD] = this.logic(a << (bb & 31), f & 1); break;
          case 0x034: case 0x035: r[rD] = this.logic(a >>> (bb & 31), f & 1); break;
          case 0x036: case 0x037: r[rD] = this.logic(a >> (bb & 31), f & 1); break;
          case 0x038: case 0x039: { const s = bb & 31; r[rD] = this.logic((a >>> s) | (a << (32 - s)), f & 1); break; }
          case 0x03c: case 0x03d: { const s = bb & 31; r[rD] = this.logic((a << s) | (a >>> (32 - s)), f & 1); break; }
          case 0x040: case 0x041: { const t = BigInt(a) * BigInt(bb); this.cel = Number(BigInt.asUintN(32, t)) | 0; this.ceh = Number(BigInt.asIntN(32, t >> 32n)); break; }
          case 0x042: { const t = BigInt(a >>> 0) * BigInt(bb >>> 0); this.cel = Number(BigInt.asUintN(32, t)) | 0; this.ceh = Number(BigInt.asUintN(32, t >> 32n)) | 0; break; }
          case 0x044: if (bb) { this.cel = (a / bb) | 0; this.ceh = (a % bb) | 0; } break;
          case 0x046: if (bb) { this.cel = ((a >>> 0) / (bb >>> 0)) | 0; this.ceh = ((a >>> 0) % (bb >>> 0)) | 0; } break;
          case 0x048: { const s = P & 0x7c00; if (s === 0x400) r[rD] = this.cel; else if (s === 0x800) r[rD] = this.ceh; else if (s === 0xc00) { r[rD] = this.cel; r[rA] = this.ceh; } else throw new UnknownOp(`mfce er${rB} @${pc.toString(16)}`); break; }
          case 0x04a: { const s = P & 0x7c00; if (s === 0x400) this.cel = r[rD]; else if (s === 0x800) this.ceh = r[rD]; else if (s === 0xc00) { this.cel = r[rD]; this.ceh = r[rA]; } else throw new UnknownOp(`mtce er${rB} @${pc.toString(16)}`); break; }
          case 0x050: r[rD] = this.sr[rB]; break;
          case 0x052: this.sr[rB] = a; break;
          case 0x054: this.T = this.cond(cc) ? 1 : 0; break;
          case 0x056: if (this.cond(cc)) r[rD] = a; break;
          case 0x058: case 0x059: r[rD] = this.logic((a << 24) >> 24, f & 1); break;
          case 0x05a: case 0x05b: r[rD] = this.logic((a << 16) >> 16, f & 1); break;
          case 0x05c: case 0x05d: r[rD] = this.logic(a & 0xff, f & 1); break;
          case 0x05e: case 0x05f: r[rD] = this.logic(a & 0xffff, f & 1); break;
          case 0x070: case 0x071: r[rD] = this.logic(a << rB, f & 1); break;
          case 0x074: case 0x075: r[rD] = this.logic(a >>> rB, f & 1); break;
          case 0x076: case 0x077: r[rD] = this.logic(a >> rB, f & 1); break;
          case 0x078: case 0x079: r[rD] = this.logic((a >>> rB) | (a << (32 - rB)), f & 1); break;
          case 0x07c: case 0x07d: r[rD] = this.logic((a << rB) | (a >>> (32 - rB)), f & 1); break;
          default: throw new UnknownOp(`op0 func=0x${f.toString(16)} @${pc.toString(16)} P=${P.toString(16)}`);
        }
        break;
      }
      case 1: case 5: {
        const f3 = (P >>> 17) & 7, imm = (P >>> 1) & 0xffff, s = op === 5 ? (imm << 16) : ((imm << 16) >> 16), u = op === 5 ? (imm << 16) : imm;
        switch (f3) {
          case 0: r[rD] = this.add(r[rD], s, cu); break;
          case 2: this.sub(r[rD], s, 1); break;
          case 4: r[rD] = this.logic(r[rD] & u, cu); break;
          case 5: r[rD] = this.logic(r[rD] | u, cu); break;
          case 6: r[rD] = this.logic(s, cu); break;
          default: throw new UnknownOp(`op${op} f3=${f3} @${pc.toString(16)} P=${P.toString(16)}`);
        }
        break;
      }
      case 2: if (cu) r[3] = next; next = ((pc & 0xfe000000) | (P & 0x01fffffe)) >>> 0; break;
      case 4: if (this.cond(cc4(P), true)) { if (cu) r[3] = next; next = (pc + sx((((P >>> 15) & 0x3ff) << 10) | (P & 0x3fe), 20)) >>> 0; } break;
      case 8: r[rD] = this.add(r[rA], sx((P >>> 1) & 0x3fff, 14), cu); break;
      case 12: r[rD] = this.logic(r[rA] & ((P >>> 1) & 0x3fff), cu); break;
      case 13: r[rD] = this.logic(r[rA] | ((P >>> 1) & 0x3fff), cu); break;
      case 16: case 17: case 18: case 19: case 20: case 21: case 22: case 23:
        this.mem(op & 7, rD, (r[rA] + sx(P & 0x7fff, 15)) >>> 0); break;
      case 3: case 7: {
        const imm = sx((P >>> 3) & 0xfff, 12), k = P & 7;
        if (op === 3) { const a = (r[rA] + imm) | 0; r[rA] = a; this.mem(k, rD, a >>> 0); }
        else { const a = r[rA] >>> 0; this.mem(k, rD, a); r[rA] = (a + imm) | 0; }
        break;
      }
      case 6: {
        const f5 = P & 0x1f;
        if (f5 === 0) this.setCR(rA, r[rD]); else if (f5 === 1) r[rD] = this.getCR(rA) | 0;
        else if ((P & 0x3ff) === 0x0c4) { /* sleep */ }
        else if ((P & 0x3ff) === 0x084 || (P & 0x3ff) === 0x0a4) next = this.rte() >>> 0;
        else throw new UnknownOp(`op6 P=${P.toString(16)} @${pc.toString(16)}`);
        break;
      }
      case 24: break;
      default: throw new UnknownOp(`op32=${op} @${pc.toString(16)} P=${P.toString(16)}`);
    }
    return next;
  }
  exception(code) {
    const f = this.getCR(1);
    this.cr[1] = (f & 0x1f) << 5;
    const psr = this.cr[0];
    this.cr[0] = (psr & ~0xf) | ((psr & 1) << 2) | ((psr & 2) << 2);
    this.cr[2] = ((this.cr[2] & ~0x00fc0000) | ((code & 0x3f) << 18)) >>> 0;
    this.cr[5] = this.pc;
    this.pc = (this.cr[3] + code * 4) >>> 0;
    this.sleeping = false;
  }
  interrupt(src) {
    if (!(this.cr[0] & 1)) return false;
    this.exception((63 - src) + 128);
    return true;
  }
  rte() {
    const psr = this.cr[0];
    this.cr[0] = (psr & ~0x3) | ((psr >> 2) & 1) | (((psr >> 3) & 1) << 1);
    const f = this.cr[1];
    const c = (f >> 5) & 0x1f;
    this.V = c & 1; this.C = (c >> 1) & 1; this.Z = (c >> 2) & 1; this.N = (c >> 3) & 1; this.T = (c >> 4) & 1;
    return this.cr[5];
  }
  exec16(pc, h, next) {
    const r = this.r, b = this.bus, op = (h >>> 12) & 7, rd = (h >>> 8) & 15, ra = (h >>> 4) & 15, fn = h & 15;
    switch (op) {
      case 0: switch (fn) {
        case 0: break;
        case 1: r[rd] = r[16 + (ra & 15)]; break;
        case 2: r[16 + rd] = r[ra]; break;
        case 3: r[rd] = r[ra]; break;
        case 4: if (this.cond(rd, true)) next = r[ra] >>> 0; break;
        case 5: this.T = this.cond(rd) ? 1 : 0; break;
        case 8: r[rd] = this.logic(r[rd] << (r[ra] & 31), 1); break;
        case 9: r[rd] = this.add(r[rd], r[ra], 1, this.C); break;
        case 10: r[rd] = this.logic(r[rd] >>> (r[ra] & 31), 1); break;
        case 11: r[rd] = this.logic(r[rd] >> (r[ra] & 31), 1); break;
        case 12: if (this.cond(rd, true)) { r[3] = next; next = r[ra] >>> 0; } break;
        default: throw new UnknownOp(`op16/0 fn=${fn} h=${h.toString(16)} @${pc.toString(16)}`);
      } break;
      case 1: switch (h & 0xf0f) {
        case 0x000: this.cel = r[ra]; break;  case 0x001: r[ra] = this.cel; break;
        case 0x100: this.ceh = r[ra]; break;  case 0x101: r[ra] = this.ceh; break;
        case 0x002: case 0x003: { const u = fn === 3; const t = u ? BigInt(r[rd] >>> 0) * BigInt(r[ra] >>> 0) : BigInt(r[rd]) * BigInt(r[ra]);
          this.cel = Number(BigInt.asUintN(32, t)) | 0; this.ceh = Number(BigInt.asUintN(32, t >> 32n)) | 0; break; }
        default: throw new UnknownOp(`op16/1 h=${h.toString(16)} @${pc.toString(16)}`);
      } break;
      case 2: {
        const a = r[ra] >>> 0;
        switch (fn) {
          case 0: r[rd] = this.add(r[rd], r[ra], 1); break;
          case 1: r[rd] = this.sub(r[rd], r[ra], 1); break;
          case 2: r[rd] = this.sub(0, r[ra], 1); break;
          case 3: this.sub(r[rd], r[ra], 1); break;
          case 4: r[rd] = this.logic(r[rd] & r[ra], 1); break;
          case 5: r[rd] = this.logic(r[rd] | r[ra], 1); break;
          case 6: r[rd] = this.logic(~r[ra], 1); break;
          case 7: r[rd] = this.logic(r[rd] ^ r[ra], 1); break;
          case 8: r[rd] = b.r32(a); break;
          case 9: r[rd] = (b.r16(a) << 16) >> 16; break;
          case 11: r[rd] = b.r8(a); break;
          case 12: b.w32(a, r[rd]); break;
          case 13: b.w16(a, r[rd]); break;
          case 15: b.w8(a, r[rd]); break;
          case 10: case 14: {
            const hi = (h & 0x80) !== 0, d = hi ? 16 + rd : rd, base = hi ? (ra & 7) : ra;
            if (fn === 14) { r[base] = (r[base] - 4) | 0; b.w32(r[base] >>> 0, r[d]); }
            else { r[d] = b.r32(r[base] >>> 0); r[base] = (r[base] + 4) | 0; }
            break;
          }
        }
        break;
      }
      case 3: if (h & 1) r[3] = next; next = ((pc & 0xfffff000) | (h & 0xffe)) >>> 0; break;
      case 4: if (this.cond(rd, true)) next = (pc + sx(h & 0xff, 8) * 2) >>> 0; break;
      case 5: r[rd] = h & 0xff; break;
      case 6: {
        const f3 = h & 7, i5 = (h >>> 3) & 31;
        if ((h & 0x7) === 0) { const i4 = (h >>> 3) & 15; r[rd] = (h & 0x80) ? this.sub(r[rd], i4, 1) : this.add(r[rd], i4, 1); }
        else if (f3 === 1) r[rd] = this.logic(r[rd] << i5, 1);
        else if (f3 === 3) r[rd] = this.logic(r[rd] >>> i5, 1);
        else if (f3 === 4) r[rd] = this.logic(r[rd] & ~(1 << i5), 1);
        else if (f3 === 5) r[rd] = this.logic(r[rd] | (1 << i5), 1);
        else if (f3 === 6) { const t = r[rd] & (1 << i5); this.Z = t ? 0 : 1; this.N = t >>> 31; }
        else if (f3 === 7) r[rd] = this.logic(r[rd] ^ (1 << i5), 1);
        else throw new UnknownOp(`op16/6 h=${h.toString(16)} @${pc.toString(16)}`);
        break;
      }
      case 7: {
        const i5 = (h >>> 3) & 31, k = h & 7, base = r[2] >>> 0;
        switch (k) {
          case 0: r[rd] = b.r32(base + (i5 << 2)); break;  case 4: b.w32(base + (i5 << 2), r[rd]); break;
          case 1: r[rd] = (b.r16(base + (i5 << 1)) << 16) >> 16; break;  case 5: b.w16(base + (i5 << 1), r[rd]); break;
          case 3: r[rd] = b.r8(base + i5); break;  case 7: b.w8(base + i5, r[rd]); break;
          default: throw new UnknownOp(`op16/7 h=${h.toString(16)} @${pc.toString(16)}`);
        }
        break;
      }
    }
    return next;
  }
}
function cc4(P) { return (P >>> 10) & 31; }

// =============================================================================
// CD HLE (ex-cdhle.js)
// =============================================================================
const SIG = 0x230e;
const NOLOG = () => {};
function copyToBus(bus, dest, src, off, n) {
  const seg = (dest >>> 24), o0 = dest & 0xffffff;
  if (!globalThis.__forceSlowCopy && (seg === 0xa0 || seg === 0x80) && o0 + n <= 0x1000000) {
    const ram = bus.ram, cw = bus.codeWords;
    ram.set(src.subarray(off, off + n), o0);
    if (o0 < 0x400000) { const hi = Math.min(o0 + n, 0x400000) - 1; for (let w = o0 >>> 12, e = hi >>> 12; w <= e; w++) if (cw[w << 10] !== undefined) bus.onCodeWrite(w << 12); }
    return;
  }
  for (let i = 0; i < n; i++) bus.w8(dest + i, src[off + i]);
}
function msfToLba(pos) { const m = (pos >>> 16) & 0xff, s = (pos >>> 8) & 0xff, f = pos & 0xff; return (m * 60 + s) * 75 + f - 150; }

function installCdHle(machine, opts = {}) {
  const cpu = machine.cpu, bus = machine.bus, log = opts.log || NOLOG, verbose = !!opts.log;
  const stats = { reads: 0, bytes: 0, toc: 0, miss: 0 };
  const ret = (c, v) => { if (v !== undefined) c.r[4] = v | 0; c.pc = c.r[3] >>> 0; return true; };
  const guard = (c, addr) => bus.r16(addr) === SIG;
  cpu.addHook(0xa0024588, (c) => {
    if (!guard(c, 0xa0024588) || !machine.disc) return false;
    const dest = c.r[4] >>> 0, pos = c.r[5] >>> 0, off = c.r[6] >>> 0, n = c.r[7] >>> 0;
    const lba = msfToLba(pos), d = machine.disc;
    if (lba < 0 || lba >= d.sectors || off >= 2048) { stats.miss++; log(`read miss lba=${lba} off=${off} n=${n}`); return ret(c, 0); }
    const take = Math.min(n, 2048 - off), src = d.readSector(lba);
    copyToBus(bus, dest, src, off, take);
    stats.reads++; stats.bytes += take; if (verbose) log(`read lba=${lba} off=${off} n=${n} -> ${take}`);
    return ret(c, take);
  });
  cpu.addHook(0xa0027c78, (c) => {
    if (!guard(c, 0xa0027c78) || !machine.disc) return false;
    const TOC = 0xa005544c;
    for (let i = 0; i < 104; i++) bus.w32(TOC + i * 4, 0xffffffff);
    bus.w32(TOC + 1 * 4, 0x41000200);
    const total = machine.disc.sectors + 150, m = Math.floor(total / 4500), s = Math.floor(total / 75) % 60, f = total % 75;
    bus.w32(TOC + 0xa2 * 4, (0x01 << 24) | (m << 16) | (s << 8) | f);
    bus.w8(0xa0042c4c, 0x20);
    stats.toc++; log('ReadTOC HLE');
    return ret(c);
  });
  cpu.addHook(0xa0025f44, (c) => {
    if (!guard(c, 0xa0025f44) || c.r[4] !== 0) return false;
    stats.nullOpen = (stats.nullOpen || 0) + 1; log('open(NULL) -> -1');
    return ret(c, -1);
  });
  machine.card = null;
  machine.insertCard = (set = 5, num = 1) => { const mem = new Uint8Array(256); mem[8] = set & 255; mem[9] = set >> 8; mem[10] = num & 255; mem[11] = num >> 8; machine.card = { set, num, mem }; };
  machine.removeCard = () => { machine.card = null; };
  cpu.addHook(0xa001aa44, (c) => {
    if (!machine.card || !guard(c, 0xa001aa44)) return false;
    return ret(c, (0x80000000 | machine.card.mem[0]) | 0);
  });
  cpu.addHook(0xa001aad4, (c) => {
    if (!machine.card || !guard(c, 0xa001aad4)) return false;
    const off = c.r[4] >>> 0, n = c.r[5] >>> 0, BUF = 0xa0042af0;
    for (let i = 0; i < n && i < 64; i++) bus.w8(BUF + i, machine.card.mem[(off + i) & 255]);
    stats.cardReads = (stats.cardReads || 0) + 1; log(`card read off=${off} n=${n}`);
    return ret(c, BUF);
  });
  return stats;
}

// =============================================================================
// IDLE (ex-idle.js)
// =============================================================================
function installIdleSkip(machine) {
  const cpu = machine.cpu, bus = machine.bus, io = machine.io;
  const stats = { skips: 0, cycles: 0 };
  machine.idle = stats;
  cpu.addHook(0xa00a18f0, (c) => {
    if (!machine.idleSkip || bus.r16(0xa00a18e4) !== 0x230e) return false;
    const g = c.r[28] >>> 0;
    if (bus.r16(g - 14874) !== bus.r16(g - 14880)) return false;
    if (!(c.cr[0] & 1)) return false;
    const pc0 = c.pc, n = io.nextEventCycles(); io.tick(n); stats.skips++; stats.cycles += n;
    c.cycles += n;
    return c.pc !== pc0;
  });
  return stats;
}

// =============================================================================
// FASTPATHS (ex-fastpaths.js)
// =============================================================================
const BLIT_WORDS = [0xc0828024, 0x8483fffe, 0x74607464, 0x84888001, 0x9000a43c, 0xc0828030, 0x80a48870, 0xc082802c, 0x80859010, 0x741c2448,
  0x04537560, 0x80a49410, 0xc0828028, 0x80a59010, 0x245d7418, 0xc0828030, 0x8483fffe, 0xd0828030, 0x8822a20a];

function installFastPaths(machine) {
  const cpu = machine.cpu, bus = machine.bus, stats = { blits: 0, pixels: 0 };
  machine.fast = stats;
  cpu.addHook(0xa011220a, (c) => {
    if (!machine.fastPaths) return false;
    for (let i = 0; i < BLIT_WORDS.length; i++) if (bus.r32(0xa0112200 + i * 4) !== BLIT_WORDS[i]) return false;
    const fp = c.r[2] >>> 0, x0 = bus.r32(fp + 48) | 0;
    if (x0 < 0 || x0 > 4096) return false;
    const tab = bus.r32(fp + 44), dst = bus.r32(fp + 40);
    let val = 0;
    for (let x = x0; x >= 0; x--) { val = bus.r32(tab + x * 4); bus.w16(dst + 2 * x, val & 0xffff); }
    bus.w32(fp + 48, 0xffffffff); bus.w32(fp + 12, val);
    c.r[4] = -1; c.r[5] = (dst | 0);
    c.sub(-1, 0, 1);
    c.pc = 0xa011224c;
    stats.blits++; stats.pixels += x0 + 1;
    return true;
  });
  return stats;
}

// =============================================================================
// HYPERSCAN (ex-hyperscan.js)
// =============================================================================
class HyperScan {
  constructor(biosBytes, opts = {}) {
    this.bios = new Uint8Array(biosBytes);
    this.bus = new Bus({ bios: this.bios });
    this.cpu = new SCore7(this.bus);
    this.io = new IO();
    this.io.attach(this.bus, this.cpu);
    this.io.servo.cpu = this.cpu;
    if (opts.fastBoot !== false) this.io.timerDiv = 8;
    this.idleSkip = opts.idleSkip !== false;
    installIdleSkip(this);
    this.fastPaths = opts.fastPaths !== false;
    installFastPaths(this);
    this.uart = '';
    this.io.onUartChar = (c) => { this.uart += String.fromCharCode(c); };
    this.disc = null;
    this.error = null;
    this.fb = { base: 0xa0000000, w: 320, h: 240 };
    this.reset();
  }
  insertDisc(bytes) { this.disc = new Disc(bytes); if (!this.cdhle) this.cdhle = installCdHle(this); return this.disc; }
  reset() { this.cpu.reset(0x9f000000); this.error = null; }
  run(n) {
    if (this.error) return 0;
    const c = this.cpu, io = this.io; let i = 0;
    try {
      while (i < n) {
        const chunk = Math.min(1024, n - i);
        if (c.sleeping) { io.tick(chunk); i += chunk; continue; }
        c.runN(chunk);
        i += chunk; io.tick(chunk);
      }
    } catch (e) { if (e instanceof UnknownOp) this.error = e.message + ' (instr ' + c.cycles + ')'; else throw e; }
    return i;
  }
  renderTo(imageData) { return renderPPU(this, imageData.data); }
  screenSize() { return ppuSize(this); }
  setPad(port, { in0, in1, ax, ay } = {}) {
    const p = this.io.padIn[port ? 1 : 0];
    if (in0 !== undefined) p[0] = in0 & 255;
    if (in1 !== undefined) p[1] = in1 & 255;
    if (ay !== undefined) p[2] = ay & 255;
    if (ax !== undefined) p[3] = ax & 255;
  }
}

// =============================================================================
// SAVESTATE (ex-savestate.js)
// =============================================================================
const MAGIC = 'HSST1';
const CPU_SKIP = new Set(['bus', 'hooks', 'hookMask', 'c32F', 'c16F', 'bF', 'bState', 'bLen', 'pageBlocks', 'codeWords', 'c32W', 'c16W']);
const IO_SKIP = new Set(['cpu', 'servo', 'spuChip', 'onUartChar', 'unmodeled', 'uartOut', 'spuLog']);
const SPU_SKIP = new Set(['io', 'bus']);
const SERVO_SKIP = new Set(['cpu', 'hooks', 'trace', 'log']);

function encode(v, bufs, seen, skip) {
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
  if (ArrayBuffer.isView(v)) {
    if (v instanceof DataView) return undefined;
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    const idx = bufs.length; bufs.push(new Uint8Array(bytes));
    return { __ta: v.constructor.name, i: idx, n: v.length };
  }
  if (v instanceof Map) return { __map: [...v.entries()].map(([k, x]) => [k, encode(x, bufs, seen, new Set())]).filter(e => e[1] !== undefined) };
  if (seen.has(v)) return undefined;
  seen.add(v);
  if (Array.isArray(v)) return v.map(x => { const e = encode(x, bufs, seen, new Set()); return e === undefined ? null : e; });
  const out = {};
  for (const k of Object.keys(v)) {
    if ((skip && skip.has(k)) || typeof v[k] === 'function') continue;
    const e = encode(v[k], bufs, seen, skip ? new Set() : new Set());
    if (e !== undefined) out[k] = e;
  }
  seen.delete(v);
  return out;
}
function decodeInto(target, data) {
  for (const k of Object.keys(data)) {
    const d = data[k], t = target[k];
    if (d && typeof d === 'object' && !Array.isArray(d) && '__ta' in d) continue;
    if (d && typeof d === 'object' && !Array.isArray(d) && '__map' in d) { if (t instanceof Map) { t.clear(); for (const [kk, x] of d.__map) t.set(kk, x && typeof x === 'object' ? x : x); } continue; }
    if (Array.isArray(d)) { if (Array.isArray(t)) for (let i = 0; i < d.length && i < t.length; i++) { if (d[i] && typeof d[i] === 'object' && t[i] && typeof t[i] === 'object') decodeInto(t[i], d[i]); else if (d[i] !== null) t[i] = d[i]; } continue; }
    if (d && typeof d === 'object' && t && typeof t === 'object' && !ArrayBuffer.isView(t)) { decodeInto(t, d); continue; }
    if (typeof d !== 'object' || d === null) { try { target[k] = d; } catch (_) {} }
  }
}
function applyTA(target, data, bufs) {
  for (const k of Object.keys(data)) {
    const d = data[k];
    if (d && typeof d === 'object' && !Array.isArray(d) && '__ta' in d) {
      const t = target[k]; if (ArrayBuffer.isView(t) && t.length === d.n) { const u8 = new Uint8Array(t.buffer, t.byteOffset, t.byteLength); u8.set(bufs[d.i].subarray(0, u8.length)); }
      continue;
    }
    if (d && typeof d === 'object' && !Array.isArray(d) && '__map' in d) continue;
    if (Array.isArray(d) && Array.isArray(target[k])) { for (let i = 0; i < d.length && i < target[k].length; i++) if (d[i] && typeof d[i] === 'object' && target[k][i] && typeof target[k][i] === 'object' && !Array.isArray(d[i]) && !('__ta' in d[i])) applyTA(target[k][i], d[i], bufs); continue; }
    if (d && typeof d === 'object' && !Array.isArray(d) && target[k] && typeof target[k] === 'object') applyTA(target[k], d, bufs);
  }
}
async function serialize(m) {
  const bufs = [];
  const state = {
    cpu: encode(m.cpu, bufs, new Set(), CPU_SKIP),
    bus: { ram: encode(m.bus.ram, bufs, new Set(), null) },
    io: encode(m.io, bufs, new Set(), IO_SKIP),
    spu: encode(m.io.spuChip, bufs, new Set(), SPU_SKIP),
    servo: encode(m.io.servo, bufs, new Set(), SERVO_SKIP),
    uart: m.uart,
  };
  const offs = []; let pos = 0;
  for (const b of bufs) { pos = (pos + 7) & ~7; offs.push(pos); pos += b.byteLength; }
  const json = JSON.stringify({ magic: MAGIC, state, offs, sizes: bufs.map(b => b.byteLength) });
  const jb = new TextEncoder().encode(json);
  const head = 4 + jb.byteLength; const total = (head + 7) & ~7;
  const out = new Uint8Array(total + pos); const dv = new DataView(out.buffer);
  dv.setUint32(0, jb.byteLength, true); out.set(jb, 4);
  const base = total; bufs.forEach((b, i) => out.set(b, base + offs[i]));
  return gzip(out);
}
async function deserialize(bytes, m) {
  const raw = await gunzip(bytes);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const jl = dv.getUint32(0, true); const meta = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + jl)));
  if (meta.magic !== MAGIC) throw new Error('arquivo de save state inválido');
  const base = (4 + jl + 7) & ~7;
  const bufs = meta.offs.map((o, i) => raw.slice(base + o, base + o + meta.sizes[i]));
  const s = meta.state;
  applyTA(m.cpu, s.cpu, bufs); decodeInto(m.cpu, s.cpu);
  applyTA(m.bus, { ram: s.bus.ram }, bufs); if (s.bus.ram && m.bus.ram.length === bufs[s.bus.ram.i]?.length) m.bus.ram.set(bufs[s.bus.ram.i]);
  applyTA(m.io, s.io, bufs); decodeInto(m.io, s.io);
  applyTA(m.io.spuChip, s.spu, bufs); decodeInto(m.io.spuChip, s.spu);
  applyTA(m.io.servo, s.servo, bufs); decodeInto(m.io.servo, s.servo);
  m.uart = s.uart || '';
  m.cpu.jitFlush && m.cpu.jitFlush();
  m.cpu.c32F.fill(undefined); m.cpu.c16F.fill(undefined); m.cpu.c32W.fill(0); m.cpu.c16W.fill(0);
  m.bus.codeWords.fill(0);
  return m;
}
async function gzip(bytes) {
  const cs = new CompressionStream('gzip'); const w = cs.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip'); const w = ds.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

// =============================================================================
// AUDIO WORKLET (inline via Blob URL)
// =============================================================================
const WORKLET_SRC = `class HSOut extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.off = 0; this.queued = 0;
    this.consumed = 0; this.under = 0;
    this.port.onmessage = e => { this.q.push(e.data); this.queued += e.data.length >> 1; };
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1], n = L.length;
    let i = 0;
    while (i < n) {
      if (this.q.length === 0) { for (; i < n; i++) { L[i] = 0; R[i] = 0; } this.under++; break; }
      const blk = this.q[0], frames = blk.length >> 1;
      const take = Math.min(n - i, frames - this.off);
      for (let k = 0; k < take; k++) { L[i + k] = blk[2 * (this.off + k)]; R[i + k] = blk[2 * (this.off + k) + 1]; }
      i += take; this.off += take; this.queued -= take; this.consumed += take;
      if (this.off >= frames) { this.q.shift(); this.off = 0; }
    }
    this.port.postMessage({ consumed: this.consumed, under: this.under, queued: this.queued });
    return true;
  }
}
registerProcessor('hs-out', HSOut);`;

// =============================================================================
// UI (ex-script inline do index.html)
// =============================================================================

// ---- cache do BIOS no navegador (IndexedDB) ----
const DB = 'hyperscan', STORE = 'files';
function idbOpen() { return new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbRun(mode, fn) { const db = await idbOpen(); return new Promise((res, rej) => { const tx = db.transaction(STORE, mode); const out = fn(tx.objectStore(STORE)); tx.oncomplete = () => { db.close(); res(out && out.result); }; tx.onerror = () => { db.close(); rej(tx.error); }; }); }
async function saveBios(bytes, name) { try { await idbRun('readwrite', st => st.put({ bytes, name }, 'bios')); } catch (_) {} }
async function loadBiosCache() { try { return await idbRun('readonly', st => st.get('bios')); } catch (_) { return undefined; } }
async function forgetBios() { try { await idbRun('readwrite', st => st.delete('bios')); } catch (_) {} }

const $ = id => document.getElementById(id), log = $('log'), uart = $('uart'), stat = $('stat'), cv = $('cv'), ctx = cv.getContext('2d'); let img = ctx.createImageData(320, 240);
let m = null, running = false, biosBytes = null, discBytes = null, biosName = null;
const rd = f => f.arrayBuffer().then(b => new Uint8Array(b));

function build() { if (!biosBytes) return; m = new HyperScan(biosBytes, { fastBoot: $('fast').checked }); if (discBytes) m.insertDisc(discBytes); info(); }
$('bios').onchange = async e => { const f = e.target.files[0]; if (!f) return; biosBytes = await rd(f); biosName = f.name; saveBios(biosBytes, f.name); refreshUI(); build(); };
$('disc').onchange = async e => { if (!e.target.files[0]) return; discBytes = await rd(e.target.files[0]); refreshUI(); if (m) m.insertDisc(discBytes); info(); };
function refreshUI() {
  const bn = biosName || $('bios').files[0]?.name, dn = $('disc').files[0]?.name;
  $('stBios').textContent = bn || 'Nenhum arquivo escolhido'; $('okBios').textContent = bn ? '✓' : '';
  $('stDisc').textContent = dn || 'Nenhum arquivo escolhido'; $('okDisc').textContent = dn ? '✓' : '';
  $('stepBios').classList.toggle('done', !!bn); $('stepDisc').classList.toggle('done', !!dn);
  $('pBiosT').textContent = bn || 'Nenhum'; $('pBiosOk').textContent = bn ? '✓' : '';
  $('pDiscT').textContent = dn || 'Nenhum'; $('pDiscOk').textContent = dn ? '✓' : '';
  $('run').disabled = !biosBytes; $('start').disabled = !biosBytes;
}
$('stepBios').onclick = () => $('bios').click();
$('stepDisc').onclick = () => $('disc').click();
$('pBios').onclick = () => $('bios').click();
$('pDisc').onclick = () => $('disc').click();
refreshUI();
function syncRun() { $('run').style.display = $('welcome').classList.contains('hide') ? '' : 'none'; }
syncRun();
$('fast').onchange = build;
const hex = v => (v >>> 0).toString(16).padStart(8, '0');
function info() {
  if (!m) return;
  const c = m.cpu; let t = `pc=${hex(c.pc)} instr=${c.cycles} quadros=${m.io.frames}\n`;
  for (let i = 0; i < 32; i += 4) t += [0, 1, 2, 3].map(j => `r${i + j}=${hex(c.r[i + j])}`).join(' ') + '\n';
  if (m.disc) t += `disco: ${m.disc.volumeId} (${m.disc.sectors} setores) ${m.cdhle ? `| CD HLE: ${m.cdhle.reads} leituras, ${(m.cdhle.bytes / 1024) | 0} KB` : ''}\n`;
  if (!m.disc) t += 'sem disco: o BIOS vai parar em "No Disc"\n';
  if (m.error) { t += `PARADA: ${m.error}\n`; $('err').textContent = `O emulador parou: ${m.error}`; $('err').classList.add('show'); }
  log.textContent = t; uart.textContent = m.uart.replace(/\r/g, '').slice(-1500) || 'UART…';
}

let last = performance.now(), lastI = 0, lastF = 0, drawnFrame = -1, drawnAt = 0, drawSkip = 0, drawEvery = 1, drawMs = 0;
function frame() {
  if (!running || !m) return;
  const t0 = performance.now();
  const audioClock = !!wnode && !!actx && actx.state === 'running';
  const budget = audioClock && audioSeconds() < 0.15 ? 25 : 13;
  while (performance.now() - t0 < budget && !m.error) {
    if (audioClock && audioSeconds() > 0.3) break;
    m.run(20000);
  }
  if (m.io.frames !== drawnFrame && (drawSkip++ % drawEvery === 0 || performance.now() - drawnAt > 120)) {
    const td0 = performance.now();
    const [W, H] = m.screenSize(); if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; img = ctx.createImageData(W, H); }
    m.renderTo(img); ctx.putImageData(img, 0, 0); drawnFrame = m.io.frames; drawnAt = performance.now();
    const cost = performance.now() - td0; drawMs = drawMs * 0.8 + cost * 0.2;
    drawEvery = drawMs > 12 ? 3 : drawMs > 6 ? 2 : 1;
  }
  info();
  const now = performance.now(); if (now - last > 1000) { stat.textContent = `${(((m.cpu.cycles - lastI) / (now - last)) / 1000).toFixed(1)} MIPS · ${(((m.io.frames - lastF) * 1000) / (now - last)).toFixed(0)} quadros/s`; last = now; lastI = m.cpu.cycles; lastF = m.io.frames; }
  feedAudio();
  if (m.error) running = false; else requestAnimationFrame(frame);
}

let actx = null, wnode = null, posted = 0, consumedW = 0, underW = 0, feedTimer = null, ratio = 1;
async function startAudio() {
  if (actx) { actx.resume(); return; }
  try { actx = new AudioContext({ sampleRate: 44100 }); } catch (e) { try { actx = new AudioContext(); } catch (e2) { return; } }
  ratio = 44100 / actx.sampleRate;
  try {
    // Worklet via Blob URL (não precisa de audio-worklet.js no servidor)
    const blob = new Blob([WORKLET_SRC], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    await actx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    wnode = new AudioWorkletNode(actx, 'hs-out', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    wnode.port.onmessage = e => { consumedW = e.data.consumed; underW = e.data.under; };
    wnode.connect(actx.destination);
    feedTimer = setInterval(feedAudio, 20);
  } catch (e) {
    wnode = null;
    const node = actx.createScriptProcessor(2048, 0, 2);
    node.onaudioprocess = ev => {
      const L = ev.outputBuffer.getChannelData(0), R = ev.outputBuffer.getChannelData(1), chip = m && m.io.spuChip;
      const d = chip ? chip.pull(L.length, ratio) : new Float32Array(L.length * 2), on = $('snd').checked;
      for (let i = 0; i < L.length; i++) { L[i] = on ? d[2 * i] : 0; R[i] = on ? d[2 * i + 1] : 0; }
    };
    node.connect(actx.destination);
  }
}
function audioSeconds() {
  const chip = m && m.io.spuChip; if (!chip) return 0;
  return chip.buffered() / 44100 + (wnode && actx ? Math.max(0, posted - consumedW) / actx.sampleRate : 0);
}
function feedAudio() {
  if (!wnode || !m || !running || !actx) return;
  const target = Math.round(0.3 * actx.sampleRate), buffered = posted - consumedW;
  let need = target - buffered; if (need < 256) return; need = Math.min(need, 16384);
  const real = Math.floor(m.io.spuChip.buffered() * actx.sampleRate / 44100);
  need = Math.min(need, real); if (need < 256) return;
  const d = m.io.spuChip.pull(need, ratio), on = $('snd').checked;
  if (!on) d.fill(0);
  wnode.port.postMessage(d, [d.buffer]); posted += need;
}

const isTouch = matchMedia('(pointer: coarse)').matches;
async function fullscreen() {
  try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); } catch (_) {}
  try { await screen.orientation?.lock?.('landscape'); } catch (_) {}
}
$('fsbtn').onclick = () => { if (document.fullscreenElement) document.exitFullscreen?.(); else fullscreen(); };
function orient() { document.body.classList.toggle('portrait', innerHeight > innerWidth); }
addEventListener('resize', orient); orient();
let idleT = 0;
const _panel = $('panel');
function wakeUI() { document.body.classList.remove('idle'); clearTimeout(idleT); if (running && !_panel.classList.contains('open')) idleT = setTimeout(() => document.body.classList.add('idle'), 2500); }
for (const ev of ['pointermove', 'pointerdown', 'keydown', 'touchstart']) addEventListener(ev, wakeUI, { passive: true });
function startGame() { $('welcome').classList.add('hide'); syncRun(); $('run').click(); }
$('start').onclick = startGame;
$('run').onclick = () => {
  if (!m && biosBytes) build();
  startAudio(); running = !running; $('run').textContent = running ? 'Pausar' : 'Rodar';
  if (running) $('welcome').classList.add('hide'); wakeUI();
  if (running && isTouch) fullscreen();
  if (running) { last = performance.now(); lastI = m ? m.cpu.cycles : 0; lastF = m ? m.io.frames : 0; frame(); feedAudio(); }
};
$('step').onclick = () => { m?.run(1); info(); };
$('rst').onclick = () => { build(); };
function flashStat(text) { const old = stat.textContent; stat.textContent = text; setTimeout(() => { if (stat.textContent === text) stat.textContent = old; }, 2500); }
$('svst').onclick = async () => {
  if (!m) { flashStat('Carregue o BIOS e o disco antes de salvar'); return; }
  const bytes = await serialize(m);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a'); a.href = url; a.download = `hyperscan-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.hsstate`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  flashStat('Estado salvo');
};
$('ldst').onclick = () => $('stIn').click();
$('stIn').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  if (!m) { if (!biosBytes) { flashStat('Carregue o BIOS antes de carregar o estado'); return; } build(); }
  try {
    await deserialize(new Uint8Array(await f.arrayBuffer()), m);
    drawnFrame = -1; $('welcome').classList.add('hide'); syncRun(); info();
    flashStat('Estado carregado');
  } catch (err) { flashStat('Não foi possível carregar: ' + err.message); }
  e.target.value = '';
};
$('card').onclick = () => { if (!m || !m.insertCard) return; m.insertCard(5, 1); setTimeout(() => m.removeCard(), 2500); };

const panel = $('panel'), gear = $('gear');
gear.onclick = e => { e.stopPropagation(); panel.classList.toggle('open'); document.body.classList.remove('idle'); };
document.addEventListener('click', e => { if (panel.classList.contains('open') && !panel.contains(e.target) && e.target !== gear) panel.classList.remove('open'); });

const cfg = () => ({ VR: $('swVR').checked, YB: $('swYB').checked, invY: $('invY').checked, invX: $('invX').checked });
function remapKey(k) {
  const c = cfg();
  if (k === 'z') return c.VR ? 'x' : 'z';
  if (k === 'x') return c.VR ? 'z' : 'x';
  if (k === 'c') return c.YB ? 'v' : 'c';
  if (k === 'v') return c.YB ? 'c' : 'v';
  return k;
}
const COLOR = { z: 'Verde', x: 'Vermelho', c: 'Amarelo', v: 'Azul' };
function renderFaceLabels() { for (const el of document.querySelectorAll('#face [data-base]')) el.textContent = COLOR[remapKey(el.dataset.base)]; }
for (const id of ['swVR', 'swYB', 'invY', 'invX']) $(id).onchange = () => { renderFaceLabels(); pushPad(); };

const KEYS = { Enter: [0, 0x02], Shift: [0, 0x04], z: [1, 0x80], x: [1, 0x40], c: [1, 0x20], v: [0, 0x01], a: [0, 0x08], s: [0, 0x10], q: [0, 0x20], w: [0, 0x40] }, held = new Set();
let stickX = 0, stickY = 0;
function pushPad() {
  if (!m) return; const c = cfg(); let in0 = 0, in1 = 0;
  for (const k of held) { const r = remapKey(k); if (r in KEYS) { if (KEYS[r][0]) in1 |= KEYS[r][1]; else in0 |= KEYS[r][1]; } }
  let dx = stickX, dy = stickY;
  if (dx === 0 && dy === 0) {
    dx = (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0);
    dy = (held.has('ArrowDown') ? 1 : 0) - (held.has('ArrowUp') ? 1 : 0);
  }
  if (c.invX) dx = -dx;
  if (c.invY) dy = -dy;
  m.setPad(0, { in0, in1, ax: Math.round(0x7f + Math.max(-1, Math.min(1, dx)) * 127), ay: Math.round(0x7f + Math.max(-1, Math.min(1, dy)) * 127) });
}
const keyName = e => e.key.length === 1 ? e.key.toLowerCase() : e.key;
addEventListener('keydown', e => { const k = keyName(e); if (k in KEYS || k.startsWith('Arrow')) { held.add(k); pushPad(); e.preventDefault(); } });
addEventListener('keyup', e => { held.delete(keyName(e)); pushPad(); });

const pad = $('pad'), vpad = $('vpad');
vpad.checked = isTouch;
const syncPad = () => pad.classList.toggle('show', vpad.checked);
vpad.onchange = syncPad; syncPad(); renderFaceLabels();
$('padA').oninput = e => document.documentElement.style.setProperty('--padA', (e.target.value / 100).toFixed(2));
document.documentElement.style.setProperty('--padA', ($('padA').value / 100).toFixed(2));
for (const el of pad.querySelectorAll('[data-k]')) {
  const k = el.dataset.k;
  const down = e => { e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch (_) {} held.add(k); el.classList.add('on'); pushPad(); };
  const up = () => { held.delete(k); el.classList.remove('on'); pushPad(); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  el.addEventListener('contextmenu', e => e.preventDefault());
}
const stickEl = $('stick'), knob = $('knob');
function stickSet(e) {
  const r = stickEl.getBoundingClientRect(), R = r.width / 2;
  let dx = (e.clientX - (r.left + R)) / R, dy = (e.clientY - (r.top + R)) / R;
  const len = Math.hypot(dx, dy); if (len > 1) { dx /= len; dy /= len; }
  stickX = dx; stickY = dy;
  knob.style.left = (50 + dx * 38 - 22.5) + '%'; knob.style.top = (50 + dy * 38 - 22.5) + '%';
  pushPad();
}
function stickEnd() { stickX = 0; stickY = 0; knob.style.left = '27.5%'; knob.style.top = '27.5%'; pushPad(); }
stickEl.addEventListener('pointerdown', e => { e.preventDefault(); try { stickEl.setPointerCapture(e.pointerId); } catch (_) {} stickSet(e); });
stickEl.addEventListener('pointermove', e => { if (stickEl.hasPointerCapture && stickEl.hasPointerCapture(e.pointerId)) stickSet(e); });
stickEl.addEventListener('pointerup', stickEnd);
stickEl.addEventListener('pointercancel', stickEnd);
stickEl.addEventListener('lostpointercapture', stickEnd);

const helpEl = $('help');
function openHelp() { helpEl.classList.add('open'); }
function closeHelp() { helpEl.classList.remove('open'); }
$('helpOpen').onclick = openHelp; $('helpBtn').onclick = () => { panel.classList.remove('open'); openHelp(); };
$('helpClose').onclick = closeHelp;
helpEl.addEventListener('click', e => { if (e.target === helpEl) closeHelp(); });
addEventListener('keydown', e => { if (e.key === 'Escape') closeHelp(); });

$('forgetBios').onclick = async () => { await forgetBios(); biosBytes = null; biosName = null; m = null; refreshUI(); flashStat('BIOS esquecido'); };
loadBiosCache().then(rec => { if (rec && rec.bytes) { biosBytes = rec.bytes; biosName = rec.name; refreshUI(); flashStat('BIOS lembrada deste navegador'); } });