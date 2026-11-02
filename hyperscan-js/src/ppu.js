// Renderizador do PPU do SPG290, portado de MAME (src/devices/machine/spg290_ppu.cpp, Sandro Ronco, BSD-3-Clause).
// Registradores em io.ppu (Map offset -> valor). Paleta de caracteres 0x1000, de sprites 0x1800, sprites 0x4000.
// Otimizado: paletas lidas uma vez por quadro (sem Map por pixel), conversão de cor por tabela, escrita direta quando não há mistura.
export const SCREEN_W = 320, SCREEN_H = 240;
// Tamanho da tela: controle do TV encoder (b3:2 = 0 QVGA, 1 VGA, 2 HVGA); sem ele, bits 1:0 de P_PPU_Control.
export function ppuSize(machine) {
  if (machine.io.tveCtl) { const t = machine.io.tveCtl & 0xc; return t === 4 ? [640, 480] : t === 8 ? [640, 240] : [320, 240]; }
  const r = (machine.io.ppu.get(0) ?? 0) & 3; return r === 1 ? [640, 480] : r === 2 ? [640, 240] : [320, 240];
}
const TX = [
  { x: 0x20, y: 0x24, attr: 0x28, ctl: 0x2c, ptr: 0x30, blend: 0x38, buf: 0xa0 },
  { x: 0x3c, y: 0x40, attr: 0x44, ctl: 0x48, ptr: 0x4c, blend: 0x54, buf: 0xac },
  { x: 0x58, y: 0x5c, attr: 0x60, ctl: 0x64, ptr: 0x68, blend: 0x70, buf: 0xb8 },
];
// tabelas de conversão (idênticas a p5/p6 do original)
const L5 = new Uint8Array(32), L6 = new Uint8Array(64);
for (let v = 0; v < 32; v++) L5[v] = (v << 3) | (v >> 2);
for (let v = 0; v < 64; v++) L6[v] = (v << 2) | (v >> 4);

// tabela de fade: lut[v] = valor que Uint8ClampedArray guarda para v*f/255 (mesmo arredondamento do original)
const _fadeCache = new Map(), _tmpClamp = new Uint8ClampedArray(1);
function fadeLUT(f) {
  let t = _fadeCache.get(f); if (t) return t;
  t = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) { _tmpClamp[0] = v * f / 255; t[v] = _tmpClamp[0]; }
  _fadeCache.set(f, t); return t;
}

