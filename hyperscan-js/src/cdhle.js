// HLE do CD: em vez de emular o servo/CDDSP inteiro, intercepta funções do driver do BIOS (endereços do BIOS carregado em RAM).
// Cada hook confere a assinatura da função (push! r3 / push! r2) antes de agir.
const SIG = 0x230e;
const NOLOG = () => {};
// Copia `n` bytes de src[off..] para a memória emulada em dest. Usa o caminho direto da RAM (segmentos 0x80/0xa0) em blocos de 32 bits; o resto cai em bus.w8.
function copyToBus(bus, dest, src, off, n) {
  const seg = (dest >>> 24), o0 = dest & 0xffffff;
  if (!globalThis.__forceSlowCopy && (seg === 0xa0 || seg === 0x80) && o0 + n <= 0x1000000) {
    const ram = bus.ram, cw = bus.codeWords;
    ram.set(src.subarray(off, off + n), o0);
    // se a cópia tocou palavras de código, invalida os blocos (mesma regra das escritas comuns)
    if (o0 < 0x400000) { const hi = Math.min(o0 + n, 0x400000) - 1; for (let w = o0 >>> 12, e = hi >>> 12; w <= e; w++) if (cw[w << 10] !== undefined) bus.onCodeWrite(w << 12); }
    return;
  }
  for (let i = 0; i < n; i++) bus.w8(dest + i, src[off + i]);
}                               // push! r3,[r0] — início típico de função
export function msfToLba(pos) { const m = (pos >>> 16) & 0xff, s = (pos >>> 8) & 0xff, f = pos & 0xff; return (m * 60 + s) * 75 + f - 150; }

export function installCdHle(machine, opts = {}) {
  const cpu = machine.cpu, bus = machine.bus, log = opts.log || NOLOG, verbose = !!opts.log;
  const stats = { reads: 0, bytes: 0, toc: 0, miss: 0 };
  const ret = (c, v) => { if (v !== undefined) c.r[4] = v | 0; c.pc = c.r[3] >>> 0; return true; };
  const guard = (c, addr) => bus.r16(addr) === SIG;

  // a0024588(dest, pos(MSF binário), offset, n): copia até n bytes do setor `pos` a partir de `offset`; retorna bytes copiados (0 = indisponível)
  cpu.addHook(0xa0024588, (c) => {
    if (!guard(c, 0xa0024588) || !machine.disc) return false;
    const dest = c.r[4] >>> 0, pos = c.r[5] >>> 0, off = c.r[6] >>> 0, n = c.r[7] >>> 0;
    const lba = msfToLba(pos), d = machine.disc;
    if (lba < 0 || lba >= d.sectors || off >= 2048) { stats.miss++; log(`read miss lba=${lba} off=${off} n=${n}`); return ret(c, 0); }
    const take = Math.min(n, 2048 - off), src = d.readSector(lba);
    copyToBus(bus, dest, src, off, take);
    stats.reads++; stats.bytes += take; if (verbose) log(`read lba=${lba} off=${off} n=${n} -> ${take}`);
    return ret(c, take);
  });

  // a0027c78: comando ReadTOC do BIOS. Marca "TOC pronto" (bit5 de a0042c4c) e preenche a tabela de trilhas (a005544c).
  cpu.addHook(0xa0027c78, (c) => {
    if (!guard(c, 0xa0027c78) || !machine.disc) return false;
    const TOC = 0xa005544c;
    for (let i = 0; i < 104; i++) bus.w32(TOC + i * 4, 0xffffffff);
    bus.w32(TOC + 1 * 4, 0x41000200);              // trilha 1: dados (ctrl 0x41), início 00:02:00
    const total = machine.disc.sectors + 150, m = Math.floor(total / 4500), s = Math.floor(total / 75) % 60, f = total % 75;
    bus.w32(TOC + 0xa2 * 4, (0x01 << 24) | (m << 16) | (s << 8) | f);   // lead-out (índice provisório)
    bus.w8(0xa0042c4c, 0x20);                       // bit5 = TOC pronto
    stats.toc++; log('ReadTOC HLE');
    return ret(c);
  });
  // a0025f44: open(path). Caminho nulo faz o normalizador do BIOS (a0025650) varrer a memória sem fim; devolve erro (-1).
  cpu.addHook(0xa0025f44, (c) => {
    if (!guard(c, 0xa0025f44) || c.r[4] !== 0) return false;
    stats.nullOpen = (stats.nullOpen || 0) + 1; log('open(NULL) -> -1');
    return ret(c, -1);
  });
  // ---- Leitor de cartões (HLE das APIs do BIOS que o jogo chama) ----
  // a001aa44: há cartão? retorna 0x80000000|byte0 quando sim. a001aad4(offset, n): lê n bytes da memória do cartão e devolve um ponteiro para o buffer a0042af0.
  // Memória do cartão: bytes 8..9 = id do conjunto (u16), 10..11 = número do cartão (u16). O Spider-Man espera conjunto 5.
  machine.card = null;
  machine.insertCard = (set = 5, num = 1) => { const mem = new Uint8Array(256); mem[8] = set & 255; mem[9] = set >> 8; mem[10] = num & 255; mem[11] = num >> 8; machine.card = { set, num, mem }; };
  machine.removeCard = () => { machine.card = null; };
  cpu.addHook(0xa001aa44, (c) => {
    if (!machine.card || !guard(c, 0xa001aa44)) return false;
    return ret(c, (0x80000000 | machine.card.mem[0]) | 0);
  });
  cpu.addHook(0xa001aad4, (c) => {
    if (!machine.card || !guard(c, 0xa001aad4)) return false;
    const off = c.r[4] >>> 0, n = c.r[5] >>> 0, BUF = 0xa0042af0;
    for (let i = 0; i < n && i < 64; i++) bus.w8(BUF + i, machine.card.mem[(off + i) & 255]);
    stats.cardReads = (stats.cardReads || 0) + 1; log(`card read off=${off} n=${n}`);
    return ret(c, BUF);
  });
  return stats;
}
