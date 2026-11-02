// CPU S+core7 (Sunplus SPG290) — interpretador baseado na tabela oficial do binutils (score7-dis.c)
// e nas estruturas de instrução do hyperscan-emulator (LiraNuna).
// Halfwords little-endian: 32 bits se bit15 das DUAS halves = 1; payload P = hi15<<15 | lo15.
import { buildBlock, compileBlock } from './jit.js';
export class UnknownOp extends Error {}
const sx = (v, b) => (v << (32 - b)) >> (32 - b);

export class SCore7 {
  constructor(bus) {
    this.bus = bus;
    this.r = new Int32Array(32);
    this.cr = new Uint32Array(32);
    this.sr = new Uint32Array(32);          // sr0=CNT sr1=LCR sr2=SCR
    this.cel = 0; this.ceh = 0;
    this.N = this.Z = this.C = this.V = this.T = 0;
    this.pc = 0; this.cycles = 0; this.sleeping = false;
    // Cache de instruções decodificadas (ver decodeCached32/16): uma função especializada por instrução, validada pela palavra de memória.
    // RAM 0..4 MiB (segmentos 0x80/0xa0) e BIOS (0x9e/0x9f). Entradas: chaves de palavra (32 bits) e de meia-palavra (16 bits).
    this.useCache = true;
    this.c32W = new Uint32Array(0x140000); this.c32F = new Array(0x140000).fill(undefined);
    this.c16W = new Uint16Array(0x280000); this.c16F = new Array(0x280000).fill(undefined);
    // JIT de blocos básicos (jit.js): bState 0 = não traduzido, 1 = bloco pronto, 2 = não vale a pena; chave = índice de meia-palavra (mesmo espaço de c16)
    this.useJit = true; this.jn = 0; this.jx = 0;
    this.bState = new Uint8Array(0x280000); this.bLen = new Uint8Array(0x280000); this.bF = new Array(0x280000).fill(undefined);
    this.pageBlocks = new Array(0x500).fill(null);                 // páginas de 4 KiB: RAM 0..1023, BIOS 1024..1279
    this.codeWords = this.bus.codeWords; this.bus.onCodeWrite = (o) => this.onCodeWrite(o);
    this.cs = 0; this.irqSrc = -1;          // cs = bits S do registrador de condição (Vs..Ts); irqSrc = fonte pendente (-1 = nenhuma)
  }
  reset(pc) { this.r.fill(0); this.cr.fill(0); this.cr[29] = 0x20000000; this.pc = pc >>> 0; this.cycles = 0; this.N = this.Z = this.C = this.V = this.T = 0; this.irqSrc = -1; }

