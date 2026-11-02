// SPU do SPG290 — integrado a partir do Flick 0.1.3 (src/spu.c) e do MAME spg2xx_audio.cpp.
// Modelo (ver docs/audio-research.md):
//  - Síntese no tempo EMULADO: sync() renderiza até o instante atual (instruções emuladas), como stream_update() do Flick.
//    O áudio nunca depende do relógio de parede do navegador.
//  - 24 canais: PCM 8/16 bits, IMA ADPCM, ADPCM36, loop (tone 2), tom por software (tone 0, WAVE_DATA escrito pela CPU).
//    Taxa = phase * 281250 / 2^19 Hz. Fim de onda para o canal, ChEn limpo, flag de parada e FIQ (se habilitada).
//  - DAC FIFO de DMA (0x1080 endereço, 0x1084 ignorado, 0x1088 controle/IRQ, 0x1064 relógio): buffer ping-pong de
//    1024 bytes << n, IRQ (FIQ) a cada metade. Relógio do DAC = 54 MHz (homebrew, medido com hardware).
//  - Mistura: voz = last * vol * EDD / 127² com pan (Flick); VOLSEL (Flick); volume principal; FIFO somado.
//  - Envelope automático (MAME audio_envelope_tick) quando ENV_MODE tem o bit do canal em 0 (o Flick não tem).
//  - Interpolação linear entre amostras quando CONTROL.NOINT (bit 9) = 0 (MAME).
export const AUDIO_RATE = 44100, WAVE_BASE = 0xa0800000;
const DAC_CLOCK = 54000000;                       // homebrew: 54 MHz (o Flick usa 27 MHz; ver pesquisa)
const CPU_IPS_DEFAULT = 1500000 * 59.94;          // instruções emuladas por segundo (quadro de 1,5 M a 59,94 Hz)
const MAME_FRAME_HZ = 70312.5;                    // relógio do envelope/avanço no MAME
const ENV_CLK_FRAMES = [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 8192, 8192, 8192, 8192];
const VOLSEL = [1 / 32, 1 / 8, 1 / 2, 1];         // Flick (MAME: 1/16, 1/4, 1)
const RING = 32768;                               // quadros do anel do FIFO
// [FIX 3] incremento de fase em Q16 por unidade de phase, pré-calculado em double (sem overflow do produto intermediário)
const WAVE_INC = 281250 * 65536 / (524288 * AUDIO_RATE);
const IMA_STEPS = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
const clamp16 = v => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

export class SPU {
  constructor(io, bus) {
    this.io = io; this.bus = bus;
    this.regs = io.spu;                           // mesmo mapa de registradores que o IO (leitura = último valor escrito)
    this.ch = Array.from({ length: 24 }, () => ({
      active: false, waddr: 0, loop: 0, tone: 0, kind: 'pcm8', phaseAcc: 0, wp: 0, bp: 0, shift: 0, nib: 0,
      sig: 0, stepIdx: 0, hdr: 0, rem: 0, p0: 0, last: 0, prev: 0, acc: 0,
      envClk: 4, envAddr: 0, envAcc: 0, started: -1, samples: 0,
    }));
    this.ring = new Float32Array(AUDIO_RATE * 2 * 2); this.rd = 0; this.wr = 0; this.count = 0;   // saída para a placa (2 s)
    this.pos = 0; this.underruns = 0;
    this.underrunRuns = 0;                        // [FIX 7] número de "eventos" de underrun (transições silêncio→starve)
    this._underrunActive = false;                 // [FIX 7] estado interno do detector de transição
    this.done = 0;                                // amostras de saída já sintetizadas (tempo emulado)
    this.mameAcc = 0; this.frameAcc = 0;
    this.xl = this.xr = this.yl = this.yr = 0;    // acoplamento AC
    // FIFO de DAC
    this.fifo = new Int16Array(RING * 2); this.fHead = 0; this.fTail = 0; this.fFrac = 0;
    this.dmaOn = false; this.dmaHalf = 0; this.dmaLeft = 0; this.dacStereo = false; this.halfFrames = 0; this.dacRate = 0;
    this.waveIn = [0, 0];
    this.peak = 0; this.samplesOut = 0; this.starts = 0; this.muted = false;
    // valores de reset do MAME
    if (this.regs.get(0x1054) === undefined) this.regs.set(0x1054, 0x3f);   // ENV_MODE: bit=manual
    if (this.regs.get(0x1050) === undefined) this.regs.set(0x1050, 0x3f);   // REPEAT
    if (this.regs.get(0x1004) === undefined) this.regs.set(0x1004, 0x7f);   // volume principal
  }
  reg(o) { return this.regs.get(o) ?? 0; }
  attrBase(ch) { return (ch < 16 ? 0x000 : 0x400) + (ch & 15) * 0x40; }
  phaseBase(ch) { return (ch < 16 ? 0x800 : 0xc00) + (ch & 15) * 0x40; }
  // [FIX 6] >>> 0 mantém uint32 coerente com o resto do arquivo (evita valor negativo se bit31 do segundo word subir)
  fiqEnable() { return (this.reg(0x1008) | (this.reg(0x1408) << 16)) >>> 0; }

