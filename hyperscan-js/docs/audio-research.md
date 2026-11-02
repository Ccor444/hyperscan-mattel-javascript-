# Pesquisa: sistema de som do HyperScan (SPG290 / SPG2xx)

Fontes usadas (todas as do projeto, sem internet):
- **MAME** `src/devices/machine/spg2xx_audio.cpp/.h` (mame-master.zip). Referência de código, a mesma família SPG2xx. O driver do HyperScan no MAME está marcado `MACHINE_NO_SOUND`, então o MAME não toca som do HyperScan e não tem FIFO de DAC.
- **Flick 0.1.3** `src/spu.c` (emulador HyperScan, port do fork HS-LBA). Implementa o DAC FIFO de DMA e as regras de estado de canal.
- **hyperscan-homebrew** `audio/spu-mame-audio.md` (medições com captura de hardware real, segundo os autores).
- **Medições nossas** no BIOS e no Spider-Man (registros escritos pela CPU).

## 1. Relógio e taxa

| Item | Valor | Fonte |
|---|---|---|
| Relógio do DAC | **54 MHz** (cristal 27 MHz × 2) | homebrew (A/B com captura real). Flick usa 27 MHz (diverge) |
| Taxa de amostra do DAC FIFO | `54 MHz / (clk + 1)`, clk em `0x1064` | homebrew |
| Taxa de um canal de tom | `phase × 281250 / 2^19` Hz | MAME (`140625×2×phase/2^19`), homebrew, nosso código |
| Relógio de avanço/envelope no MAME | 70312,5 Hz (= 281250/4) | MAME `advance_channel`, `audio_envelope_tick` |

**Prova no nosso BIOS:** o BIOS escreve `0x1064 = 0x4c7` antes de habilitar o FIFO. `54e6 / (0x4c7 + 1) = 44117 Hz`, ou seja, o jingle de inicialização é tocado a 44,1 kHz. Isso confirma o relógio de 54 MHz.

## 2. Registradores (offset em bytes a partir de 0x88050000)

Controle (MAME `AUDIO_*`, índice w → byte `0x1000 + 4w`), validado contra o que o jogo escreve:

| Byte | MAME | Função |
|---|---|---|
| 0x1000 | CHANNEL_ENABLE (w0) | ChEn: escrever 1 inicia o canal (re-disparo = resume) |
| 0x1004 | MAIN_VOLUME (w1) | volume principal 0..127 |
| 0x1010 | BEAT_BASE_COUNT (w4) | base do contador de batida |
| 0x1014 | BEAT_COUNT (w5) | bit 15 BIE (habilita IRQ de batida), bit 14 BIS |
| 0x1018..0x1024 | ENVCLK0/0_HIGH/1/1_HIGH (w6..9) | nibble por canal: frame do envelope = `[4,8,16..8192]` |
| 0x1028 | ENV_RAMP_DOWN (w10) | liberação rápida (rampa) |
| 0x102c | CHANNEL_STOP (w11) | canal parado por fim de onda (escrever 1 limpa) |
| 0x1034 | CONTROL (w13) | bit 6-7 VOLSEL, **bit 9 NOINT** (0 = interpolação ligada), **bit 12 SOFTCH** |
| 0x1040 | WAVE_IN_L (w16) | "FIFO write" direto (escrita de amostra 16 bits) |
| 0x1044 | WAVE_IN_R (w17) | canal direito + controle de IRQ do FIFO de software |
| 0x1050 | CHANNEL_REPEAT (w20) | reset 0x3f |
| 0x1054 | CHANNEL_ENV_MODE (w21) | bit = **manual** (CPU escreve o nível). Reset 0x3f (canais 0..5 manuais, 6..15 automáticos) |
| 0x1060 | PITCH_BEND (w24) | |
| 0x1064 | SOFT_PHASE (w25) | **relógio de amostra do DAC** (= P_DAC_SAMPLE_CLK no homebrew) |
| 0x1080 | (Flick: P_DAC_FIFOBA_LOW) | endereço base do FIFO na RAM (escrito como 32 bits pelo BIOS) |
| 0x1088 | (Flick: P_DAC_INT_STATUS) | bits 1:0 tamanho (1024 << n bytes), bit 2 estéreo, **bit 14 habilita**, **bit 15 IRQ pendente** |
| 0x103c / 0x143c | CHANNEL_STATUS (w15) | canais tocando (somente leitura para a CPU) |
| 0x1040 (FIFO) | | (ver acima) |