  // cr1 = flags: V=bit0 C=bit1 Z=bit2 N=bit3 T=bit4
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
      case 14: { const n = this.sr[0]; if (cnt && n) this.sr[0] = n - 1; return n !== 0; }   // cnz: testa CNT != 0 e decrementa depois (loops de memcpy usam CNT = n-1)
      case 15: return true;
      default: return false;
    }
  }

  // Busca igual ao hyperscan-emulator: 32 bits só em PC alinhado a palavra e com p0=1;
  // palavra com p0=0 traz duas instruções de 16 bits (p1=1 => par "paralelo": executa low se T, senão high).
  // HLE: hooks por endereço (só em 0xa0xxxxxx). fn(cpu) retorna true se tratou (e ajustou pc), false para executar normalmente.
  addHook(addr, fn) { this.jitFlush(); if (!this.hooks) { this.hooks = new Map(); this.hookMask = new Uint8Array(1 << 23); } this.hooks.set(addr >>> 0, fn); this.hookMask[(addr & 0xffffff) >>> 1] = 1; }

  step() {
    if (this.irqSrc >= 0 && (this.cr[0] & 1)) { this.interrupt(this.irqSrc); }
    const pc = this.pc;
    if (this.hookMask !== undefined && this.hookMask[(pc & 0xffffff) >>> 1] && (pc >>> 24) === 0xa0) { const h = this.hooks.get(pc); if (h && h(this)) { this.cycles++; return; } }
    // chave do cache: RAM (<4 MiB) em [0, 0x100000) palavras / [0, 0x200000) meias; BIOS depois
    const seg = pc >>> 24; let k32 = -1;
    if (this.useCache) {
      if (seg === 0xa0 || seg === 0x80) { const o = pc & 0xffffff; if (o < 0x400000) k32 = o; }
      else if (seg === 0x9f || seg === 0x9e) k32 = 0x400000 + (pc & 0xfffff);       // byte offset; palavras = >>2, meias = >>1
    }
    if (k32 >= 0) {
      const b = this.bus;
      if (pc & 2) {
        const h = b.r16(pc) & 0x7fff, k = k32 >>> 1; let f;
        if (this.c16W[k] === h && (f = this.c16F[k]) !== undefined) { this.pc = f(); this.cycles++; return; }
        f = this.decode16(h, pc, (pc + 2) >>> 0); this.c16W[k] = h; this.c16F[k] = f; this.pc = f(); this.cycles++; return;
      }
      const w = b.r32(pc);
      if ((w >>> 15) & 1) {                                                           // p0 = 1: instrução de 32 bits
        const k = k32 >>> 2; let f;
        if (this.c32W[k] === w && (f = this.c32F[k]) !== undefined) { this.pc = f(); this.cycles++; return; }
        const P = ((((w >>> 16) & 0x7fff) << 15) | (w & 0x7fff)) >>> 0;
        f = this.decode32(P, pc, (pc + 4) >>> 0); this.c32W[k] = w; this.c32F[k] = f; this.pc = f(); this.cycles++; return;
      }
      if (!(w >>> 31)) {                                                              // p0 = 0, p1 = 0: só a meia-palavra baixa (16 bits)
        const h = w & 0x7fff, k = k32 >>> 1; let f;
        if (this.c16W[k] === h && (f = this.c16F[k]) !== undefined) { this.pc = f(); this.cycles++; return; }
        f = this.decode16(h, pc, (pc + 2) >>> 0); this.c16W[k] = h; this.c16F[k] = f; this.pc = f(); this.cycles++; return;
      }
    }
    this.stepSlow(pc);
  }

  jitFlush() { if (this.bState === undefined) return; this.bState.fill(0); this.bF.fill(undefined); this.pageBlocks.fill(null); this.codeWords.fill(0); this.jx = 0; }
  // Escrita numa palavra de código: descarta todos os blocos da página e avisa um bloco em execução (jx) para sair
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

  // Executa n instruções com o PC em variável local (evita ler/gravar this.pc e this.cycles a cada passo). Mesma semântica de step().
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
          // [FIX] stepSlow já faz this.cycles++ internamente. Antes havia um ++ duplicado aqui, inflando
          // cpu.cycles ~9 M por 20 frames e desalinhando audio/vídeo. Só conta a instrução via synced.
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
        // [FIX] mesma duplicação aqui no par "paralelo" (p1 = 1). stepSlow já incrementa; removido o ++ duplicado.
        this.pc = pc; this.cycles += done - synced; synced = done; this.stepSlow(pc); pc = this.pc; done++; synced++;
      }
    } catch (e) { this.pc = pc; this.cycles += done - synced; this.jn = 0; this.jx = 0; throw e; }
    this.pc = pc; this.cycles += done - synced;
  }

  // Caminho original (sem cache): endereços fora da RAM/BIOS e o par de 16 bits "paralelo" (executa low se T, senão high)
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

  // ---- decodificação especializada (32 bits): retorna f() que executa e devolve o próximo PC. O que não é especializado cai em exec32. ----
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

  // ---- decodificação especializada (16 bits) ----
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

  mem(kind, rD, addr) { // 0 lw 1 lh 2 lhu 3 lb 4 sw 5 sh 6 lbu 7 sb
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

  // ---------------- 32 bits ----------------
  exec32(pc, P, next) {
    const r = this.r, op = P >>> 25, rD = (P >>> 20) & 31, rA = (P >>> 15) & 31, rB = (P >>> 10) & 31, cu = P & 1;
    switch (op) {
      case 0: {
        const f = P & 0x3ff, a = r[rA], bb = r[rB], cc = (P >>> 10) & 15;
        switch (f) {
          case 0x000: break;
          case 0x002: case 0x006: break;                                        // syscall/sdbbp (ignorado)
          case 0x004: break;                                                    // trap{cond} (ignorado)
          case 0x008: case 0x009: if (this.cond(cc, true)) { if (f & 1) r[3] = next; next = a >>> 0; } break;   // br{cond}[l] rA
          case 0x00a: break;                                                    // pflush
          case 0x00c: r[rD] = this.bus.r32(a >>> 0); break;                     // alw
          case 0x00e: this.bus.w32(a >>> 0, r[rD]); break;                      // asw
          case 0x010: case 0x011: r[rD] = this.add(a, bb, f & 1); break;
          case 0x012: case 0x013: r[rD] = this.add(a, bb, f & 1, this.C); break;
          case 0x014: case 0x015: r[rD] = this.sub(a, bb, f & 1); break;
          case 0x016: case 0x017: r[rD] = this.sub(a, bb, f & 1, this.C); break;
          case 0x018: case 0x019: {                                             // cmp{teq,tmi}.c — rD[1:0] seleciona T
            this.sub(a, bb, 1); const t = rD & 3;
            if (t === 0) this.T = a === bb ? 1 : 0; else if (t === 1) this.T = this.N; break;
          }
          case 0x01a: case 0x01b: { this.sub(a, 0, 1); const t = rD & 3; if (t === 0) this.T = a === 0 ? 1 : 0; else if (t === 1) this.T = this.N; break; }
          case 0x01e: case 0x01f: r[rD] = this.sub(0, bb, f & 1); break;        // neg rD,rB
          case 0x020: case 0x021: r[rD] = this.logic(a & bb, f & 1); break;
          case 0x022: case 0x023: r[rD] = this.logic(a | bb, f & 1); break;
          case 0x024: case 0x025: r[rD] = this.logic(~a, f & 1); break;
          case 0x026: case 0x027: r[rD] = this.logic(a ^ bb, f & 1); break;
          case 0x029: r[rD] = this.logic(a & ~(1 << rB), 1); break;             // bitclr.c
          case 0x02b: r[rD] = this.logic(a | (1 << rB), 1); break;              // bitset.c
          case 0x02d: { const t = a & (1 << rB); this.Z = t ? 0 : 1; this.N = t >>> 31; break; }     // bittst.c [?semântica de flag]
          case 0x02f: r[rD] = this.logic(a ^ (1 << rB), 1); break;              // bittgl.c
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
          case 0x050: r[rD] = this.sr[rB]; break;                                // mfsr
          case 0x052: this.sr[rB] = a; break;                                    // mtsr
          case 0x054: this.T = this.cond(cc) ? 1 : 0; break;                    // t{cond}
          case 0x056: if (this.cond(cc)) r[rD] = a; break;                      // mv{cond}
          case 0x058: case 0x059: r[rD] = this.logic((a << 24) >> 24, f & 1); break;   // extsb
          case 0x05a: case 0x05b: r[rD] = this.logic((a << 16) >> 16, f & 1); break;   // extsh
          case 0x05c: case 0x05d: r[rD] = this.logic(a & 0xff, f & 1); break;          // extzb
          case 0x05e: case 0x05f: r[rD] = this.logic(a & 0xffff, f & 1); break;        // extzh
          case 0x070: case 0x071: r[rD] = this.logic(a << rB, f & 1); break;     // slli
          case 0x074: case 0x075: r[rD] = this.logic(a >>> rB, f & 1); break;    // srli
          case 0x076: case 0x077: r[rD] = this.logic(a >> rB, f & 1); break;     // srai
          case 0x078: case 0x079: r[rD] = this.logic((a >>> rB) | (a << (32 - rB)), f & 1); break;   // rori
          case 0x07c: case 0x07d: r[rD] = this.logic((a << rB) | (a >>> (32 - rB)), f & 1); break;   // roli
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
      case 2: if (cu) r[3] = next; next = ((pc & 0xfe000000) | (P & 0x01fffffe)) >>> 0; break;       // j/jl absoluto no segmento
      case 4: if (this.cond(cc4(P), true)) { if (cu) r[3] = next; next = (pc + sx((((P >>> 15) & 0x3ff) << 10) | (P & 0x3fe), 20)) >>> 0; } break;
      case 8: r[rD] = this.add(r[rA], sx((P >>> 1) & 0x3fff, 14), cu); break;                       // addri
      case 12: r[rD] = this.logic(r[rA] & ((P >>> 1) & 0x3fff), cu); break;                         // andri
      case 13: r[rD] = this.logic(r[rA] | ((P >>> 1) & 0x3fff), cu); break;                         // orri
      case 16: case 17: case 18: case 19: case 20: case 21: case 22: case 23:
        this.mem(op & 7, rD, (r[rA] + sx(P & 0x7fff, 15)) >>> 0); break;
      case 3: case 7: {                                                                              // [rA,imm12]+ (pré) / [rA]+,imm12 (pós)
        const imm = sx((P >>> 3) & 0xfff, 12), k = P & 7;
        if (op === 3) { const a = (r[rA] + imm) | 0; r[rA] = a; this.mem(k, rD, a >>> 0); }
        else { const a = r[rA] >>> 0; this.mem(k, rD, a); r[rA] = (a + imm) | 0; }
        break;
      }
      case 6: {                                                                                      // cr / cop / rte
        const f5 = P & 0x1f;
        if (f5 === 0) this.setCR(rA, r[rD]); else if (f5 === 1) r[rD] = this.getCR(rA) | 0;
        else if ((P & 0x3ff) === 0x0c4) { /* sleep: segue como nop, o IRQ acorda */ }
        else if ((P & 0x3ff) === 0x084 || (P & 0x3ff) === 0x0a4) next = this.rte() >>> 0;
        else throw new UnknownOp(`op6 P=${P.toString(16)} @${pc.toString(16)}`);
        break;
      }
      case 24: break;                                                                                // cache
      default: throw new UnknownOp(`op32=${op} @${pc.toString(16)} P=${P.toString(16)}`);
    }
    return next;
  }
  // Exceção: salva PSR/condição (c -> s), IEc=0, ECR[23:18]=causa, EPC(cr5)=pc, pc = cr3 + causa*4  (igual ao repositório de referência)
  exception(code) {
    const f = this.getCR(1);
    this.cr[1] = (f & 0x1f) << 5;                         // s := c (guarda só os bits s)
    const psr = this.cr[0];
    this.cr[0] = (psr & ~0xf) | ((psr & 1) << 2) | ((psr & 2) << 2);   // IEs=IEc, UMs=UMc ; IEc=0, UMc=0
    this.cr[2] = ((this.cr[2] & ~0x00fc0000) | ((code & 0x3f) << 18)) >>> 0;
    this.cr[5] = this.pc;
    this.pc = (this.cr[3] + code * 4) >>> 0;
    this.sleeping = false;
  }
  interrupt(src) {                                         // src = número da fonte no INTC (0..39)
    if (!(this.cr[0] & 1)) return false;
    this.exception((63 - src) + 128);
    return true;
  }
  rte() {
    const psr = this.cr[0];
    this.cr[0] = (psr & ~0x3) | ((psr >> 2) & 1) | (((psr >> 3) & 1) << 1);   // IEc=IEs, UMc=UMs
    const f = this.cr[1];
    const c = (f >> 5) & 0x1f;
    this.V = c & 1; this.C = (c >> 1) & 1; this.Z = (c >> 2) & 1; this.N = (c >> 3) & 1; this.T = (c >> 4) & 1;
    return this.cr[5];
  }

  // ---------------- 16 bits ----------------
  exec16(pc, h, next) {
    const r = this.r, b = this.bus, op = (h >>> 12) & 7, rd = (h >>> 8) & 15, ra = (h >>> 4) & 15, fn = h & 15;
    switch (op) {
      case 0: switch (fn) {
        case 0: break;
        case 1: r[rd] = r[16 + (ra & 15)]; break;                                    // mlfh!
        case 2: r[16 + rd] = r[ra]; break;                                           // mhfl!
        case 3: r[rd] = r[ra]; break;                                                // mv!
        case 4: if (this.cond(rd, true)) next = r[ra] >>> 0; break;                        // br{cond}!
        case 5: this.T = this.cond(rd) ? 1 : 0; break;                               // t{cond}!
        case 8: r[rd] = this.logic(r[rd] << (r[ra] & 31), 1); break;                 // sll!
        case 9: r[rd] = this.add(r[rd], r[ra], 1, this.C); break;                    // addc!
        case 10: r[rd] = this.logic(r[rd] >>> (r[ra] & 31), 1); break;               // srl!
        case 11: r[rd] = this.logic(r[rd] >> (r[ra] & 31), 1); break;                // sra!
        case 12: if (this.cond(rd, true)) { r[3] = next; next = r[ra] >>> 0; } break;      // brl{cond}!
        default: throw new UnknownOp(`op16/0 fn=${fn} h=${h.toString(16)} @${pc.toString(16)}`);
      } break;
      case 1: switch (h & 0xf0f) {
        case 0x000: this.cel = r[ra]; break;  case 0x001: r[ra] = this.cel; break;   // mtcel!/mfcel!
        case 0x100: this.ceh = r[ra]; break;  case 0x101: r[ra] = this.ceh; break;   // mtceh!/mfceh!
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
          case 3: this.sub(r[rd], r[ra], 1); break;                                  // cmp!
          case 4: r[rd] = this.logic(r[rd] & r[ra], 1); break;
          case 5: r[rd] = this.logic(r[rd] | r[ra], 1); break;
          case 6: r[rd] = this.logic(~r[ra], 1); break;
          case 7: r[rd] = this.logic(r[rd] ^ r[ra], 1); break;
          case 8: r[rd] = b.r32(a); break;
          case 9: r[rd] = (b.r16(a) << 16) >> 16; break;                             // lh!
          case 11: r[rd] = b.r8(a); break;                                           // lbu!
          case 12: b.w32(a, r[rd]); break;
          case 13: b.w16(a, r[rd]); break;                                           // sh!
          case 15: b.w8(a, r[rd]); break;                                            // sb!
          case 10: case 14: {                                                        // pop!/push! (bit7 = reg alto)
            const hi = (h & 0x80) !== 0, d = hi ? 16 + rd : rd, base = hi ? (ra & 7) : ra;
            if (fn === 14) { r[base] = (r[base] - 4) | 0; b.w32(r[base] >>> 0, r[d]); }
            else { r[d] = b.r32(r[base] >>> 0); r[base] = (r[base] + 4) | 0; }
            break;
          }
        }
        break;
      }
      case 3: if (h & 1) r[3] = next; next = ((pc & 0xfffff000) | (h & 0xffe)) >>> 0; break;       // j!/jl!
      case 4: if (this.cond(rd, true)) next = (pc + sx(h & 0xff, 8) * 2) >>> 0; break;                  // b{cond}!
      case 5: r[rd] = h & 0xff; break;                                                            // ldiu!
      case 6: {
        const f3 = h & 7, i5 = (h >>> 3) & 31;
        if ((h & 0x7) === 0) { const i4 = (h >>> 3) & 15; r[rd] = (h & 0x80) ? this.sub(r[rd], i4, 1) : this.add(r[rd], i4, 1); }   // addei!/subei!
        else if (f3 === 1) r[rd] = this.logic(r[rd] << i5, 1);
        else if (f3 === 3) r[rd] = this.logic(r[rd] >>> i5, 1);
        else if (f3 === 4) r[rd] = this.logic(r[rd] & ~(1 << i5), 1);
        else if (f3 === 5) r[rd] = this.logic(r[rd] | (1 << i5), 1);
        else if (f3 === 6) { const t = r[rd] & (1 << i5); this.Z = t ? 0 : 1; this.N = t >>> 31; }              // bittst!
        else if (f3 === 7) r[rd] = this.logic(r[rd] ^ (1 << i5), 1);
        else throw new UnknownOp(`op16/6 h=${h.toString(16)} @${pc.toString(16)}`);
        break;
      }
      case 7: {                                                                                   // lwp!/swp!... base r2 [?]
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