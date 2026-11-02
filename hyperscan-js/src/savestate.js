// Save states do HyperScan: o estado completo da máquina em um arquivo (gzip), para voltar exatamente daquele quadro.
// Salvo: CPU (registradores, PC, ciclos, flags), RAM, periféricos (IO, timers, PPU, I2C, pad), SPU (canais, FIFO, anel) e servo.
// Não salvo (são reconstruídos): caches do JIT e do decodificador, hooks de HLE, disco e BIOS (carregados de novo pela página).
// Formato: [4 bytes: tamanho do JSON][JSON][buffers binários alinhados a 8 bytes], comprimido com gzip.
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
    const idx = bufs.length; bufs.push(new Uint8Array(bytes));                         // cópia do conteúdo
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
    if (d && typeof d === 'object' && !Array.isArray(d) && '__ta' in d) continue;   // tipado: tratado em applyTA (não sobrescrever)
    if (d && typeof d === 'object' && !Array.isArray(d) && '__map' in d) { if (t instanceof Map) { t.clear(); for (const [kk, x] of d.__map) t.set(kk, x && typeof x === 'object' ? x : x); } continue; }
    if (Array.isArray(d)) { if (Array.isArray(t)) for (let i = 0; i < d.length && i < t.length; i++) { if (d[i] && typeof d[i] === 'object' && t[i] && typeof t[i] === 'object') decodeInto(t[i], d[i]); else if (d[i] !== null) t[i] = d[i]; } continue; }
    if (d && typeof d === 'object' && t && typeof t === 'object' && !ArrayBuffer.isView(t)) { decodeInto(t, d); continue; }
    if (typeof d !== 'object' || d === null) { try { target[k] = d; } catch (_) {} }
  }
}
// aplica os tipados (precisa dos buffers): troca os marcadores {__ta} pelo conteúdo real
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

export async function serialize(m) {
  const bufs = [];
  const state = {
    cpu: encode(m.cpu, bufs, new Set(), CPU_SKIP),
    bus: { ram: encode(m.bus.ram, bufs, new Set(), null) },
    io: encode(m.io, bufs, new Set(), IO_SKIP),
    spu: encode(m.io.spuChip, bufs, new Set(), SPU_SKIP),
    servo: encode(m.io.servo, bufs, new Set(), SERVO_SKIP),
    uart: m.uart,
  };
  // desloca cada buffer para um offset alinhado a 8 bytes
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
export async function deserialize(bytes, m) {
  const raw = await gunzip(bytes);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const jl = dv.getUint32(0, true); const meta = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + jl)));
  if (meta.magic !== MAGIC) throw new Error('arquivo de save state inválido');
  const base = (4 + jl + 7) & ~7;
  const bufs = meta.offs.map((o, i) => raw.slice(base + o, base + o + meta.sizes[i]));
  const s = meta.state;
  // tipados primeiro (com o conteúdo de cada buffer), depois os escalares
  applyTA(m.cpu, s.cpu, bufs); decodeInto(m.cpu, s.cpu);
  applyTA(m.bus, { ram: s.bus.ram }, bufs); if (s.bus.ram && m.bus.ram.length === bufs[s.bus.ram.i]?.length) m.bus.ram.set(bufs[s.bus.ram.i]);
  applyTA(m.io, s.io, bufs); decodeInto(m.io, s.io);
  applyTA(m.io.spuChip, s.spu, bufs); decodeInto(m.io.spuChip, s.spu);
  applyTA(m.io.servo, s.servo, bufs); decodeInto(m.io.servo, s.servo);
  m.uart = s.uart || '';
  // o estado de JIT e de decodificação é descartado e reconstruído a partir da RAM restaurada
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
