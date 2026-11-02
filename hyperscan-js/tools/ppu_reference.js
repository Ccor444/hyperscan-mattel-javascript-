// Renderizador do PPU do SPG290, portado de MAME (src/devices/machine/spg290_ppu.cpp, Sandro Ronco, BSD-3-Clause).
// Registradores em io.ppu (Map offset -> valor): ver mapa em spg290_ppu.cpp. Paleta de caracteres 0x1000, de sprites 0x1800, sprites 0x4000.
export const SCREEN_W = 320, SCREEN_H = 240;
// Tamanho da tela: controle do TV encoder (b3:2 = 0 QVGA, 1 VGA, 2 HVGA); sem ele, bits 1:0 de P_PPU_Control.
export function ppuSize(machine) {
  if (machine.io.tveCtl) { const t = machine.io.tveCtl & 0xc; return t === 4 ? [640, 480] : t === 8 ? [640, 240] : [320, 240]; }
  const r = (machine.io.ppu.get(0) ?? 0) & 3; return r === 1 ? [640, 480] : r === 2 ? [640, 240] : [320, 240];
}
// camadas: posição x/y, atributo, controle, ptr, blend, buffers 0xa0/0xac/0xb8 (só o primeiro é usado)
const TX = [
  { x: 0x20, y: 0x24, attr: 0x28, ctl: 0x2c, ptr: 0x30, blend: 0x38, buf: 0xa0 },
  { x: 0x3c, y: 0x40, attr: 0x44, ctl: 0x48, ptr: 0x4c, blend: 0x54, buf: 0xac },
  { x: 0x58, y: 0x5c, attr: 0x60, ctl: 0x64, ptr: 0x68, blend: 0x70, buf: 0xb8 },
];