export function renderPPU(machine, out) {            // out: Uint8ClampedArray RGBA, ppuSize()
  const P = machine.io.ppu, bus = machine.bus, g = (o) => (P.get(o) ?? 0) >>> 0, [W, H] = ppuSize(machine);
  const dv = bus.dv, ramLen = bus.ram.length;
  const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;     // escrita de pixel como Uint32 só em little-endian (x86/ARM)
  const out32 = LE ? new Uint32Array(out.buffer, out.byteOffset, out.length >> 2) : null;
  if (out32) out32.fill(0xff000000); else { out.fill(0); for (let i = 3; i < out.length; i += 4) out[i] = 255; }
  let drew = false;
  const ctrl = g(0), blendMode = g(0x0c), transrgb = g(0x10);
  const transOn = (transrgb & 0x10000) !== 0, transV = transrgb & 0xffff;
  // paletas lidas uma vez por quadro
  const pal1 = new Uint16Array(512), pal2 = new Uint16Array(512);
  for (let i = 0; i < 512; i++) { pal1[i] = g(0x1000 + 4 * i) & 0xffff; pal2[i] = g(0x1800 + 4 * i) & 0xffff; }

  // ---- escrita de pixel: mistura (blend) só quando pedida; senão escrita direta ----
  const putBlend = (x, y, r, gg, b, blend) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4, sub = blendMode & 1, l0 = blend, l1 = 63 - blend;
    const R = sub ? (out[o] * l0 / 63 | 0) - (r * l1 / 63 | 0) : (out[o] * l0 / 63 | 0) + (r * l1 / 63 | 0);
    const G = sub ? (out[o + 1] * l0 / 63 | 0) - (gg * l1 / 63 | 0) : (out[o + 1] * l0 / 63 | 0) + (gg * l1 / 63 | 0);
    const B = sub ? (out[o + 2] * l0 / 63 | 0) - (b * l1 / 63 | 0) : (out[o + 2] * l0 / 63 | 0) + (b * l1 / 63 | 0);
    out[o] = R; out[o + 1] = G; out[o + 2] = B; drew = true;
  };
  const argb1555 = (x, y, v, blend) => {
    if (v & 0x8000) return;                                     // bit15 = transparente
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
  const put = (x, y, r, gg, b, blend) => {                      // usado pelo TV buffer (sem transparência)
    if (blend) { putBlend(x, y, r, gg, b, blend); return; }
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4; out[o] = r; out[o + 1] = gg; out[o + 2] = b; out[o + 3] = 255; drew = true;
  };

  // ---- camada bitmap: o vetor de linhas guarda deslocamentos em unidades de 2 bytes ----
  const blitBitmap = (L, ctl, posy, posx, blend) => {
    const nptr = g(L.ptr) >>> 0, buf = g(L.buf) >>> 0, maxX = W + posx, maxY = H + posy, is565 = (ctl & 0x1000) !== 0;
    if (out32 && !blend) {                                   // caminho rápido: escrita direta de pixel, linhas fora da tela não são lidas
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

  // ---- camada de caracteres (porte direto do MAME) ----
  const blitCharacter = (L, ctl, attr, posy, posx, blend) => {
    const nptr = g(L.ptr) >>> 0, buf = g(L.buf) >>> 0, hsize = 8 << ((attr >> 4) & 3), vsize = 8 << ((attr >> 6) & 3);
    const bitPixel = ((attr & 3) + 1) << 1, penBank = ((attr >> 8) & 31) * 0x10, pixelWord = 32 / bitPixel, charsLine = 1024 / hsize, penMask = (1 << bitPixel) - 1;
    const maxX = Math.floor((W + posx) / vsize) + 1, maxY = Math.floor((H + posy) / hsize) + 1, is565 = (ctl & 0x1000) !== 0;
    // caminho rápido (sem mistura, little-endian, 2/4/8 bpp): uma leitura de 32 bits por grupo de pixels.
    // Para 2/4/8 bpp, pixelWord*bitPixel = 32, então o grupo g começa exatamente no byte g*4 e a leitura é idêntica.
    const fast = out32 && !blend && bitPixel !== 6;
    for (let y = 0; y <= maxY; y++) for (let x = 0; x <= maxX; x++) {
      const line = (ctl & 0x04) ? 0 : y, addr = line * charsLine + x, charId = bus.r16(nptr + addr * 2) & 0xffff, charAddr = buf + charId * hsize * vsize;
      if (fast) {
        const cellX = x * hsize - posx, cellY = y * vsize - posy;
        for (let cy = 0; cy < vsize; cy++) {
          const py = cellY + cy; if (py < 0 || py >= H) continue;
          const lineAddr = charAddr + cy * hsize, rowOut = py * W;
          for (let g = 0; g < hsize / pixelWord; g++) {
            let lastK = -1, data = 0;
            for (let i = 0; i < pixelWord; i++) {
              const cx = g * pixelWord + i, px = cellX + cx;
              if (px < 0 || px >= W) continue;
              // mesma leitura do original: palavra de 32 bits no byte floor(cx*bp/8); reaproveitada enquanto o byte não muda
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
          const v = pal2[(penBank + pen) & 0x1ff];
          if (out32 && !blend) {
            if (!(v & 0x8000) && px >= 0 && py >= 0 && px < W && py < H) { out32[py * W + px] = L5[(v >> 10) & 31] | (L5[(v >> 5) & 31] << 8) | (L5[v & 31] << 16) | 0xff000000; drew = true; }
          } else argb1555(px, py, v, blend);
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

  // ---- buffer de quadro da TV (RGB565, linhas pares duplicadas sem entrelaçamento) e fade ----
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
