// Leitor de imagem de CD: detecta setores brutos (2352) / cooked (2048) e navega ISO9660.
export class Disc {
  constructor(buf) {
    this.u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const sync = [0,255,255,255,255,255,255,255,255,255,255,0];
    const raw = sync.every((v, i) => this.u8[i] === v);
    this.sectorSize = raw ? 2352 : 2048;
    this.dataOff = raw ? (this.u8[15] === 2 ? 24 : 16) : 0; // MODE1: 16, MODE2 form1: 24
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
