// Mapa de memória do SPG290 (inferido do BIOS: constantes ldis 0xa00x = RAM, 0x88xx = periféricos).
// Tudo configurável e com log de acessos desconhecidos para guiar o bring-up.
export class Bus {
  constructor({ ramSize = 16 << 20, bios } = {}) {
    this.ram = new Uint8Array(ramSize);
    this.bios = bios;               // Uint8Array 1 MiB
    this.dv = new DataView(this.ram.buffer);
    this.bdv = new DataView(bios.buffer, bios.byteOffset, bios.byteLength);
    this.mmio = [];                 // {base,size,read(off,sz),write(off,v,sz),name}
    this.unmapped = new Map();
    // JIT: palavras de RAM (<4 MiB) que fazem parte de blocos traduzidos; escrever nelas invalida os blocos (cpu.onCodeWrite)
    this.codeWords = new Uint8Array(0x100000); this.onCodeWrite = null;
    this.logMMIO = false;
  }
  addMMIO(base, size, name, dev) { this.mmio.push({ base: base >>> 0, size, name, ...dev }); }
  _region(a) {
    a >>>= 0;
    const seg = a >>> 24, o = a & 0xffffff;      // segmentos de 24 bits, como no hardware (miu 8/24)
    if (seg === 0x9e || seg === 0x9f) return { k: 'bios', o };
    if (seg === 0x80 || seg === 0xa0) return { k: 'ram', o };
    return null;
  }
  _find(a) { a >>>= 0; for (const m of this.mmio) if (a >= m.base && a < m.base + m.size) return m; return null; }
  _miss(a, w, sz) { if (this.unmapped.size < 2000) { const k = (a >>> 0).toString(16) + (w ? "W" : "R"); this.unmapped.set(k, (this.unmapped.get(k) || 0) + 1); } return 0; }
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
  // Acessos especializados: RAM (segmentos 0x80/0xa0) direto, o resto cai no caminho genérico (BIOS, periféricos, não mapeado).
  r8(a) { a >>>= 0; const s = a >>> 24; if (s === 0xa0 || s === 0x80) return this.ram[a & 0xffffff]; if (s === 0x9f || s === 0x9e) { const o = a & 0xffffff; return o < this.bios.length ? this.bios[o] : 0; } return this.read(a, 1); }
  r16(a) { a >>>= 0; const s = a >>> 24; if (s === 0xa0 || s === 0x80) return this.dv.getUint16(a & 0xffffff, true); if (s === 0x9f || s === 0x9e) { const o = a & 0xffffff; return o + 2 <= this.bios.length ? this.bdv.getUint16(o, true) : 0; } return this.read(a, 2); }
  r32(a) { a >>>= 0; const s = a >>> 24; if (s === 0xa0 || s === 0x80) return this.dv.getUint32(a & 0xffffff, true); if (s === 0x9f || s === 0x9e) { const o = a & 0xffffff; return o + 4 <= this.bios.length ? this.bdv.getUint32(o, true) : 0; } return this.read(a, 4); }
  w8(a, v) { a >>>= 0; const s = a >>> 24; if (s === 0xa0 || s === 0x80) { const o = a & 0xffffff; this.ram[o] = v; if (o < 0x400000 && this.codeWords[o >>> 2] !== 0) this.onCodeWrite(o); } else this.write(a, v, 1); }
  w16(a, v) { a >>>= 0; const s = a >>> 24; if (s === 0xa0 || s === 0x80) { const o = a & 0xffffff; this.dv.setUint16(o, v & 0xffff, true); if (o < 0x400000 && (this.codeWords[o >>> 2] | this.codeWords[(o + 1) >>> 2]) !== 0) this.onCodeWrite(o); } else this.write(a, v, 2); }
  w32(a, v) { a >>>= 0; const s = a >>> 24; if (s === 0xa0 || s === 0x80) { const o = a & 0xffffff; this.dv.setUint32(o, v >>> 0, true); if (o < 0x400000 && (this.codeWords[o >>> 2] | this.codeWords[(o + 3) >>> 2]) !== 0) this.onCodeWrite(o); } else this.write(a, v, 4); }
}