Canal (bloco de 0x40 bytes por canal; índice w → `base + 4w`):

| w | Byte | MAME | Conteúdo |
|---|---|---|---|
| 0 | 0x00 | WAVE_ADDR | endereço de onda, bits 15:0 (palavra de 16 bits) |
| 1 | 0x04 | MODE | bits 5:0 endereço alto; bit 6-11 loop alto; **bits 13:12 tone mode**; bit 14 16 bits; bit 15 ADPCM |
| 2 | 0x08 | LOOP_ADDR | endereço de loop |
| 3 | 0x0c | PAN_VOL | bits 6:0 volume, bits 14:8 pan (0x40 = centro) |
| 4 | 0x10 | ENVELOPE0 | inc (6:0), sinal (7), alvo (14:8), periodo de repetição (15) |
| 5 | 0x14 | ENVELOPE_DATA | **EDD = nível do canal (6:0)**, contagem do envelope (15:8) |
| 6 | 0x18 | ENVELOPE1 | carga (7:0), bit 8 repete, bits 15:9 contagem de repetições |
| 7 | 0x1c | ENVELOPE_ADDR_HIGH | endereço alto do envelope (5:0), IRQ |
| 8 | 0x20 | ENVELOPE_ADDR | endereço do envelope |
| 10 | 0x28 | LOOP_CTRL | offset de loop do envelope (8:0), offset de rampa (15:9) |
| 13 | 0x34 | ADPCM_SEL | bit 15 ADPCM36, pontos (14:9) |
| fase | 0x800 (ch<16) | PHASE | fase do canal (ver nota) |

**Tone mode** (MODE bits 13:12): 0 = **software**: a onda não vem da memória, a CPU escreve a amostra em WAVE_DATA (w11, 0x2c) — MAME `fetch_sample`; 1 = one-shot (para no `0xFFFF` / `0xFF`); 2 = loop (volta a `LOOP_ADDR`).

## 3. Decodificação de amostras (MAME `fetch_sample`)

- Marcador de fim: `0xFFFF` em 16 bits; em 8 bits, o byte `0xFF` (MAME duplica o byte e compara `0xFFFF`).
- 8 bits: amostra `b ^ 0x80` escalada; 16 bits: palavra `^ 0x8000`.
- IMA ADPCM: 4 nibbles por palavra, **menos significativo primeiro**. Flick confirma: ler o nibble alto primeiro faz as vozes do IWL saturarem.
- ADPCM36: palavra de cabeçalho antes de cada 8 palavras de dados; shift = bits 3:0; coeficiente = bits 9:4 com sinal. **O coeficiente é uma aproximação no MAME** (comentário do próprio código e do Flick): o som é quase só o shift.
- Loop (tone 2) no MAME: `set_wave_addr(loop_addr)`. Flick ainda não implementa loop (lacuna dele, não do hardware).

## 4. Mistura (MAME `sound_stream_update`)

Por amostra de saída, para cada canal ativo:
1. Interpolação linear entre a amostra anterior e a atual, se `NOINT = 0`: `s = (cur × lf >> 8) + (prev × (256 − lf) >> 8)`.
2. Nível: `s = (s × EDD) >> 7` (EDD 0..127, 127 ≈ unidade).
3. Pan (inteiro): `pan < 0x40 ? (pl = 127·vol, pr = pan·2·vol) : (pl = (127−pan)·2·vol, pr = 127·vol)`; `L += (s·pl) >> 14`.
4. Após somar os canais: `>> 4` se VOLSEL = 0, `>> 2` caso contrário.
5. Volume principal: `(total × MAIN) >> 7`, saturado em int16, saída `/ 32768`.

