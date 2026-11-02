// JIT de blocos básicos do S+core7: traduz sequências de instruções em funções JavaScript geradas em tempo de execução.
// Mantém exatamente a semântica do interpretador (src/cpu.js): o bloco só roda inteiro se couber no orçamento do pedaço; após qualquer escrita (ou instrução
// genérica) o código confere se uma interrupção ficou habilitada/pendente ou se o código foi alterado e, se sim, sai cedo com `cpu.jn` = instruções executadas.
// Blocos terminam em desvios/saltos, antes de endereços com hook, em limite de página de 4 KiB, antes de um par de 16 bits "paralelo" ou no tamanho máximo.
// [PERF] MAXLEN 48 → 128: blocos maiores reduzem a transição pc→bloco→pc. Trade-off: invalidação de página 4 KiB re-executa mais instruções.
// Se o jogo for muito self-modifying, reduza para 96 ou 48.
const MAXLEN = 128;
const sx = (v, b) => (v << (32 - b)) >> (32 - b);
const U = (n) => (n >>> 0);

export function buildBlock(cpu, startPc) {
  const bus = cpu.bus, hm = cpu.hookMask;
  const out = []; let pc = startPc >>> 0, k = 0, term = false;
  while (k < MAXLEN) {
    if (k > 0) {
      if ((pc & 0xfff) === 0) break;                                                    // limite de página
      if (hm !== undefined && hm[(pc & 0xffffff) >>> 1] && (pc >>> 24) === 0xa0) break; // endereço com hook: o despachante cuida
    }
    let size, e;
    if (pc & 2) { size = 2; e = emit16(cpu, bus.r16(pc) & 0x7fff, pc, k); }
    else {
      const w = bus.r32(pc);
      if ((w >>> 15) & 1) { size = 4; e = emit32(cpu, ((((w >>> 16) & 0x7fff) << 15) | (w & 0x7fff)) >>> 0, pc, k); }
      else if (!(w >>> 31)) { size = 2; e = emit16(cpu, w & 0x7fff, pc, k); }
      else break;                                                                       // par de 16 bits "paralelo": fora do JIT
    }
    out.push(e.code); k++; pc = (pc + size) >>> 0;
    if (e.term) { term = true; break; }
  }
  if (k === 0) return null;
  if (!term) out.push(`return ${U(pc)};`);
  return { src: 'return function(){\n' + out.join('\n') + '\n};', len: k, endPc: pc };
}

export function compileBlock(cpu, src) { return new Function('cpu', 'r', 'bus', 'cr', 'dv', 'ram', 'cw', src)(cpu, cpu.r, cpu.bus, cpu.cr, cpu.bus.dv, cpu.bus.ram, cpu.bus.codeWords); }

// saída antecipada após escritas / instruções genéricas: interrupção habilitada e pendente, ou código alterado
const chk = (k1, nxt) => `if (cpu.jx !== 0 || (cpu.irqSrc >= 0 && (cr[0] & 1))) { cpu.jn = ${k1}; cpu.jx = 0; return ${U(nxt)}; }`;

