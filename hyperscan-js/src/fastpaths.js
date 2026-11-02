// Atalhos nativos (HLE) para laços muito quentes do jogo Spider-Man (a rotina de desenho do próprio jogo, código sem otimização).
// Cada atalho confere a assinatura do código antes de agir, então outros jogos não são afetados. Desligue com new HyperScan(bios, { fastPaths: false }).
// Efeito colateral: o laço deixa de consumir instruções emuladas (o jogo "ganha" tempo livre por quadro); o resultado na tela é o mesmo.
const BLIT_WORDS = [0xc0828024, 0x8483fffe, 0x74607464, 0x84888001, 0x9000a43c, 0xc0828030, 0x80a48870, 0xc082802c, 0x80859010, 0x741c2448,
  0x04537560, 0x80a49410, 0xc0828028, 0x80a59010, 0x245d7418, 0xc0828030, 0x8483fffe, 0xd0828030, 0x8822a20a];   // a0112200..a0112248

export function installFastPaths(machine) {
  const cpu = machine.cpu, bus = machine.bus, stats = { blits: 0, pixels: 0 };
  machine.fast = stats;
  // a011220a: cabeça do laço interno: for (x = [r2+48]; x >= 0; x--) *(u16*)([r2+40] + 2x) = (u16) *(u32*)([r2+44] + 4x)  (converte 32 -> 16 bits)
  cpu.addHook(0xa011220a, (c) => {
    if (!machine.fastPaths) return false;
    for (let i = 0; i < BLIT_WORDS.length; i++) if (bus.r32(0xa0112200 + i * 4) !== BLIT_WORDS[i]) return false;     // assinatura do código
    const fp = c.r[2] >>> 0, x0 = bus.r32(fp + 48) | 0;
    if (x0 < 0 || x0 > 4096) return false;
    const tab = bus.r32(fp + 44), dst = bus.r32(fp + 40);
    let val = 0;
    for (let x = x0; x >= 0; x--) { val = bus.r32(tab + x * 4); bus.w16(dst + 2 * x, val & 0xffff); }
    bus.w32(fp + 48, 0xffffffff); bus.w32(fp + 12, val);                    // variáveis da pilha como o laço as deixaria
    c.r[4] = -1; c.r[5] = (dst | 0);                                        // r4 = x final, r5 = último endereço (x = 0)
    c.sub(-1, 0, 1);                                                        // flags do cmpi.c r4, 0 que encerra o laço
    c.pc = 0xa011224c;                                                      // destino do blt (fim do laço)
    stats.blits++; stats.pixels += x0 + 1;
    return true;
  });
  return stats;
}