  // ---- registradores (chamados pelo IO) ----
  read(off) {
    if (off === 0x103c) return this.busyBits() & 0xffff;
    if (off === 0x143c) return this.busyBits() >>> 16;
    return this.regs.get(off) ?? 0;
  }
  busyBits() { let b = 0; for (let c = 0; c < 24; c++) if (this.ch[c].active) b |= 1 << c; return b >>> 0; }
  write(off, v) {
    v >>>= 0;
    if (off === 0x1000 || off === 0x1400) {                    // ChEn: borda de subida inicia, descida para
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
    if (off === 0x102c || off === 0x142c) {                    // flags de parada: escrever 1 limpa
      this.sync();
      const cur = this.reg(off);
      this.regs.set(off, (cur & ~(v & 0xffff)) >>> 0);
      this.updateIrq(); return;
    }
    if (off === 0x1004) { this.sync(); this.regs.set(off, v & 0x7f); return; }
    if (off === 0x1034) { this.sync(); this.regs.set(off, v & 0xffff); return; }
    if (off === 0x1040) { this.sync(); this.waveIn[0] = (v << 16) >> 16; this.regs.set(off, v & 0xffff); return; }
    if (off === 0x1044) { this.sync(); this.waveIn[1] = (v << 16) >> 16; this.regs.set(off, v & 0xffff); return; }
    if (off === 0x1064) {                                       // relógio de amostra do DAC
      this.sync(); this.regs.set(off, v & 0xffff);
      this.configDac();
      if ((this.reg(0x1088) & 0x4000) && !this.dmaOn) this.startDma();
      return;
    }
    if (off === 0x1080) { this.sync(); this.regs.set(off, v >>> 0); return; }   // endereço base do FIFO (32 bits)
    if (off === 0x1084) { this.regs.set(off, v & 0xffff); return; }
    if (off === 0x1088) {                                       // controle do DAC / status de IRQ
      this.sync();
      const was = this.reg(off), pend = (was & 0x8000) && !(v & 0x8000);      // escrever 1 em bit 15 = reconhece o IRQ
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
  // [FIX 2] Pré-enche as DUAS metades antes de liberar playback. Antes, fetchHalf(0) com fHead=halfFrames
  // gravava em [halfFrames..2*halfFrames) e fTail=0 lia [0..halfFrames) vazio -> primeiros halfFrames
  // samples silenciosos. Agora fHead começa em 0, as duas metades são buscadas da memória do guest e o
  // playhead já começa em dado válido. A IRQ de metade continua saindo no ritmo de dmaLeft.
  startDma() {
    this.configDac();
    if (!this.dacRate || !this.halfFrames) return;
    this.dmaOn = true; this.dmaHalf = 0; this.fHead = 0; this.fTail = 0; this.fFrac = 0;
    this.fetchHalf(0);
    this.fetchHalf(1);
    this.dmaLeft = this.halfFrames * AUDIO_RATE / this.dacRate;    // amostras de saída até a próxima metade
  }
  stopDma() { this.dmaOn = false; }
  // lê uma metade do buffer do FIFO (palavras sem sinal, XOR 0x8000) para o anel do DAC
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
  // IRQ de FIQ (fonte 0): pendente no FIFO (bit 15) ou parada de canal com a FIQ habilitada
  updateIrq() {
    const pend = (this.reg(0x1088) & 0x8000) !== 0 || ((this.reg(0x102c) | (this.reg(0x142c) << 16)) & this.fiqEnable()) !== 0;
    this.io.setSrc(0, pend);
  }

  // ---- canais ----
  startChannel(c) {
    const a = this.attrBase(c), C = this.ch[c];
    const mode = this.reg(a + 4), sel = this.reg(a + 0x34);
    C.waddr = ((mode & 0x3f) << 16 | this.reg(a)) >>> 0;
    C.loop = ((((mode >>> 6) & 0x3f) << 16) | this.reg(a + 8)) >>> 0;
    C.tone = (mode >>> 12) & 3;
    C.kind = (mode >>> 15) & 1 ? ((sel >>> 15) & 1 ? 'a36' : 'ima') : ((mode >>> 14) & 1 ? 'pcm16' : 'pcm8');
    // Flick: reinicia sempre que a borda de ChEn chega (o hardware reinicia; a retomada por endereço era um remendo)
    C.wp = C.waddr; C.bp = C.waddr * 2; C.shift = 0; C.nib = 0; C.sig = 0; C.stepIdx = 0; C.hdr = 0; C.rem = 0; C.p0 = 0;
    C.last = 0; C.prev = 0; C.acc = 0; C.phaseAcc = 0; C.samples = 0; C.active = true; C.started = C.waddr;
    C.envAddr = (((this.reg(a + 0x1c) & 0x3f) << 16) | this.reg(a + 0x20)) >>> 0;
    this.regs.set(a + 0x14, ((this.reg(a + 0x14) & 0x00ff) | ((this.reg(a + 0x18) & 0xff) << 8)) >>> 0);   // contagem = carga
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
  // avança o decodificador do canal uma amostra de onda. Retorna false no fim da onda.
  fetch(c) {
    const C = this.ch[c], bus = this.bus;
    if (C.kind === 'a36' && C.rem === 0 && C.tone !== 0) { C.hdr = this.wordAt(C.wp); C.rem = 8; C.wp++; }
    const w = C.tone === 0 ? (this.reg(this.attrBase(c) + 0x2c) & 0xffff) : this.wordAt(C.wp);
    // [FIX 4] marcador de fim (word 0xFFFF): só para PCM16 (qualquer word) e IMA/ADPCM36 (nibble 0).
    // Em PCM8 o pointer é byte (C.bp) e wp não avança, então esse check lia sempre o primeiro word e podia
    // encerrar o canal cedo se o dado inicial fosse 0xFF 0xFF. O byte-check 0xFF abaixo já cobre PCM8.
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
  // [FIX 1] Loop tone 2: reset do decoder INTEIRO. Antes só wp/bp/nib/shift/rem voltavam; sig+stepIdx (IMA)
  // e hdr+p0 (ADPCM36) carregavam estado da iteração anterior -> click e decodificação errada no 2º giro.
  // O envelope automático NÃO é reancorado (MAME audio_envelope_tick é independente do loop do canal).
  endOrLoop(c) {
    const C = this.ch[c];
    if (C.tone === 2) {
      C.wp = C.loop; C.bp = C.loop * 2;
      C.nib = 0; C.shift = 0; C.rem = 0;
      C.sig = 0; C.stepIdx = 0;   // estado IMA
      C.hdr = 0; C.p0 = 0;        // estado ADPCM36
      return true;
    }
    return false;                                 // one-shot / fim
  }
  // envelope automático (MAME audio_envelope_tick)
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

  // ---- síntese ----
  // [FIX 5] sync() derivado do frame emulado: usa io.frameLen para sobreviver a mudanças de fastBoot/clock.
  // CPU_IPS fixo funcionava só com frameLen=1.5e6; se alguém mudar io.frameLen, a taxa de áudio desalinha
  // do vídeo. Deriving: ips = (frameLen || 1.5e6) * 59.94.
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
      // envelope automático (relógio do MAME, 70312,5 Hz)
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
      // FIFO do DAC
      if (fifoOn) {
        let pos = this.fTail + (this.fFrac >>> 16);
        if (pos >= this.fHead) pos = this.fHead ? this.fHead - 1 : 0;
        const slot = (pos % RING) * 2;
        dacL = this.fifo[slot]; dacR = this.fifo[slot + 1];
        this.fFrac += fStep;
      } else { mixL += this.waveIn[0]; mixR += this.waveIn[1]; }
      // canais
      for (let c = 0; c < 24; c++) {
        const C = this.ch[c]; if (!C.active) continue;
        const a = this.attrBase(c), phase = this.reg(this.phaseBase(c)) & 0x7ffff;
        if (!phase) continue;
        // [FIX 3] acumulador em Q16 sem Math.floor. Antes `Math.floor(...)` era chamado a cada sample e a
        // fração descartada acumulava → drift de pitch lento. Agora o incremento é float (double, ~53 bits)
        // e o resto fracionário persiste em phaseAcc entre samples.
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
        const v = Math.trunc(sm * vol * edd / (127 * 127));                  // Flick: s = last * ch_volume * edd / 127²
        let pl, pr;
        if (pan < 64) { pl = 127; pr = pan * 2; } else { pl = (127 - pan) * 2; pr = 127; }
        mixL += (v * pl) >> 7; mixR += (v * pr) >> 7;
      }
      // FIFO: avanço do DMA (uma metade por halfFrames/dacRate segundos)
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
      // saída: Flick (master, VOLSEL, clipping)
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
  // ---- saída para a placa (sem relógio de parede) ----
  // [FIX 7] Sem amostra suficiente, repete a última amostra e a faz decair (~3 ms) — anti-click, não
  // correção de timing. Contadores: `underruns` (samples em underrun) e `underrunRuns` (eventos/transições).
  pull(n, ratio = 1) {
    const out = new Float32Array(n * 2), cap = this.ring.length;
    if (this.holdL === undefined) { this.holdL = 0; this.holdR = 0; }
    for (let i = 0; i < n; i++) {
      if (this.count < 4) {
        if (!this._underrunActive) { this._underrunActive = true; this.underrunRuns++; }
        this.underruns++;
        this.holdL *= 0.9965; this.holdR *= 0.9965;                 // decai ~3 ms até o silêncio
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