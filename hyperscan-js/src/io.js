import { SPU, AUDIO_RATE } from './spu.js';
import { Servo } from './servo.js';
// Periféricos do SPG290 (docs: spg290.pdf / spce3200.pdf do repositório de referência).
// Registradores não modelados: leem 0xFFFFFFFF e ignoram escrita (mesmo comportamento do hyperscan-emulator),
// exceto o PPU (0x8801xxxx), que guarda o valor escrito.
// [PERF] Array compartilhado para pendingList quando não há IRQ pendente/desmascarado (caso comum).
// Nunca é modificado pelo chamador (só lido) — seguro para reuso.
const EMPTY = [];
export class IO {
  constructor() {
    this.uartOut = []; this.onUartChar = null;
    this.unmodeled = new Map();
    // TV encoder (MAME spg29x.cpp): 0x88030000 controle (b3:2 = 0 QVGA / 1 VGA / 2 HVGA, b0 entrelaçado), 0x8803000c fade (0..255), 0x88070000..0b endereços dos 3 buffers
    // de quadro da TV (RGB565), 0x88090020 BUFCTL (b1:0 = buffer exibido, 3 = nenhum)
    this.tveCtl = 0; this.tveFade = 0; this.tvAddr = [0, 0, 0]; this.bufctl = 3;
    this.cpu = null;
    this.servo = new Servo();
    this.timerDiv = +(globalThis.process?.env?.TIMERDIV) || 64;   // instruções por contagem do timer
    // controlador de interrupção: fontes 0..39, máscara 1 = mascarado (reset: tudo mascarado)
    this.asserted = [0, 0];            // [bits 0..31, bits 32..39] — linhas de IRQ dos periféricos (nível)
    this.mask = [0xffffffff, 0xffffffff];
    this.ppu = new Map();
    this.ppuCtrl = 0; this.ppuStatus = 0;
    this.timers = Array.from({ length: 6 }, () => ({ ctrl: 0, ccp: 0, preload: 0, up: 0, rate: 0 }));
    this.frameCycles = 0; this.frameLen = 1500000;   // instruções por quadro (~60 Hz)
    // Contador de linha do PPU (0x88010094), como em flick/src/ppu.c + screen.c: linha = m_vblank_lines + vpos, vpos = posição do feixe.
    // QVGA NTSC progressivo: 525 linhas totais, 240 visíveis (vblank a partir da linha 240). Usamos frameCycles como relógio do feixe.
    this.rasterLines = 525; this.rasterVis = 240; this.vblankLines = 0;
    this.frames = 0;
    this.spu = new Map(); this.spuTimer = new Float64Array(32); this.spuPlayFrames = 3; this.softFifo = 0; this.softIrqEn = 0; this.softIrqSts = 0; this.softThr = 0; this.softSamples = 0; this.softAcc = 0; this.beat = { en: 0, sts: 0, base: 0, cnt: 0, acc: 0 }; this.spuLog = [];
    this.i2c = { cr: 0, intr: 0, cvr: 0, id: 0, addr: 0, wdata: 0, rdata: 0 };
    // Controles (MAME hyperscan_ctrl.cpp): o BIOS lê por I2C; porta = (reg>>4)&15 (0 e 1), reg 0..3 = bytes IN.0 (botões: 01 Azul, 02 Start, 04 Select, 08 Ombro E, 10 Ombro D, 20 Gatilho E, 40 Gatilho D),
    // IN.1 (20 Amarelo, 40 Vermelho, 80 Verde), IN.2 = analógico Y e IN.3 = analógico X (0x7f = centro); reg >= 4 devolve a soma de verificação ((IN0+IN1+IN2+IN3) << 2) | porta.
    this.padIn = [[0, 0, 0x7f, 0x7f], [0, 0, 0x7f, 0x7f]]; this.padLatch = [[0, 0, 0, 0], [0, 0, 0, 0]];
    // acumulador de instruções para o batching de spu.sync() (ver tick)
    this._audioAcc = 0;
  }
  attach(bus, cpu) {
    if (cpu) this.cpu = cpu;
    this.spuChip = new SPU(this, bus);
    for (const base of [0x08000000, 0x88000000]) {
      bus.addMMIO(base, 0x01000000, 'io', { read: (o, sz) => this.read(o, sz), write: (o, v, sz) => this.write(o, v, sz) });
    }
  }
  // --- SPU (0x88050000): o chip (spu.js, integrado do Flick) cuida dos canais, do FIFO de DAC e da síntese.
  // Beat (contador de batida, fonte 1) fica aqui. Os registradores são o mapa this.spu (leitura = último valor escrito).
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
  // --- IRQ ---
  setSrc(n, on) { const w = n >> 5, b = 1 << (n & 31); this.asserted[w] = on ? (this.asserted[w] | b) >>> 0 : (this.asserted[w] & ~b) >>> 0; }
  // [PERF] Fast path: nada pendente E desmascarado → retorna EMPTY sem iterar 40 fontes.
  // Bits asserted que estão mascarados não geram IRQ, então o teste é só na interseção.
  pendingList() {
    if (((this.asserted[0] & ~this.mask[0]) | (this.asserted[1] & ~this.mask[1])) === 0) return EMPTY;
    const o = [];
    for (let n = 0; n < 40; n++) { const w = n >> 5, b = 1 << (n & 31); if ((this.asserted[w] & b) && !(this.mask[w] & b)) o.push(n); }
    return o;
  }
  // Quantas instruções até o próximo evento que pode gerar interrupção (fim de quadro ou estouro de timer): usado para pular esperas ociosas.
  nextEventCycles() {
    let n = this.frameLen - this.frameCycles;
    for (let i = 0; i < 6; i++) { const T = this.timers[i]; if (T.ctrl & 0x80000000) n = Math.min(n, Math.ceil((0x10000 - T.up) * this.timerDiv)); }
    return Math.max(1, Math.min(n, 200000));
  }
  tick(cycles) {
    this.frameCycles += cycles;
    if (this.frameCycles >= this.frameLen) {
      this.frameCycles -= this.frameLen; this.frames++;
      this.ppuStatus |= 1;                           // vblank start
      if (this.onFrame) this.onFrame();
    }
    this.setSrc(10, (this.ppuStatus & 1) && (this.ppuCtrl & 1));      // PPU vblank start
    // [PERF] Removido `this.setSrc(9, false)` — ninguém seta a fonte 9 em outro ponto do emulador (código morto).
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
    // batching de spu.sync: em vez de chamar a cada tick (256 instruções → ~5860 chamadas/quadro com
    // n≈1 amostra, fragmentando o render), acumulamos ~8192 instruções (≈4 amostras a 44,1 kHz) antes de
    // sincronizar. Os this.sync() DENTRO de write() de registradores continuam intactos — escritas do jogo
    // continuam aplicadas no tempo certo. Derruba ~5860 chamadas para ~183 por quadro.
    this._audioAcc += cycles;
    if (this._audioAcc >= 8192) { this._audioAcc = 0; if (this.spuChip) this.spuChip.sync(); }
    const B = this.beat;
    if (B.en && B.base * B.cnt > 0) { B.acc += cycles; const per = B.base * B.cnt * 14.208 * this.frameLen / 16667; if (B.acc >= per) { B.acc -= per; B.sts = 1; } }
    this.setSrc(1, B.en && B.sts);                  // SPU Beat IRQ
    const I = this.i2c;
    if (I.busy > 0 && (I.busy -= cycles) <= 0) {            // conclui: ACK do escravo e flag de IRQ
      I.busy = 0; if (I.cr & 0x40) I.rdata = this.i2cSlaveRead(I.addr); I.cr |= (I.start & 1 ? 0x08 : 0) | (I.start & 2 ? 0x10 : 0) | (I.start & 4 ? 0x20 : 0); I.intr |= 1;
    }
    this.setSrc(24, (I.intr & 3) === 3);          // I2C master
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
  // --- INTC 0x880A0000 ---
  intcRead(off) {
    const p = this.pendingList(); let lo = 0, hi = 0;
    for (const n of p) { if (n < 32) lo |= 1 << n; else hi |= 1 << (n - 32); }
    switch (off) { case 0x00: return lo >>> 0; case 0x04: return hi; case 0x20: return this.mask[0]; case 0x24: return this.mask[1]; }
    return 0;
  }
  intcWrite(off, v) { if (off === 0x20) this.mask[0] = v >>> 0; else if (off === 0x24) this.mask[1] = v >>> 0; }
  // --- PPU 0x88010000 ---
  ppuRead(off) {
    if (off === 0x80) return this.ppuCtrl; if (off === 0x84) return this.ppuStatus;
    if (off === 0x94) {
      const vpos = Math.floor(this.frameCycles * this.rasterLines / this.frameLen), line = (this.vblankLines + vpos % this.rasterLines) >>> 0;
      // Espera de linha (como sched_io_steady do Flick): ao ler o contador, avança o relógio até a próxima linha. O valor não muda antes disso,
      // então a CPU não precisa girar o laço. Só em leituras da CPU (não no tick).
      if (this.spinRaster && this.cpu) { const lineCycles = this.frameLen / this.rasterLines; this.pendingLineSkip = Math.ceil(lineCycles - (this.frameCycles % lineCycles)); }
      return line;
    }
    return this.ppu.get(off) ?? 0;
  }
  ppuWrite(off, v) {
    if (off === 0x80) { this.ppuCtrl = v & 7; return; }
    if (off === 0x84) { this.ppuStatus &= ~v; return; }      // write-1-clear
    this.ppu.set(off, v);
  }
  // --- Timers 0x88160000 + n*0x1000 ---
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
  // --- I2C master 0x88130020.. : transação instantânea com ACK; flag de IRQ em INTR[0], enable em INTR[1] ---
  i2cRead(off) {
    const I = this.i2c;
    switch (off) { case 0x20: return I.cr; case 0x24: return I.intr; case 0x28: return I.cvr; case 0x2c: return I.id; case 0x30: return I.addr; case 0x34: return I.wdata; case 0x38: return I.rdata; }
    return 0;
  }
  i2cWrite(off, v) {
    const I = this.i2c;
    switch (off) {
      case 0x20: {
        I.cr = v & ~0x38 & ~0x7;                            // START* se autolimpam; ACK* só sobem ao concluir
        if (v & 7) { I.start = v & 7; I.busy = 2000; }       // transação leva ~2000 instruções
        break;
      }
      case 0x24: I.intr = (v & 2) | ((I.intr & 1) & v); break;       // flag só limpa quando escrito 0
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