# SPU do SPG290 — especificação de hardware (fontes primárias)

Fontes e como são citadas:
- **[PG02]** SPG290 Programming Guide v0.2 (AUG 25, 2005), repositório LiraNuna `docs/spg290.pdf`, texto extraído com pdftotext. Capítulo de som com registradores D000–D0xx.
- **[PG05]** SPG290 Programming Guide v0.5 (10/17/2005), mesmo arquivo; seção 8.3.3 (P_SPU_START_ADR).
- **[MAME]** `spg2xx_audio.cpp/.h`, mesma família SPG2xx.
- **[HB]** hyperscan-homebrew `audio/spu-mame-audio.md`.
- **[FL]** Flick 0.1.3 `src/spu.c`.

Convenção: o registrador D0xxH do datasheet = offset 0x10xx no nosso mapa (0x88050000 + 0x1000 + xx). Ex.: D034 → 0x1034, D064 → 0x1064.

## 1. Canais de tom (confirmado por [PG02], [MAME], [FL])
- 24 canais (tabela de modos 24/16/8 ch em [PG02] para VolSel).
- Taxa de um canal: `f = 281250 × Phase / 2^19` Hz. [PG02]: "Max. 281.25kHz tone-color sample rate". Phase de 19 bits: `Phase[18:16]` no registrador D044 (bits 18:16), `Phase[15:0]` no D0x0 do canal.
- Amostra de 8 bits: **sem sinal**, meio em 0x80, FFh = código de fim da onda (nunca é dado). [PG02] linha 5185.
- Envelope: 7 bits **sem sinal**, máximo 0x7F, mínimo 0x00. [PG02] linha 5203.

## 2. Mapa de D034 (controle) — confirmado
Ordem das colunas em [PG02] linha 5241: `Saturate | SoftCh | CompEn | NoHigh | NoInt | EQEn | VolSel | FOF | Init`.
Posições (consistentes com [MAME] NOINT=0x200, SOFTCH=0x1000):
- bit 15 Saturate, bit 12 SoftCh, bit 11 CompEn, bit 10 NoHigh, bit 9 NoInt, bit 8 EQEn, bits 7:6 VolSel, bit 5 FOF (sobrecarga, escrever 1 limpa), bit 4 Init.
- NoInt=0: interpolação linear ligada quando phase < 0x10000 [PG02].
- NoHigh=0: interpolação de alta qualidade (compensa jitter de fase) [PG02].
- VolSel=0: volume de um canal = 1/32 do máximo em 24 canais, 1/16 em 16, 1/8 em 8 [PG02].

## 3. Canal de software (FIFO) — [PG02], só isto está documentado
- **SoftCh=1** (D034 bit 12): entra um **FIFO de 16 posições** (16-depth) em D040. Quando SoftCh=0, a escrita em D040/D044 é somada direto à saída.
- D040 = `FIFO_Write_Data[15:0]`, escrita sequencial no FIFO. A leitura é periódica, no ritmo definido por **Phase_Soft = D044[18:16] : D064[15:0]**, com a mesma relação de taxa dos canais de tom [PG02] (linha 6016).
- D044[3:0] = `FIFO_Irq_Threshold`. D044 bit 15 = SoftIrq (status), bit 14 = SoftIrqEn. Quando restam menos dados que o limiar, SoftIrq é setado; FIQ só vai à CPU se SoftIrqEn=1 [PG02].
- D034 Mixer_Sel[1:0]: bit 1 = canal de software na esquerda, bit 0 = na direita; 0 = silêncio naquele lado [PG02].
- **Não há DMA descrito em [PG02] para o canal de software.** Quem alimenta o FIFO é a CPU, escrevendo em D040.

## 4. Mixer de saída
- D048/D04C = WaveOutL/R: saída final de 16 bits, soma de 24 canais + canal de software quando SoftCh=1 [PG02].
- D040/D044 com SoftCh=0: WaveInL/R são somados direto na mistura [PG02].
- Canais de tom com envelope automático ou manual: D020/D024 (EnvClk 4 bits por canal), D028 (EnvRampDown), D02C (ChStopSts), D030 (ChZeroCrossEn) [PG02 linha 5236].

## 5. Divergências entre fontes (importante)
| Assunto | [PG02] | [MAME] | [HB] / [FL] | Nossa implementação atual |
|---|---|---|---|---|
| Canal de software | FIFO 16 posições, CPU escreve em D040 | FIFO não implementado; soma direta | DMA de 4096 palavras em 0x1080/0x1088, IRQ por metade | DMA (seguindo HB/FL) |
| Significado de 0x1064 | Phase_Soft (fase, taxa 281250×phase/2^19) | "Software Channel Phase" | divisor de relógio, 54 MHz/(clk+1) | 54 MHz/(clk+1) |
| 0x1080 / 0x1088 | **não documentados** em [PG02] | não existem | DMA | DMA |
| Endereço da onda | P_SPU_START_ADR 0x88070054, bits 23:8 (PG05) | — | — | 0xa0800000 fixo (escolhido por tentativa) |
| Bit 9 de D034 | NoInt | NOINT | "canal de software" (FL) | NOINT |

Conclusões:
1. **Pela documentação oficial, o canal de software é alimentado pela CPU em D040 com taxa de fase.** Nossa rota de DMA em 0x1080/0x1088 e o relógio de 54 MHz vêm de HB/FL e não aparecem em [PG02]. Ou seja, são hipóteses, não fatos do datasheet.
2. O BIOS escreve 0x1064 = 0x4c7. Pela fórmula oficial isso é fase 1223 → **656 Hz** para o canal de software. O homebrew diz 44117 Hz. Não resolvido pelo datasheet.
3. O endereço base das ondas deve vir de P_SPU_START_ADR (0x88070054), e não de uma constante.

## 6. O que falta medir antes de codificar o decodificador
- Se os jogos escrevem em D040 (FIFO por CPU). Nosso log do Spider-Man e do BIOS: nenhuma escrita em D040 nas primeiras centenas de milhões de instruções. Logo o jingle do BIOS não passa por D040.
- Valor escrito em P_SPU_START_ADR (0x88070054) pelo BIOS e pelo jogo, para fixar a base das ondas.
- Se a taxa do DMA (0x1064) segue 281250×phase/2^19 ou 54 MHz/(clk+1): ouvir os dois WAVs já gerados (jingle-estereo-44k.wav e jingle-mono-22k.wav) e comparar com o jingle conhecido.

## 7. Medição da base das ondas (feita)
- O BIOS (t≈190 M) e o jogo (t≈698 M) escrevem **0** em P_SPU_START_ADR (0x88070054). Bits 23:8 = 0 nas duas vezes.
- Consequência: a base do buffer do SPU, pelo registrador, é 0. Nosso `WAVE_BASE = 0xa0800000` não está confirmado. Ele só fazia sentido porque encontramos a onda do cursor perto de 0xa0ac5104 em RAM, mas isso não fecha a conta: o cursor (AAA_CURSOR01.DRM, 3296 bytes) não bate com o endereço waddr*2 + 0xa0800000 de forma consistente.
- Próxima medição: mapear o endereço de cada canal (waddr*2 + base) contra os arquivos .DRM conhecidos do disco, testando bases 0x00000000, 0xa0000000 e 0xa0800000, e ver qual base faz o início da onda casar com o início de um arquivo DRM.
