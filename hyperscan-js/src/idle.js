// Avanço de tempo em esperas ociosas (HLE): em vez de executar milhões de instruções girando num laço que só termina numa interrupção,
// o relógio dos periféricos avança até o próximo evento. O código do jogo continua rodando normalmente (a interrupção é entregue na próxima instrução).
// Laço do jogo Spider-Man: a00a18f0 `lhu r5,[gp-14874]; lhu r4,[gp-14880]; cmp; bne` espera o contador de quadros mudar.
export function installIdleSkip(machine) {
  const cpu = machine.cpu, bus = machine.bus, io = machine.io;
  const stats = { skips: 0, cycles: 0 };
  machine.idle = stats;
  cpu.addHook(0xa00a18f0, (c) => {
    if (!machine.idleSkip || bus.r16(0xa00a18e4) !== 0x230e) return false;     // assinatura: push! r3 no início da função
    const g = c.r[28] >>> 0;
    if (bus.r16(g - 14874) !== bus.r16(g - 14880)) return false;               // contador já mudou: nada a esperar
    if (!(c.cr[0] & 1)) return false;                                          // interrupções desabilitadas: não adianta esperar
    const pc0 = c.pc, n = io.nextEventCycles(); io.tick(n); stats.skips++; stats.cycles += n;
    // [FIX] Áudio acompanha o pulo ocioso: io.tick avança io.frameCycles (relógio de vídeo/periféricos),
    // mas spu.sync() calcula o alvo de amostras a partir de cpu.cycles. Sem este incremento, o áudio
    // ficava para trás sempre que o jogo pulava uma espera (ida a vblank / timer) — sintoma: som
    // engasgado, drift crescente, underruns no pull. Mantém o consumo nominal: n instruções "executadas".
    c.cycles += n;
    return c.pc !== pc0;                                                       // se a interrupção foi entregue durante o avanço, este passo já foi consumido; senão executa normalmente
  });
  return stats;
}