export function renderPPU(machine, out) {            // out: Uint8ClampedArray RGBA, ppuSize()
  const P = machine.io.ppu, bus = machine.bus, g = (o) => (P.get(o) ?? 0) >>> 0, [W, H] = ppuSize(machine);
  out.fill(0); for (let i = 3; i < out.length; i += 4) out[i] = 255;
  let drew = false;
  const ctrl = g(0), blendMode = g(0x0c), transrgb = g(0x10);
  const p5 = (v) => (v << 3) | (v >> 2), p6 = (v) => (v << 2) | (v >> 4);

  // ---- mistura de cores (blend_colors): dest*level/63 +/- src*(63-level)/63 ----
  const put = (x, y, r, gg, b, blend) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    if (blend) {
      const sub = blendMode & 1, l0 = blend, l1 = 63 - blend;
      const R = sub ? (out[o] * l0 / 63 | 0) - (r * l1 / 63 | 0) : (out[o] * l0 / 63 | 0) + (r * l1 / 63 | 0);
      const G = sub ? (out[o + 1] * l0 / 63 | 0) - (gg * l1 / 63 | 0) : (out[o + 1] * l0 / 63 | 0) + (gg * l1 / 63 | 0);
      const B = sub ? (out[o + 2] * l0 / 63 | 0) - (b * l1 / 63 | 0) : (out[o + 2] * l0 / 63 | 0) + (b * l1 / 63 | 0);
      r = R; gg = G; b = B;
    }
    out[o] = r; out[o + 1] = gg; out[o + 2] = b; drew = true;
  };
  const argb1555 = (x, y, v, blend) => { if (!(v & 0x8000)) put(x, y, p5((v >> 10) & 31), p5((v >> 5) & 31), p5(v & 31), blend); };   // bit15 = transparente
  const rgb565 = (x, y, v, blend) => { if ((transrgb & 0x10000) && (transrgb & 0xffff) === v) return; put(x, y, p5((v >> 11) & 31), p6((v >> 5) & 63), p5(v & 31), blend); };

  // ---- camada em modo bitmap: o vetor de linhas guarda deslocamentos em unidades de 2 bytes (valor*2 = byte) ----
  const blitBitmap = (L, ctl, posy, posx, blend) => {
    const nptr = g(L.ptr) >>> 0, buf = g(L.buf) >>> 0, maxX = W + posx, maxY = H + posy, is565 = (ctl & 0x1000) !== 0;
    for (let y = 0; y < maxY; y++) {
      const line = (ctl & 0x04) ? 0 : y, txStart = (bus.r32(nptr + line * 4) * 2) >>> 0;
      for (let x = 0; x < maxX; x += 2) {
        const data = bus.r32(buf + txStart + x * 2);
        for (let b = 0; b < 2; b++) {
          const v = (data >>> (16 * b)) & 0xffff, dx = x + b - posx, dy = y - posy;
          if (is565) rgb565(dx, dy, v, blend); else argb1555(dx, dy, v, blend);
        }
      }
    }
  };

  // ---- camada em modo caractere (porte direto do MAME) ----
  const blitCharacter = (L, ctl, attr, posy, posx, blend) => {
    const nptr = g(L.ptr) >>> 0, buf = g(L.buf) >>> 0, hsize = 8 << ((attr >> 4) & 3), vsize = 8 << ((attr >> 6) & 3);
    const bitPixel = ((attr & 3) + 1) << 1, penBank = ((attr >> 8) & 31) * 0x10, pixelWord = 32 / bitPixel, charsLine = 1024 / hsize, penMask = (1 << bitPixel) - 1;
    const maxX = Math.floor((W + posx) / vsize) + 1, maxY = Math.floor((H + posy) / hsize) + 1, is565 = (ctl & 0x1000) !== 0;
    for (let y = 0; y <= maxY; y++) for (let x = 0; x <= maxX; x++) {
      const line = (ctl & 0x04) ? 0 : y, addr = line * charsLine + x, charId = bus.r16(nptr + addr * 2) & 0xffff, charAddr = buf + charId * hsize * vsize;
      for (let cy = 0; cy < vsize; cy++) {
        const lineAddr = charAddr + cy * hsize;
        for (let cx = 0; cx < hsize; cx++) {
          const data = bus.r32(lineAddr + Math.floor((cx * bitPixel) / 8)), pen = (data >>> ((cx % pixelWord) * bitPixel)) & penMask;
          const pix = g(0x1000 + 4 * ((penBank + pen) & 0x1ff)) & 0xffff, px = x * hsize + cx, py = y * vsize + cy;
          if (is565) rgb565(px - posx, py - posy, pix, blend); else argb1555(px - posx, py - posy, pix, blend);
        }
      }
    }
  };

  // ---- sprites ----
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
          argb1555(px, py, g(0x1800 + 4 * ((penBank + pen) & 0x1ff)) & 0xffff, blend);
        }
        data >>>= 8;
      }
    }
  };

  if (ctrl & 0x1000) {                                   // PPU habilitado
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

  // ---- buffer de quadro da TV (RGB565, só linhas pares duplicadas sem entrelaçamento) e fade, como no MAME ----
  const io = machine.io;
  if (io.bufctl < 3 && io.tvAddr[io.bufctl]) {
    const base = io.tvAddr[io.bufctl], inter = (io.tveCtl & 1) !== 0;
    for (let y = 0; y < H; y += (inter ? 1 : 2)) for (let x = 0; x < W; x++) {
      const v = bus.r16(base + (y * W + x) * 2), r = p5((v >> 11) & 31), gg = p6((v >> 5) & 63), b = p5(v & 31);
      put(x, y, r, gg, b, 0); if (!inter) put(x, y + 1, r, gg, b, 0);
    }
    drew = true;
  }
  if (io.tveFade) { const f = 255 - io.tveFade; for (let i = 0; i < W * H * 4; i += 4) { out[i] = out[i] * f / 255; out[i + 1] = out[i + 1] * f / 255; out[i + 2] = out[i + 2] * f / 255; } }
  return drew;
}