Não há EQ nem compressor no código do MAME (registradores escritos e ignorados). Não podemos validar essas partes contra o MAME.

## 5. Envelope

- **Manual** (bit de ENV_MODE = 1): a CPU escreve EDD. É o caso do IWL (homebrew: "ChEnvMode = 0", o jogo escreve EDD direto).
- **Automático** (bit = 0): a cada `envclk` quadros do relógio de 70312,5 Hz, `audio_envelope_tick`: conta, alvo, incremento, sinal (descida; ao chegar a zero o canal para), repetição com endereço de envelope. Implementamos isto na versão nova (ainda não instalada).
- **Rampa rápida** (ENV_RAMP_DOWN): EDD diminui `rampdown_offset` a cada `13·4·4^clk` quadros e para no zero. Não implementada.

## 6. DAC FIFO de DMA (o que falta no nosso emulador)

Usado pelo **BIOS** (jingle de inicialização) e, segundo o homebrew, pela maioria dos jogos comerciais.

Sequência medida no nosso BIOS (log de escritas, t≈205 M):
```
0x1088 = 0x4007      habilita, estéreo, 8 KB (size 3)
0x1080 = 0x80042cd0  endereço base (RAM)
0x1084 = 0x8004      (segunda palavra do endereço / ver nota)
0x1064 = 0x04c7      relógio: 54 MHz / 1224 = 44117 Hz
```
Comportamento (homebrew + Flick):
- Buffer ping-pong de **4096 palavras de 16 bits** (8 KB), estéreo entrelaçado L,R; dados **sem sinal** (XOR `0x8000`).
- Cada metade (2048 palavras) gera **IRQ (FIQ, vetor 63)**; a CPU reabastece a metade consumida.
- Nosso emulador não tem nada disso: a escrita fica no mapa genérico e nenhum som sai. **É a causa do silêncio do jingle do BIOS.**

**Divergência entre fontes (a decidir por teste):** o Flick diz que o `0x1080` é só a parte baixa e que o `0x1084` é a parte alta; o log mostra `0x1080` com o valor completo de 32 bits. Vamos usar o valor de 32 bits de `0x1080` e tratar `0x1084` como ignorado até medirmos o efeito.

## 7. Estado de canal e retomada (já implementado)

- **Retomada no re-disparo** (homebrew e nosso teste no IWL): o jogo escreve o mesmo endereço a cada quadro. Reiniciar o decodificador gera um zumbido de 60 Hz. Solução: preservar a posição e o estado ADPCM por endereço de onda (`resume`). Implementado.
- **Sem limite artificial de duração**: o canal termina só em fim de onda (`0xFFFF`/`0xFF`) ou em `ChEn = 0`. (Limite de 110000 amostras cortava a música; removido no homebrew.)
- **IWL** toca tudo pelo **canal 0**, com pedaços de ADPCM pré-misturados pela CPU. A CPU escreve o nível (EDD) e o pan é do software. Por isso o canal 0 e a retomada são críticos para o IWL.

## 8. O que o nosso `spu.js` faz hoje e o que falta

| Recurso | Estado |
|---|---|
| Canais PCM 8/16, IMA, ADPCM36, fim de onda, loop tone 2 | OK (loop validado parcialmente) |
| Taxa por phase, 281250/2^19 | OK |
| Retomada por endereço | OK |
| Pan/volume de canal | OK (escala diferente do MAME, ver abaixo) |
| Interpolação linear (NOINT) | **falta** (na versão instalada) |
| EDD (nível manual/automático) | **falta** (ignorado na versão instalada) |
| Envelope automático | **falta** (na versão instalada) |
| VOLSEL e MAIN com a aritmética do MAME | **parcial** (escala diferente) |
| **DAC FIFO de DMA (0x1080–0x1088)** | **falta** — causa do jingle mudo |
| Tone mode 0 (CPU alimenta WAVE_DATA) | **falta** |
| Rampa rápida (ENV_RAMP_DOWN) | falta |
| EQ e compressor | não existem no MAME; sem referência |
| Canal de software WAVE_IN | falta (MAME: soma direta por amostra) |
| Síntese no tempo emulado (não no relógio da página) | **falta** — o áudio hoje depende da velocidade do navegador |