// Acessos à memória com RAM embutida (seg 0x80/0xa0); outros endereços (BIOS, periféricos) caem em bus.rX/wX. Escritas conferem as palavras de código (cw).
const RAM = (a) => `((${a} >>> 24) | 32) === 0xa0`;
const L32 = (aExpr, dst) => `{ const q = (${aExpr}) >>> 0; ${dst} = ${RAM('q')} ? dv.getInt32(q & 0xffffff, true) : bus.r32(q); }`;
const L16S = (aExpr, dst) => `{ const q = (${aExpr}) >>> 0; ${dst} = ${RAM('q')} ? (dv.getUint16(q & 0xffffff, true) << 16) >> 16 : (bus.r16(q) << 16) >> 16; }`;
const L16U = (aExpr, dst) => `{ const q = (${aExpr}) >>> 0; ${dst} = ${RAM('q')} ? dv.getUint16(q & 0xffffff, true) : bus.r16(q); }`;
const L8S = (aExpr, dst) => `{ const q = (${aExpr}) >>> 0; ${dst} = ${RAM('q')} ? (ram[q & 0xffffff] << 24) >> 24 : (bus.r8(q) << 24) >> 24; }`;
const L8U = (aExpr, dst) => `{ const q = (${aExpr}) >>> 0; ${dst} = ${RAM('q')} ? ram[q & 0xffffff] : bus.r8(q); }`;
const S32 = (aExpr, v) => `{ const q = (${aExpr}) >>> 0; if (${RAM('q')}) { const o = q & 0xffffff; dv.setInt32(o, ${v}, true); if (o < 0x400000 && (cw[o >>> 2] | cw[(o + 3) >>> 2]) !== 0) cpu.onCodeWrite(o); } else bus.w32(q, ${v}); }`;
const S16 = (aExpr, v) => `{ const q = (${aExpr}) >>> 0; if (${RAM('q')}) { const o = q & 0xffffff; dv.setUint16(o, ${v}, true); if (o < 0x400000 && (cw[o >>> 2] | cw[(o + 1) >>> 2]) !== 0) cpu.onCodeWrite(o); } else bus.w16(q, ${v}); }`;
const S8 = (aExpr, v) => `{ const q = (${aExpr}) >>> 0; if (${RAM('q')}) { const o = q & 0xffffff; ram[o] = ${v}; if (o < 0x400000 && cw[o >>> 2] !== 0) cpu.onCodeWrite(o); } else bus.w8(q, ${v}); }`;
const condExpr = (cc) => cc === 4 ? 'cpu.Z === 1' : cc === 5 ? 'cpu.Z === 0' : `cpu.cond(${cc}, true)`;

