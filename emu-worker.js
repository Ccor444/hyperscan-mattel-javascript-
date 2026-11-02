// Thread do emulador: roda o núcleo WASM (com JIT síncrono) fora da thread da página.
// Protocolo (página -> worker): bios, disc, build, run, pad, card, step, save, load, audio, snd, destroy
//              (worker -> página): built, frame, info, saved, loaded, error
import { HyperScan } from './wasm/hyperscan-wasm.js';

let m = null, bios = null, disc = null, fast = true, running = false, snd = true;
let audio = null;                       // { port, sampleRate, ratio }
let posted = 0, consumedW = 0;
let frameInFlight = false, spare = null, drawnFrame = -1;
let t0 = 0, f0 = 0, lastInfo = 0, lastStat = 0, lastI = 0, lastF = 0, statText = '';
let timer = 0, padState = null, underW = 0, worstMs = 0;
let lastJ = 0, topInfo = '';
let tEmu = 0, tRend = 0, nRend = 0, lastRender = 0;      // diagnóstico: tempo gasto emulando e desenhando
// yield sem o piso de 4 ms que setTimeout(0) tem em workers (timers aninhados): MessageChannel
const yc = new MessageChannel(); yc.port1.onmessage = () => { loop(); };
const yieldNow = () => { timer = 1; yc.port2.postMessage(0); };
const post = (msg, tr) => self.postMessage(msg, tr || []);

async function build() {
  try {
    if (m) { m.destroy(); m = null; }
    if (!bios) return;
    m = await HyperScan.create(bios, { fastBoot: fast });
    if (disc) m.insertDisc(disc);
    if (padState) m.setPad(0, padState);
    posted = consumedW = 0; drawnFrame = -1;
    post({ t: 'built' });
    sendInfo(true);
  } catch (e) { post({ t: 'error', msg: 'Falha ao iniciar o núcleo WASM: ' + e.message }); }
}

function audioSeconds() {
  if (!m) return 0;
  return m.audioBuffered() / 44100 + (audio ? Math.max(0, posted - consumedW) / audio.sampleRate : 0);
}
function feedAudio() {
  if (!audio || !m || !running) return;
  const target = Math.round(0.3 * audio.sampleRate), buffered = posted - consumedW;
  let need = target - buffered; if (need < 256) return; need = Math.min(need, 16384);
  // só envia amostras reais (o anel do SPU pode ter menos que o colchão pede)
  const real = Math.floor(m.audioBuffered() * audio.sampleRate / 44100);
  need = Math.min(need, real); if (need < 256) return;
  const d = m.pullAudio(need, audio.ratio);
  if (!snd) d.fill(0);
  audio.port.postMessage(d, [d.buffer]); posted += need;
}

let off = null, offCtx = null, offImg = null;     // OffscreenCanvas (a página transfere o canvas: o desenho fica todo no worker)
function sendFrame() {
  if (off) {
    if (m.frames === drawnFrame) return;
    const [W, H] = m.screenSize();
    if (off.width !== W || off.height !== H || !offImg) { off.width = W; off.height = H; offImg = offCtx.createImageData(W, H); }
    m.renderTo(offImg); offCtx.putImageData(offImg, 0, 0); drawnFrame = m.frames;
    return;
  }
  if (frameInFlight || m.frames === drawnFrame) return;
  const [W, H] = m.screenSize(), need = W * H * 4;
  let buf = spare && spare.byteLength === need ? spare : new ArrayBuffer(need); spare = null;
  m.renderTo({ data: new Uint8ClampedArray(buf) });
  drawnFrame = m.frames; frameInFlight = true;
  post({ t: 'frame', w: W, h: H, buf }, [buf]);
}

function sendInfo(force) {
  const now = performance.now();
  if (!force && now - lastInfo < 250) return;
  lastInfo = now;
  if (!m) return;
  const regs = []; for (let i = 0; i < 32; i++) regs.push(m.reg(i));
  post({ t: 'info', pc: m.pc, cycles: m.cycles, frames: m.frames, regs, disc: m.disc, cdhle: m.cdhle, error: m.error, uart: m.uart.replace(/\r/g, '').slice(-1500), stat: statText, jit: m.jitStats(), fb: m.jitFallbacks(8), top: topInfo });
}