## 9. Ordem de implementação recomendada

1. **Síntese no tempo emulado** (gerar 735,7 amostras por quadro de vídeo em `io.tick`; a página só consome o anel). Corrige sincronia e silêncios.
2. **DAC FIFO de DMA** (0x1080/0x1088/0x1064, IRQ por metade). Faz o jingle do BIOS tocar e cobre os jogos que usam FIFO.
3. **Mistura no padrão MAME** (interpolação, EDD, pan em inteiros, VOLSEL, MAIN). Ajusta o nível.
4. **Envelope automático** e **tone mode 0** (WAVE_IN). Usado pelos jogos com envelope automático e pelo streaming da CPU.
5. **Rampa rápida** e batida (BEAT IRQ).

## 10. Como verificar sem ouvido

- **Jingle do BIOS:** deve produzir amostras no anel a 44117 Hz durante o boot. Critério objetivo: pico > 0 e IRQ FIQ de metade a cada 2048 palavras.
- **IWL (canal 0):** o log deve mostrar ChEn 1 a cada quadro com o mesmo endereço e nenhuma reinicialização do decodificador (sem zumbido de 60 Hz).
- **Assinatura de equivalência:** a síntese no tempo emulado muda o estado (ChSts, EDD), então as assinaturas de jogo mudam. O boot sem canal deve manter `ad9b2e8f194f`.
- **Nível:** comparar o pico médio com a referência do MAME para o mesmo estado de canal (ver `tools/`).

## 11. Divergências abertas (não resolvidas pelas fontes)

1. **Significado de `0x1064`.** O MAME chama de "Software Channel Phase" e apenas guarda o valor (não há FIFO no MAME).
   - Pela fórmula de fase do MAME, `0x4c7` daria `1223 × 281250 / 2^19 ≈ 656 Hz`.
   - Pela leitura do homebrew (divisor de relógio, 54 MHz), `0x4c7` daria `54e6 / 1224 ≈ 44117 Hz`.
   - A medição mais forte a favor do homebrew é o jingle do BIOS: a 656 Hz ele seria inaudível e sem sentido. A conclusão atual: usar o divisor de 54 MHz para o FIFO, e validar com o jingle (critério: a fase de 44117 Hz produz a sequência de amostras do jingle, sem tom grave).
2. **Bit 9 de `0x1034`.** MAME: NOINT. Flick: "canal de software" no fork. Adotamos MAME (é o nome do cabeçalho). O BIOS escreve `0x10cb`, com bit 9 limpo e bit 12 ligado, então o efeito de NOINT no BIOS é interpolação ligada.
3. **Endereço do FIFO.** Flick: 0x1080 = parte baixa, 0x1084 = parte alta. Log do BIOS: 0x1080 recebe 32 bits completos. Adotar o valor de 32 bits de 0x1080 e medir.
4. **Escala de mistura.** Flick usa `(s·pan) >> 7` e o MAME usa `>> 14` com `VOLSEL`. Adotamos o MAME (referência de código). O nível final deve ser verificado pelo pico do jingle e do cursor do menu, não pelo ouvido.

## 12. Estado após a integração (SPU novo, Flick + MAME)
- Implementado: síntese no tempo emulado; 24 canais com PCM/IMA/ADPCM36, loop e tom 0; status e flags de parada; FIFO de DMA com IRQ por metade e relógio de 54 MHz; mistura com pan/VOLSEL/volume principal; envelope automático e interpolação (do MAME).
- Medido: o FIFO liga no BIOS e produz o jingle; cursor e Start do Spider-Man produzem som na página.
- Nova assinatura do boot: 2284dc89bcd7 (muda porque o FIFO altera a execução do BIOS).
- Ainda aberto: o IWL com o modelo novo (não foi possível rodar o IWL até o menu); escolha da tabela IMA; EQ e compressor (sem referência no MAME).