function emit32(cpu, P, pc, k) {
  const nxt = (pc + 4) >>> 0, nxtR = nxt | 0, op = P >>> 25, rD = (P >>> 20) & 31, rA = (P >>> 15) & 31, rB = (P >>> 10) & 31, cu = P & 1;
  const generic = { code: `{ const p = cpu.exec32(${U(pc)}, ${P}, ${nxt}); if (p !== ${nxt}) { cpu.jn = ${k + 1}; return p; } ${chk(k + 1, nxt)} }`, term: false };
  const ok = (code) => ({ code, term: false }), st = (code) => ({ code: code + ' ' + chk(k + 1, nxt), term: false });
  const link = cu ? `r[3] = ${nxtR};` : '';
  switch (op) {
    case 1: case 5: {
      const f3 = (P >>> 17) & 7, imm = (P >>> 1) & 0xffff, s = op === 5 ? (imm << 16) : ((imm << 16) >> 16), u = op === 5 ? (imm << 16) : imm;
      switch (f3) {
        case 0: return ok(cu ? `r[${rD}] = cpu.add(r[${rD}], ${s}, 1);` : `r[${rD}] = (r[${rD}] + ${s}) | 0;`);
        case 2: return ok(`cpu.sub(r[${rD}], ${s}, 1);`);
        case 4: return ok(cu ? `r[${rD}] = cpu.logic(r[${rD}] & ${u}, 1);` : `r[${rD}] = r[${rD}] & ${u};`);
        case 5: return ok(cu ? `r[${rD}] = cpu.logic(r[${rD}] | ${u}, 1);` : `r[${rD}] = r[${rD}] | ${u};`);
        case 6: return ok(cu ? `r[${rD}] = cpu.logic(${s}, 1);` : `r[${rD}] = ${s};`);
        default: return generic;
      }
    }
    case 2: return { code: `{ ${link} return ${U(((pc & 0xfe000000) | (P & 0x01fffffe)) >>> 0)}; }`, term: true };
    case 4: {
      const cc = (P >>> 10) & 31, t = U(pc + sx((((P >>> 15) & 0x3ff) << 10) | (P & 0x3fe), 20));
      if (cc === 15) return { code: `{ ${link} return ${t}; }`, term: true };
      return { code: `if (${condExpr(cc)}) { ${link} return ${t}; } return ${nxt};`, term: true };
    }
    case 8: { const imm = sx((P >>> 1) & 0x3fff, 14); return ok(cu ? `r[${rD}] = cpu.add(r[${rA}], ${imm}, 1);` : `r[${rD}] = (r[${rA}] + ${imm}) | 0;`); }
    case 12: { const imm = (P >>> 1) & 0x3fff; return ok(cu ? `r[${rD}] = cpu.logic(r[${rA}] & ${imm}, 1);` : `r[${rD}] = r[${rA}] & ${imm};`); }
    case 13: { const imm = (P >>> 1) & 0x3fff; return ok(cu ? `r[${rD}] = cpu.logic(r[${rA}] | ${imm}, 1);` : `r[${rD}] = r[${rA}] | ${imm};`); }
    case 16: { const off = sx(P & 0x7fff, 15); return ok(L32(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 17: { const off = sx(P & 0x7fff, 15); return ok(L16S(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 18: { const off = sx(P & 0x7fff, 15); return ok(L16U(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 19: { const off = sx(P & 0x7fff, 15); return ok(L8S(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 20: { const off = sx(P & 0x7fff, 15); return st(S32(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 21: { const off = sx(P & 0x7fff, 15); return st(S16(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 22: { const off = sx(P & 0x7fff, 15); return ok(L8U(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 23: { const off = sx(P & 0x7fff, 15); return st(S8(`r[${rA}] + ${off}`, `r[${rD}]`)); }
    case 3: case 7: {
      const imm = sx((P >>> 3) & 0xfff, 12), kk = P & 7;
      if (op === 3) {
        const pre = `{ const a = (r[${rA}] + ${imm}) | 0; r[${rA}] = a; `;
        if (kk === 4) return st(`${pre}${S32('a', `r[${rD}]`)} }`);
        if (kk === 0) return ok(`${pre}${L32('a', `r[${rD}]`)} }`);
        return kk >= 4 ? st(`${pre}cpu.mem(${kk}, ${rD}, a >>> 0); }`) : ok(`${pre}cpu.mem(${kk}, ${rD}, a >>> 0); }`);
      }
      const pre = `{ const a = r[${rA}] >>> 0; `;
      if (kk === 0) return ok(`${pre}${L32('a', `r[${rD}]`)} r[${rA}] = (a + ${imm}) | 0; }`);
      if (kk === 4) return st(`${pre}${S32('a', `r[${rD}]`)} r[${rA}] = (a + ${imm}) | 0; }`);
      return kk >= 4 ? st(`${pre}cpu.mem(${kk}, ${rD}, a); r[${rA}] = (a + ${imm}) | 0; }`) : ok(`${pre}cpu.mem(${kk}, ${rD}, a); r[${rA}] = (a + ${imm}) | 0; }`);
    }
    case 0: {
      const f = P & 0x3ff, cc = (P >>> 10) & 15;
      switch (f) {
        case 0x000: return ok('');
        case 0x008: case 0x009: if (cc === 15) return { code: `{ const a = r[${rA}]; ${(f & 1) ? `r[3] = ${nxtR};` : ''} return a >>> 0; }`, term: true }; return generic;
        case 0x010: return ok(`r[${rD}] = (r[${rA}] + r[${rB}]) | 0;`);
        case 0x011: return ok(`r[${rD}] = cpu.add(r[${rA}], r[${rB}], 1);`);
        case 0x014: return ok(`r[${rD}] = (r[${rA}] - r[${rB}]) | 0;`);
        case 0x015: return ok(`r[${rD}] = cpu.sub(r[${rA}], r[${rB}], 1);`);
        case 0x018: case 0x019: return ok(`{ const a = r[${rA}], b = r[${rB}]; cpu.sub(a, b, 1); ${(rD & 3) === 0 ? 'cpu.T = a === b ? 1 : 0;' : (rD & 3) === 1 ? 'cpu.T = cpu.N;' : ''} }`);
        case 0x020: return ok(`r[${rD}] = r[${rA}] & r[${rB}];`);
        case 0x021: return ok(`r[${rD}] = cpu.logic(r[${rA}] & r[${rB}], 1);`);
        case 0x022: return ok(`r[${rD}] = r[${rA}] | r[${rB}];`);
        case 0x023: return ok(`r[${rD}] = cpu.logic(r[${rA}] | r[${rB}], 1);`);
        case 0x026: return ok(`r[${rD}] = r[${rA}] ^ r[${rB}];`);
        case 0x056: return cc === 15 ? ok(`r[${rD}] = r[${rA}];`) : generic;
        case 0x058: return ok(`r[${rD}] = (r[${rA}] << 24) >> 24;`);
        case 0x05a: return ok(`r[${rD}] = (r[${rA}] << 16) >> 16;`);
        case 0x05c: return ok(`r[${rD}] = r[${rA}] & 0xff;`);
        case 0x05e: return ok(`r[${rD}] = r[${rA}] & 0xffff;`);
        case 0x070: return ok(`r[${rD}] = r[${rA}] << ${rB};`);
        case 0x071: return ok(`r[${rD}] = cpu.logic(r[${rA}] << ${rB}, 1);`);
        case 0x074: return ok(`r[${rD}] = r[${rA}] >>> ${rB};`);
        case 0x075: return ok(`r[${rD}] = cpu.logic(r[${rA}] >>> ${rB}, 1);`);
        case 0x076: return ok(`r[${rD}] = r[${rA}] >> ${rB};`);
        case 0x077: return ok(`r[${rD}] = cpu.logic(r[${rA}] >> ${rB}, 1);`);
        default: return generic;
      }
    }
    default: return generic;
  }
}

function emit16(cpu, h, pc, k) {
  const nxt = (pc + 2) >>> 0, nxtR = nxt | 0, op = (h >>> 12) & 7, rd = (h >>> 8) & 15, ra = (h >>> 4) & 15, fn = h & 15;
  const generic = { code: `{ const p = cpu.exec16(${U(pc)}, ${h}, ${nxt}); if (p !== ${nxt}) { cpu.jn = ${k + 1}; return p; } ${chk(k + 1, nxt)} }`, term: false };
  const ok = (code) => ({ code, term: false }), st = (code) => ({ code: code + ' ' + chk(k + 1, nxt), term: false });
  switch (op) {
    case 0:
      if (fn === 0) return ok('');
      if (fn === 3) return ok(`r[${rd}] = r[${ra}];`);
      if (fn === 4) return rd === 15 ? { code: `return r[${ra}] >>> 0;`, term: true } : generic;
      return generic;
    case 2:
      switch (fn) {
        case 8: return ok(L32(`r[${ra}]`, `r[${rd}]`));
        case 12: return st(S32(`r[${ra}]`, `r[${rd}]`));
        case 14: { const hi = (h & 0x80) !== 0, d = hi ? 16 + rd : rd, base = hi ? (ra & 7) : ra; return st(`r[${base}] = (r[${base}] - 4) | 0; ${S32(`r[${base}]`, `r[${d}]`)}`); }
        case 10: { const hi = (h & 0x80) !== 0, d = hi ? 16 + rd : rd, base = hi ? (ra & 7) : ra; return ok(`${L32(`r[${base}]`, `r[${d}]`)} r[${base}] = (r[${base}] + 4) | 0;`); }
        case 0: return ok(`r[${rd}] = cpu.add(r[${rd}], r[${ra}], 1);`);
        case 1: return ok(`r[${rd}] = cpu.sub(r[${rd}], r[${ra}], 1);`);
        case 3: return ok(`cpu.sub(r[${rd}], r[${ra}], 1);`);
        default: return generic;
      }
    case 3: { const t = U((pc & 0xfffff000) | (h & 0xffe)); return { code: `{ ${(h & 1) ? `r[3] = ${nxtR};` : ''} return ${t}; }`, term: true }; }
    case 4: {
      const t = U(pc + sx(h & 0xff, 8) * 2);
      if (rd === 15) return { code: `return ${t};`, term: true };
      return { code: `if (${condExpr(rd)}) return ${t}; return ${nxt};`, term: true };
    }
    case 5: return ok(`r[${rd}] = ${h & 0xff};`);
    case 7: {
      const i5 = (h >>> 3) & 31, kk = h & 7;
      if (kk === 0) return ok(L32(`(r[2] >>> 0) + ${i5 << 2}`, `r[${rd}]`));
      if (kk === 4) return st(S32(`(r[2] >>> 0) + ${i5 << 2}`, `r[${rd}]`));
      return generic;
    }
    default: return generic;
  }
}