let trapCount = 0;
function loop() {
  try { loopBody(); }
  catch (e) {
    // erro do WASM (trap) ou de JS: mostra o texto real em vez de morrer calado; 1ª vez desliga o JIT e segue
    const txt = (e && e.name ? e.name + ': ' : '') + (e && e.message) + (e && e.stack ? '\n' + String(e.stack).split('\n').slice(1, 4).join('\n') : '');
    ++trapCount;
    if (trapCount === 1 && m && m.x && m.x.hs_jit_config) {
      try { m.x.hs_jit_config(m.h, 0, 20, 1); statText = 'JIT desligado após erro: ' + (e && e.message); post({ t: 'warn', msg: txt }); } catch (_) {}
      timer = setTimeout(loop, 4);
    } else {
      running = false;
      post({ t: 'error', msg: 'Erro no WASM: ' + txt + ' (pc=0x' + ((m && m.pc) >>> 0).toString(16) + ')' });
    }
  }
}
function loopBody() {
  timer = 0;
  if (!running || !m) return;
  const s0 = performance.now();
  const audioClock = !!audio;
  // relógio: o áudio, quando está tocando; senão, 59,94 quadros/s de parede
  const budget = audioClock && audioSeconds() < 0.15 ? 25 : 13;
  while (performance.now() - s0 < budget && !m.error) {
    if (audioClock) { if (audioSeconds() > 0.3) break; }
    else if (m.frames > f0 + (performance.now() - t0) * 0.05994 + 1) break;
    m.run(20000);
  }
  const tAfterEmu = performance.now(); tEmu += tAfterEmu - s0;
  // desenho adaptativo: se a emulação está atrasada (áudio baixo / abaixo do tempo real), pula quadros de vídeo
  // (a lógica do jogo não muda) e desenha no mínimo a cada 100 ms; sem atraso, desenha todo quadro novo (máx. ~70/s)
  const lagging = audioClock ? audioSeconds() < 0.12 : m.frames < f0 + (tAfterEmu - t0) * 0.05994 - 2;
  if (tAfterEmu - lastRender >= (lagging ? 100 : 14)) {
    const r0 = performance.now(); sendFrame();
    if (m.frames === drawnFrame) { lastRender = r0; tRend += performance.now() - r0; ++nRend; }
  }
  feedAudio();
  const now = performance.now();
  if (now - lastStat > 1000) {
    const dq = Math.max(1, m.frames - lastF);
    statText = `${(((m.cycles - lastI) / (now - lastStat)) / 1000).toFixed(1)} MIPS · ${(((m.frames - lastF) * 1000) / (now - lastStat)).toFixed(0)} quadros/s` + (audio ? ` · som: ${underW} falhas` : '') + ` · pico ${worstMs.toFixed(0)} ms`
      + ` · jit ${(() => { const j = m.jitStats().jitInstrs, p = (j - lastJ) / Math.max(1, m.cycles - lastI) * 100; lastJ = j; return p.toFixed(0); })()}%`
      + ` · emu ${(tEmu / dq).toFixed(1)} ms/q · tela ${(tRend / Math.max(1, nRend)).toFixed(1)} ms ×${nRend}`;
    { const tot = Math.max(1, m.cycles - lastI), io = m.jitIo();
      topInfo = `acessos a periféricos: ${(io / ((now - lastStat) / 1000) / 1000).toFixed(0)} mil/s\n` + m.jitTop(6).map(b => '0x' + (b.pc >>> 0).toString(16) + ' ' + (b.weight / tot * 100).toFixed(1) + '% (bloco de ' + b.n + ')').join('\n');
      m.jitTopReset(); }
    worstMs = 0; tEmu = tRend = nRend = 0;
    lastStat = now; lastI = m.cycles; lastF = m.frames;
  }
  sendInfo(!!m.error);
  if (m.error) { running = false; return; }
  // cede a vez aos eventos (entrada, áudio); se já temos folga, espera um pouco
  const spent = performance.now() - s0; if (spent > worstMs) worstMs = spent;
  if (spent < budget - 1) timer = setTimeout(loop, 4); else yieldNow();
}

self.onmessage = async e => {
  const d = e.data;
  switch (d.t) {
    case 'canvas': off = d.canvas; offCtx = off.getContext('2d'); offImg = null; break;
    case 'bios': bios = d.bytes; break;
    case 'disc': disc = d.bytes; if (m) { m.insertDisc(disc); sendInfo(true); } break;
    case 'build': fast = d.fast; await build(); break;
    case 'run':
      running = d.on && !!m;
      if (running) { t0 = performance.now(); f0 = m.frames; lastStat = t0; lastI = m.cycles; lastF = m.frames; if (!timer) loop(); }
      break;
    case 'pad': padState = d.pad; if (m) m.setPad(0, padState); break;
    case 'card': if (m) { m.insertCard(5, 1); setTimeout(() => m && m.removeCard(), 2500); } break;
    case 'step': if (m) { m.run(1); sendFrame(); sendInfo(true); } break;
    case 'ack': frameInFlight = false; spare = d.buf || null; break;
    case 'snd': snd = d.on; break;
    case 'audio':
      audio = { port: d.port, sampleRate: d.sampleRate, ratio: d.ratio };
      audio.port.onmessage = ev => { consumedW = ev.data.consumed; underW = ev.data.under; };
      break;
    case 'save':
      if (!m) { post({ t: 'saved', err: 'sem máquina' }); break; }
      try { const bytes = await m.saveState(); post({ t: 'saved', bytes }, [bytes.buffer]); } catch (err) { post({ t: 'saved', err: err.message }); }
      break;
    case 'load':
      try { if (!m) await build(); await m.loadState(d.bytes); drawnFrame = -1; posted = consumedW = 0; sendInfo(true); post({ t: 'loaded', ok: true }); }
      catch (err) { post({ t: 'loaded', ok: false, err: err.message }); }
      break;
    case 'destroy': running = false; if (m) { m.destroy(); m = null; } bios = null; break;
  }
};
