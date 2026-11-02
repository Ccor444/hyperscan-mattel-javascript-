import { Bus } from './bus.js';
import { SCore7, UnknownOp } from './cpu.js';
import { Disc } from './disc.js';
import { IO } from './io.js';
import { installCdHle } from './cdhle.js';
import { renderPPU, ppuSize } from './ppu.js';
import { installIdleSkip } from './idle.js';
import { installFastPaths } from './fastpaths.js';

// Máquina HyperScan: CPU + bus + periféricos (src/io.js). Um quadro = frameInstr instruções (vblank da PPU).
export class HyperScan {
  // opts.fastBoot (padrão true): timers 8x mais rápidos, encurta a calibração de atraso do BIOS (~410M -> ~50M instruções)
  constructor(biosBytes, opts = {}) {
    this.bios = new Uint8Array(biosBytes);
    this.bus = new Bus({ bios: this.bios });
    this.cpu = new SCore7(this.bus);
    this.io = new IO();
    this.io.attach(this.bus, this.cpu);
    this.io.servo.cpu = this.cpu;
    if (opts.fastBoot !== false) this.io.timerDiv = 8;
    this.idleSkip = opts.idleSkip !== false;                // avança o tempo em esperas ociosas (ver idle.js)
    installIdleSkip(this);
    this.fastPaths = opts.fastPaths !== false;               // atalhos nativos de laços quentes do jogo (fastpaths.js)
    installFastPaths(this);
    this.uart = '';
    this.io.onUartChar = (c) => { this.uart += String.fromCharCode(c); };
    this.disc = null;
    this.error = null;
    this.fb = { base: 0xa0000000, w: 320, h: 240 };   // placeholder do VDU (ARGB1555), ajustar ao descobrir o registrador real
    this.reset();
  }
  insertDisc(bytes) { this.disc = new Disc(bytes); if (!this.cdhle) this.cdhle = installCdHle(this); return this.disc; }
  reset() { this.cpu.reset(0x9f000000); this.error = null; }
  run(n) {
    if (this.error) return 0;
    const c = this.cpu, io = this.io; let i = 0;
    try {
      while (i < n) {
        // [PERF] chunk 256 → 1024: menos chamadas a io.tick() por quadro (1465 vs 5860).
        // Semântica preservada: irqSrc é checado a cada instrução dentro de runN; só a detecção
        // de mudança em pendingList fica mais grossa (1024 instr ≈ 22 µs, irrelevante para vblank/timer).
        const chunk = Math.min(1024, n - i);
        if (c.sleeping) { io.tick(chunk); i += chunk; continue; }
        c.runN(chunk);
        i += chunk; io.tick(chunk);
      }
    } catch (e) { if (e instanceof UnknownOp) this.error = e.message + ' (instr ' + c.cycles + ')'; else throw e; }
    return i;
  }
  // Desenha o quadro atual do PPU em imageData (320x240 RGBA). Retorna true se alguma camada desenhou.
  renderTo(imageData) { return renderPPU(this, imageData.data); }
  screenSize() { return ppuSize(this); }
  // Controle (MAME hyperscan_ctrl): in0/in1 = bytes de botões (ver io.js), ay/ax = analógico 0..255 (0x7f = centro). port 0/1.
  setPad(port, { in0, in1, ax, ay } = {}) {
    const p = this.io.padIn[port ? 1 : 0];
    if (in0 !== undefined) p[0] = in0 & 255;
    if (in1 !== undefined) p[1] = in1 & 255;
    if (ay !== undefined) p[2] = ay & 255;
    if (ax !== undefined) p[3] = ax & 255;
  }
}