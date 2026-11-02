# HyperScan JS (bring-up)

Emulador do HyperScan (SoC Sunplus SPG290, CPU S+core7) em JavaScript puro, sem dependências.
Interface: `python3 -m http.server` nesta pasta e abrir `index.html` (módulos ES não carregam por file://).
Node: `node tools/disc-info.mjs <disco.bin>` e `MAXI=50e6 node tools/boot-test.mjs <bios.bin>`.

## Estado
- CPU S+core7 completa para o que o BIOS usa (tabela oficial do binutils + repositório LiraNuna/hyperscan-emulator).
  Busca como no repositório: 32 bits só em PC alinhado com p0=1; palavra com p0=0 = duas instruções de 16 bits (p1 = par paralelo, executa low se T, senão high).
- Mapa: BIOS em 0x9E/0x9F (segmentos de 16 MB), DRAM 16 MB em 0x80/0xA0, periféricos em 0x08/0x88 (UART em 0x08150000).
- Validação: com o BIOS `hyperscan.bin`, o JS e o C++ de referência (`tools/ref/ref.cpp`, compilado contra o repo) produzem a mesma UART
  (`SPGM\rDL1L2K/\r`) e os mesmos registradores aos 2M de instruções (r4=3b5e r8=a0055621 r9=88070064).
- Interrupções implementadas (docs SPG290 cap. 26/27 + S+core7): exceção/IRQ/`rte`, controlador de IRQ (0x880A0000, INTPND), timers 1–6 (0x88160000 + n*0x1000) e IRQ de vblank do PPU (0x88010080/84).
  Vetor de IRQ = cr3 + ((63 - fonte) + 128) * 4; ECR[23:18] = 63 - fonte. O tempo é simplificado (quadro = `io.frameLen` instruções).
- Com isso o BIOS sai do laço de espera, atende vblank e timer a cada quadro (150 quadros / 322 IRQs em 30M instruções) e fica no laço principal.
  A UART só imprime `SPGM\rDL1L2K/\r`: o próximo passo do BIOS depende do controlador de CD.

## Falta para o BIOS chegar ao disco
1. Controlador de CD/servo (0x88060000, IRQ 3 "CD servo"): o spg290.pdf (cap. 19) é só uma nota de projeto, sem mapa de registradores.
   O BIOS tem strings do driver (`SCMD:ReadTOC`, `TOC is Ready`, `Found Program CD`, `Hyper.Exe`, zlib), então o modelo tem de ser deduzido do código do BIOS.
2. Vídeo (PPU 0x88010000, TV 0x88030000, LCD 0x88040000), SPU (0x88050000), GPIO/controles, DMA (0x88080000, 0x880C0000, 0x880D0000).
3. Carregar `HYPER.EXE` (Disc.readFile). Cabeçalho: 65 palavras `j 0x90300` (tabela de vetores), código a partir de 0xE04; endereço de carga ainda a confirmar.

## Ferramentas
- `tools/boot-test.mjs` (roda o BIOS e mostra UART/IRQs/registradores não modelados), `tools/trace-io.mjs`, `tools/dump-ram.mjs`.
- `tools/ref/ref.cpp`: harness C++ contra o repositório de referência (CPU sem IRQ); serve para comparar traços e desassemblar.

## Fatos do disco
Raw MODE1 2352 B/setor, 19097 setores, ISO9660 `SM_V1_0_USE1`. `HYPER.EXE` em LBA 18304 (790088 B, contém zlib). Pastas: DATA, HMAPS, HUD, INTRO, MISSIONS, MOVIES, SCREENS, SOUNDS, THEMES, VOICEOVERS.

## Atualização — CD / servo (BIOS passa a falar com o drive)
- Sem a espera por interrupção: o BIOS roda a calibração de atraso (~410M instr; use `TIMERDIV=8` para acelerar nos testes) e entra na detecção de disco.
- `src/servo.js`: interface do uP do servo em 0x88060000 (ADDR +04, DATA +08, CTRL +0c: 0=escreve, 1=lê, lê 1 enquanto ocupado).
  Mailbox do DSP em 0x500..0x509: 0x02/0x12 escrevem IM/PM, 0x03/0x13 leem (verificação do firmware passa: `Total IM Err: 0`, `Total PM Err: 0`).
  Comandos do uP disparam em reg 0x40d (bit7 = ocupado; zerado na hora). reg 0x7d (com reg 0x30 = 2) = FE_P2P: valor 0x30 => `CDRW / DID OK`.
  reg 0x79: bit5 pronto, bit7 foco OK (FOK); a leitura em a002de34 (CAV-on) exige bit7 limpo.
- Saída UART atual: `SCMD:ReadTOC / SRV:RESET OK / DiscID start / Off Cal end / FE_P2P=30 / CDRW / DID OK / FSGAdj / (foco fecha) / TON_timeout / CAVON: MTOUT / SCMD:Open`.
- Buffer de dados do CD (regs +40..+80): +60=0x8005d000 início, +64=0x8006feff fim, +68 ponteiro de escrita, +6c=0x940 (2352+16 bytes por quadro), +70=0x10.
- HYPER.EXE: 65 vetores `j 0xa0090300` no início => carregado em 0xa0090000 (cr3 = base do vetor).
- Ferramentas: tools/servo-trace.mjs, uart-dump.mjs, search79.mjs, profile.mjs, pctrace.mjs, dump-ram2.mjs.

## Próximos passos
1. Terminar a máquina de estados do servo (TON/CAV/CLV: leitura de reg 0x79 por ponto de chamada em a002b6d4, a00311a8, a0031ba8, a0031c84, a003272c, a0032578).
2. Alimentar o buffer circular com quadros do disco (LBA pedido pelo `seek`), e o TOC (Q-channel) para `TOC is Ready`.
3. Alternativa HLE: interceptar a leitura de setor do cdfs (a0024xxx) e responder direto da imagem.

## Atualização — o jogo carrega do disco (HLE do CD)
- `src/cdhle.js` (hooks por endereço, `cpu.addHook`): `a0024588` = leitura de setor do BIOS servida direto da imagem (MSF binário -> LBA = (m*60+s)*75+f-150, 2048 B/setor);
  `a0027c78` = comando ReadTOC concluído (bit5 de a0042c4c, tabela a005544c com a trilha de dados e lead-out);
  `a0025f44` = open(path): caminho nulo devolve -1 (o normalizador de caminho do BIOS varre a memória sem fim com NULL).
- Resultado (`TIMERDIV=8 node tools/hle-test.mjs`): o BIOS lê o ISO9660 (CD001, tabela de caminhos), carrega `Hyper.Exe` (LBA 18304-18689, 386 setores)
  e o código do jogo (a009xxxx) passa a rodar, abrindo `screens\LoadScreen.mov`, `LoadBar.svt`, `HSLogoBig.svt`, `data\CardData.dta` e mais (LBA 10042, 13047...).
  O servo continua falhando no fundo (`TON_timeout`), mas o jogo não depende disso.
- Falta: PPU/VDU de verdade (hoje o `io.js` só guarda registradores: o jogo configura buffers em 0xa0cf0000/0xa0df0000/0xa0ef0000 e sprites/paletas em 0x88012000..),
  SPU, controles (GPIO), e investigar por que o jogo pede `open(NULL)` (provável dado/serviço do BIOS ainda não modelado, ex.: leitor de cartões).

## Atualização — primeira imagem
- `src/ppu.js`: renderizador do PPU para camadas TEXT em modo bitmap (RGB555/RGB565, transparência por P_Trans_RGB, deslocamento por linha 0x2000+4*y, wrap 1024x512 em VGA).
  Modo bitmap: `P_TXn_N_PTR` (0x30/0x4c/0x68) aponta para um vetor de deslocamentos de linha (32 bits, 0x400/linha); base = `P_TXn_BUF_SA1` (0xa0/0xac/0xb8). Resolução em `P_PPU_Control` b1:0 (01 = VGA 640x480).
- Resultado: a tela de carregamento do jogo (Marvel / Columbia Pictures / Spider-Man, com o texto de copyright rolando) aparece ao rodar BIOS + disco (~640M instruções; `tela-carregamento.png`).
- `index.html` agora liga HLE do CD e boot rápido sozinho, ajusta o canvas à resolução do PPU e mostra a UART.
- Falta: camadas TEXT em modo caractere, sprites (512, paletas, flips, profundidade), blending, SPU (áudio), controles (GPIO) e vídeo MOV/SVT.

## Atualização — bug do CNT e sprites
- Bug corrigido em `cpu.js`: a condição `cnz` (bcnz) testa `CNT != 0` e só então decrementa (o `memcpy` do jogo usa `CNT = n-1`). A versão do repositório de referência (e a minha) copiava um byte a menos
  e o jogo lia um tamanho corrompido (0xa00005f0) ao desserializar a fonte, ficando em cópia infinita.
- Com isso o jogo segue: abre `intro\legal.tgz`, `sle.tgz`, `Screens\title.tgz`, fontes, temas, `scanpow`, `savesm`, ícones, e carrega ~100 efeitos de som (`SOUNDS\DRMFILES\*.DRM`); tela VGA com dezenas de sprites (~2000M instruções).
- `src/ppu.js`: sprites (formato do PDF, paleta 32 bits em 0x88011000, 4/8 bpp, flips, profundidade) e ordenação texto/sprites por profundidade.
  Ainda não validados visualmente: ordem dos nibbles em 4 bpp, endereço do caractere (SP_BUF_SA + n*bytes), blending, camadas TEXT em modo caractere.
- Falta: SPU (áudio), controles (GPIO), vídeo MOV/SVT fluido (a tela de carregamento aparece parcialmente decodificada em alguns instantes), modo caractere.

## Atualização — estado do jogo (~2600M instruções)
- `io.js`: SPU mínimo (banco de registradores 0x88050000 com leitura de volta; ChEn em 0x1034/0x103c e 0x143c: canais ligados terminam sozinhos após `spuPlayFrames` quadros;
  contador de batida D010/D014 gera a fonte 1 se o jogo o habilitar — hoje ele não habilita).
- O jogo roda seu laço de quadro a 60 Hz (contador [gp-14880] avança), carrega fontes/temas/sons e fica na tela de carregamento com o letreiro, mas sem animar:
  `a00a18e4` espera o contador e chama `a00a0568` (atualização das 8 vozes de áudio, lê ChEn). Hipótese: o vídeo `LoadScreen.mov` é sincronizado com a posição de reprodução do SPU,
  ou o jogo aguarda um botão. Controles: não vimos varredura de botões ainda (o GPIO 0x88200014 só alterna os pinos TFT 0/1; ECC 0x88240000 é lido pelo ISR do driver do CD).
- Ferramentas novas: tools/idle-profile.mjs (perfil de chamadas), tools/long-run.mjs (capturas e aberturas de arquivo ao longo de bilhões de instruções).
- Próximos passos: (1) SPU de verdade: posição de reprodução por canal, Envirq/FIQ, fim de amostra; (2) descobrir de onde vêm os botões (RF/SIO?) e injetar entrada;
  (3) sprites/blend/modo caractere no PPU; (4) servo: as mensagens TON_timeout continuam no UART mas o jogo as ignora.

## Atualização — SPU (áudio) e o que realmente trava o jogo
- Mapa do SPU: offset = endereço do PDF - 0xC000 (SRAM de canais 0x0000-0x0FFC: atributos em 0x000+x*0x40, fase em 0x800+x*0x40; controle 0x1000-0x1068 canais 0-15, 0x1400-0x1460 canais 16-23).
  Corrigido: ChEn = 0x1000/0x1400 (escrita), ChSts = 0x103c/0x143c (somente leitura, canais tocando), antes eu tratava 0x103c como enable.
- `io.js` agora tem: canais que "tocam" por `spuPlayFrames` quadros e se desligam (a duração real depende da amostra; ainda sem síntese), beat IRQ (fonte 1),
  canal de software (FIFO 16 posições em 0x1040, limiar/IRQ em 0x1044, consumo ~32 kHz, FIQ = fonte 0) e contagem de amostras escritas (`softSamples`).
- Achado: no estado travado o jogo NÃO usa o SPU (nenhum acesso a 0x1000+ em centenas de milhões de instruções). Ele só chama, uma vez por quadro, duas APIs do BIOS:
  `a0000914` (evento do leitor de cartões; retorna 1 quando [gp_bios-15416]==0) e `a00008fc` (dados do cartão: contagem [-16036]=2, máscara [-16032]=3).
  O estado de alto nível do jogo ([gp-14332]) fica em 35 e o laço de quadro roda normalmente. Hipótese atual: o jogo espera entrada (controle/cartão) ou fim de um evento que não modelamos.
- Falta síntese de áudio (ADPCM/PCM dos canais de hardware e do canal de software para a Web Audio) e a entrada.

## Atualização — controles (I2C) e o jogo sai do menu
- Os controles são lidos pelo BIOS por I2C (0x88130000): registradores 0..4 (porta 1) e 0x10..0x14 (porta 2). [0,1] = eixo A (16 bits), [2,3] = eixo B, [4] = botões (ativo em nível alto).
  O jogo compara o eixo com os limiares 177/76 (centro = 0x80). Antes retornávamos sempre 0 (direcional "preso").
- Estado 35 do jogo = menu/título (espera entrada). Teste de teclas (`/tmp/presskeys`): bit 3 do reg 4 leva 35 -> 14 (nova tela, vídeo de abertura), bit 7 -> 15, depois 27. O mapeamento bit<->botão é provisório.
- `HyperScan.setPad(port, {buttons, ax, ay})` e teclado no `index.html` (Enter/Espaço = bit 3, Z X C V = bits 4-7, A S D = bits 0-2, setas = eixos).
- Observado: quadros de vídeo aparecem com linhas alternadas pretas (campos entrelaçados) e os sprites usam paleta ainda vazia (0x88011000 = 0) no menu, então saem pretos.

## Atualização — tela "SCAN SPIDER-MAN CARD" e a paleta vazia
- Depois de apertar um botão (bit 3 do reg 4) o jogo sai do menu (35), passa por um vídeo (14) e chega ao estado 15: **"SCAN SPIDER-MAN CARD"** (`tela-scan-card.png`, 640x480, 24 sprites).
- Estado 15 = `a01150e4`: espera um cartão (`[gp-15944] >= 0`, vindo da API do BIOS) ou aceita botões: `[gp-14440] & 0x1020` -> estado 27 (segue sem cartão), `& 0x2010` -> estado 34 (voltar).
  `[gp-14440]` é a palavra de botões montada pelo jogo a partir do struct da API `a00008fc` (limiares 177/76 nos eixos + bits do reg 4 do I2C).
- Paleta dos sprites: a rotina `a011bb74` copia 512 entradas de um buffer sombra (`[a01516a4]` = a0312000, 2 KB por tela) para 0x88011000 a cada troca de modo (~299 vezes até 1700M instr),
  mas o buffer sombra fica todo zero em todo o boot — nunca é preenchido pelo código que executamos, então os sprites saem pretos (retângulos pretos nas laterais da tela).
  Investigar: quem deveria preencher a0312000 (provável arquivo de tema/BVG ou código ainda não executado).
- Próximo: simular uma leitura de cartão (API `a0000914`/`a00008fc` + `CardData.dta`), achar a origem da paleta, entrelaçamento do vídeo, síntese de áudio.

## Atualização — cartão virtual e vídeo
- `cdhle.js`: leitor de cartões por HLE. `machine.insertCard(set, num)` / `removeCard()`. Hooks no BIOS: `a001aa44` (há cartão? 0x80000000|byte0) e `a001aad4(offset, n)` (devolve ponteiro para n bytes da memória do cartão em a0042af0).
  Memória do cartão: bytes 8-9 = conjunto (u16), 10-11 = número (u16); o Spider-Man espera conjunto 5 (`a00acc98` retorna 5). Botão "Passar cartão" no `index.html`.
- Com o cartão (e também com botão), a tela "SCAN SPIDER-MAN CARD" (estado 15) avança para o estado 27 e começa um vídeo de abertura (bandeira/Spider-Man), que anima (quadros diferentes ao longo do tempo).
- PPU: vídeo em 160 px por linha (espaçamento entre linhas = 320 bytes) é detectado pelo vetor de offsets e esticado 2x; as linhas alternadas escuras parecem ser do próprio conteúdo (efeito de linhas de varredura).
- Ainda: paleta dos sprites vazia (retângulos pretos), áudio audível, mapeamento real dos botões, modo caractere/blending do PPU.

## Atualização — o que o driver do MAME (src/mame/tvgames/spg29x.cpp) confirma/ensina
- Confirmado: CPU 27 MHz x 4 = 108 MHz; BIOS em 0x10000000 (espelhado) no mapa do MAME = 0x9f000000 aqui; DRAM 16 MB com espelhos; MIU status 0x0807006c = 1; I2C: porta = (reg >> 4) & 15, portas 0 e 1 = controles (retorno 0xffff para as demais).
- Interrupções do SPG290 (vetor): 60 CD servo, 56 Timer (todos os 6), 53 PPU vblank start, 39 I2C, 55 TV vblank, 41 NAND, 29 ECC...
- TV encoder (implementado em io.js/ppu.js): 0x88030000 controle (b3:2 = 0 QVGA, 1 VGA, 2 HVGA; b0 entrelaçado; 0x1105 = VGA entrelaçado, 0x1100 = QVGA), 0x8803000c = fade (pixel * (255-fade)/255; o jogo deixa fade=6),
  0x88070000..0b = endereços de 3 buffers de quadro da TV (RGB565, (y*W+x)*2; sem entrelaçamento só as linhas pares são lidas e duplicadas) e 0x88090020 (b1:0) = buffer exibido (3 = nenhum).
  No Spider-Man, nessas telas, o jogo NÃO usa o buffer da TV (bufctl=3, endereços 0): o vídeo vai pelo PPU.
- Timers: clock = 27 MHz/((reg 0x082100e4 & 0xff)+1); bits 8.. escolhem 32,768 kHz por timer; controles de timer em 0x0821006c..0x08210080.
- Leitor de cartões real: protocolo serial por GPIO (0x08200024 bit 1 escreve, 0x08200068 lê) — nosso HLE substitui as APIs do BIOS; para fidelidade total seria preciso o `hyperscan_card.cpp`.
- Quickload do MAME: HYPER.EXE inteiro em 0xa00901fc, entrada 0xa0091000.
- Menu de teste oculto (MAME): segurar Select + Left Shoulder + Green durante o boot até "PLEASE WAIT"; depois Red, Red, Green, Green, Yellow, Blue.
- Arquivos do MAME que ajudariam e não consegui ler pela ferramenta: spg290_ppu.cpp (modo bitmap/sprites/paleta — resolve as linhas alternadas e os sprites pretos),
  spg290_cdservo.cpp, hyperscan_ctrl.cpp (mapeamento real dos botões), hyperscan_card.cpp, spg290_timer.cpp, spg290_i2c.cpp.

## Atualização — PPU do MAME e controles reais: o jogo renderiza como o hardware
- Os arquivos do MAME (zip enviado) deram a referência exata. `src/ppu.js` agora é um porte de `spg290_ppu.cpp`: modo bitmap com deslocamento de linha em unidades de 2 bytes (era isso o "160 px"),
  ARGB1555 com bit15 = transparente, sprites com paleta em 0x1800 (a de caracteres é 0x1000), 2/4/6/8 bpp, blending, camadas de caractere, profundidade 0-3 (camadas de texto antes dos sprites em cada profundidade),
  TV buffer e fade. Resultado: tela legal, menu SPIDER-MAN (CONTINUE EXISTING GAME / START NEW GAME / EXAMINE CARDS) e "SCAN SPIDER-MAN CARD" com os botões desenhados por sprites.
- Controles (MAME `hyperscan_ctrl.cpp`): I2C porta = (reg>>4)&15; regs 0..3 = IN.0 (01 Azul, 02 Start, 04 Select, 08 Ombro E, 10 Ombro D, 20 Gatilho E, 40 Gatilho D), IN.1 (20 Amarelo, 40 Vermelho, 80 Verde),
  IN.2 = analógico Y, IN.3 = analógico X (0x7f centro); regs >= 4 devolvem ((soma dos 4) << 2) | porta (validação). Teclado no `index.html`: Enter=Start, Shift=Select, Z/X/C/V = Verde/Vermelho/Amarelo/Azul, A/S/Q/W = ombros/gatilhos, setas = analógico.
  Testado: Start leva o menu (35) -> vídeo (14) -> SCAN CARD (15); analógico Y 0xff desce e 0x00 sobe no menu.
- Ainda: áudio audível (SPU), cartão real via GPIO (usamos HLE das APIs do BIOS), servo/CD real (usamos HLE), efeitos do PPU não portados no MAME (compressão H/V).

## Atualização — jogo jogável (~3200M instruções)
- Fluxo testado: BIOS -> telas legais -> menu (estado 35) -> Start -> SCAN CARD (15) -> cartão virtual (set 5) -> carga de `HMaps\*.rsz` (cartas) -> **fase (estado 29)**: Spider-Man cai na rua, HUD (vida, contador 0/0).
- Entrada na fase: analógico X move (0xff = direita, 0x00 = esquerda), Y (0x00 = cima, 0xff = baixo), Verde (in1 0x80) ataca/pula. A tela em 640x240 (HVGA) é exibida em 4:3 (CSS `aspect-ratio`).
- Capturas: tela-legal.png, tela-menu.png, tela-scan-card.png, tela-gameplay.png.
- Ainda: áudio (SPU sem síntese), velocidade (a interface depende da velocidade do navegador; o boot até a fase leva ~2900M instruções), cartão por GPIO real, servo/CD real.

## Atualização — desempenho (avanço de tempo em esperas ociosas)
- `src/idle.js`: o laço de espera de quadro do jogo (`a00a18f0`, espera o contador [gp-14880] mudar) não gira mais por ~1,5M instruções por quadro: o relógio dos periféricos avança até o próximo evento
  (`io.nextEventCycles()`: fim de quadro ou estouro de timer) e a interrupção é entregue normalmente. Se a interrupção é entregue durante o avanço o hook consome o passo (senão a instrução antiga rodaria por cima do desvio).
  Desligar com `new HyperScan(bios, { idleSkip: false })`.
- Medido no Node (~33 MIPS): menu (estado 35) em 20 s / 687M instruções; Start -> SCAN CARD -> cartão -> fase (29) em ~31 s / 1085M instruções (antes ~2900M); na fase ~66 quadros/s.
- Ao testar entradas use TEMPO EM QUADROS (`io.frames`), não em instruções: com o avanço de tempo, 1 quadro custa ~0,5M instruções na fase e muito menos no menu.

## Atualização — SPU (áudio)
- `src/spu.js`: mixer de 24 canais (PCM 8/16 bits). Janela de ondas em 0xa0800000 (endereço de 22 bits em palavras: byte = base + waddr*2; deduzido: os .DRM são carregados em ~0xa0ac5000 e o endereço
  0x162fa8 aponta para `0x80 0x80 ...`), 8 bits sem sinal (0x80 = silêncio), fim por 0xFF (0xFFFF em 16 bits), repetição automática pelo endereço de loop, pitch por `Phase` (taxa = 281250*Phase/2^19 Hz:
  o som do cursor usa Phase=0x503e ≈ 11 kHz), pan/volume conforme o PDF (`PanL/PanR`), volume geral D004. ChEn (0x1000/0x1400) inicia/para, ChSts (0x103c/0x143c) reflete canais tocando.
  Quadro de áudio = 735 amostras a 44,1 kHz por quadro emulado (`io.tick`), anel de 2 s (`spuChip.drain`). `index.html` toca via ScriptProcessor (checkbox "som").
- Teste (menu): cursor para baixo/cima e Start iniciam 3 canais; sons de 0,21 s, pico 0,49 (`audio-menu.wav`).
- Não implementado: ADPCM (vira silêncio curto), envelopes automáticos (Env*), pitch band, EQ, compressor, canal de software (FIFO D040; só conta/IRQ), IRQs de envelope/FIQ de canal.

## Atualização — ADPCM e saída de áudio robusta
- `spu.js`: busca de amostra uniforme por canal (uma amostra de tom por passo; taxa = 281250*Phase/2^19 Hz, também em 16 bits). ADPCM do MAME (`spg2xx_audio.cpp`): **IMA** (nibbles do menos significativo, fim em 0xFFFF, repetição vira PCM16)
  e **ADPCM36** (1 palavra de cabeçalho + 8 palavras de dados; shift = hdr&15, filtro = (hdr>>4)&0x3f com sinal). Validação: o som de "cartão aceito" (canal 0, ADPCM, waddr 0x173018) dura 65 quadros ≈ 1,08 s, igual ao
  tamanho calculado até a palavra 0xFFFF (2968 palavras a ~11 kHz).
- Filtro passa-altas (~7 Hz) na saída: o jogo mantém o canal 8 como "relógio" tocando bytes 0x00 (nível contínuo de -1,0).
- `pull(n, ratio)` reamostra para a taxa da placa de som (cai para a taxa padrão se 44,1 kHz não for aceito) e diminui a velocidade quando o emulador está abaixo do tempo real, para o som não picotar.
- Teste no Chromium (Playwright): AudioContext rodando a 44,1 kHz; setas/Enter geram saída audível (pico 0,39-0,49).
- O disco só tem efeitos (SOUNDS\DRMFILES, 130 arquivos) e vozes (VOICEOVERS\VODATA.BIN): não há arquivos de música. Faltam envelopes automáticos, pitch band, EQ/compressor e o canal de software.

## Atualização — desempenho (CPU)
- Ferramentas: `tools/bench.mjs` (N instruções de boot, MIPS + assinatura do estado: pc, registradores, md5 da RAM), `tools/bench-game.mjs` (boot até a fase + 300 quadros de gameplay), `tools/verify-blit.mjs`.
  O emulador é determinístico: a assinatura `ram=ad9b2e8f194f` (400M instruções de boot, `FAST=0`) tem que ser igual antes e depois de qualquer otimização.
- `cpu.js`: **cache de instruções decodificadas** (uma função especializada por instrução com campos pré-extraídos; RAM < 4 MiB e BIOS; validado pela palavra lida da memória, então código que muda é redecodificado)
  e **`runN(n)`** (laço de execução com o PC em variável local, `cycles` sincronizado só quando necessário). O que não é especializado cai no interpretador original (`exec32/exec16`); o par de 16 bits "paralelo" também.
  `bus.js`: caminhos diretos para RAM e BIOS. Assinatura idêntica à versão sem cache.
- `fastpaths.js` (opcional, `fastPaths: false` desliga): atalho nativo para o laço `dst16[x] = (u16) tab32[x]` da rotina de desenho do Spider-Man (a011220a), com checagem de assinatura do código.
  Verificado contra o interpretador em 28.814 chamadas (memória escrita, variáveis da pilha e r4): 0 divergências. Corta ~19% das instruções por quadro na fase (436k -> 351k).
- Tentativas descartadas (medidas): PC interno `pc ^ 0xa0000000` (sem ganho), pular a validação da palavra (só ~13% e inseguro).
- Números (Node, VM compartilhada e ruidosa, ±30%): boot 400M instr de 12,2 s para ~7-10 s; gameplay de ~68-81 para ~75-107 quadros/s; no Chromium headless o boot até o menu caiu de ~50 s para ~25 s.
- Próximos candidatos: tradução de blocos básicos para JS (maior ganho, bem mais complexa), invalidação por página de código no lugar de validar cada palavra, mais atalhos nativos para rotinas quentes do jogo (a0111ac0 é um rasterizador de spans de sprites, não um laço simples).

## Atualização — JIT de blocos básicos (`src/jit.js`)
- Cada bloco de instruções (até 48, dentro de uma página de 4 KiB, sem atravessar endereços com hook) é traduzido para uma função JavaScript gerada em tempo de execução (`new Function`).
  Dentro do bloco há acesso direto à RAM (segmentos 0x80/0xa0); o resto cai em `bus`. Uma escrita numa palavra de código invalida os blocos da página (`bus.codeWords`, `cpu.onCodeWrite`) e, se algum bloco estiver em execução, ele sai cedo com `cpu.jn`.
  Interrupção habilitada ou pendente também interrompe o bloco. A semântica é a do interpretador: as assinaturas batem (boot 400M `ad9b2e8f194f`, fase `3129744f09d1`) com JIT ligado e desligado.
- Medido com alternância (Node, máquina ruidosa):
  - boot 400M instruções: JIT ~64-72 MIPS, sem JIT ~42 MIPS.
  - gameplay (300 quadros): JIT e sem JIT ficaram na mesma faixa, 61-68 quadros/s. Ou seja, neste estágio o JIT não acelera o jogo de forma mensurável.
  - Motivo provável: cerca de 45 mil despachos de bloco por quadro, média de 9,7 instruções por bloco. O custo está no despacho (uma chamada indireta por bloco), não no código gerado.
- Próximo passo (não feito): encadear blocos (o bloco chama o sucessor direto quando o destino é conhecido) e blocos maiores atravessando desvios condicionais.
- Ferramentas: `tools/bench.mjs` (JIT=0 desliga o JIT), `tools/bench-game.mjs`.

## Atualização — leitura de CD mais rápida (HLE de setores)
- `cdhle.js`: a cópia de setores (`a0024588`) agora usa `copyToBus`: copia o bloco direto para a RAM (segmentos 0x80/0xa0) com `TypedArray.set`, em vez de `bus.w8` por byte,
  e invalida blocos do JIT só nas páginas de código afetadas. O log por setor só é montado com `opts.log` (verbose).
- Medido (`tools/bench-cd.mjs`, 2000 setores): 40.929 setores/s (83,8 MB/s) antes; 1.084.264 setores/s (~2,2 GB/s) depois, cerca de 26x.
- Verificado (`tools/verify-cd.mjs`): a cópia direta gera exatamente a mesma memória que a byte a byte, em bordas de página, escrita parcial (offset 13, 1000 bytes) e no fim da RAM. 0 bytes diferentes.
- Assinaturas do jogo inalteradas (fase `3129744f09d1`).
- Observação: o benchmark usa um atalho de teste para a assinatura do BIOS (`bus.r16` forçado para `0x230e`), porque a chamada é feita fora da execução do BIOS. Isso não existe no uso real.
- Não medido ainda: o efeito no tempo total do boot e do gameplay. Como a leitura de setor é uma fração pequena do tempo de jogo (o gargalo continua na CPU), o ganho visível no boot deve ser menor que o número isolado.

## Atualização — investigação do som na página (EM ABERTO)
- Medições corrigidas: as leituras anteriores de "silêncio na página" estavam ERRADAS: o medidor externo perdia os callbacks com som. Dentro do próprio callback de áudio o buffer de saída tem pico 0,389 e o som chega ao alto-falante.
  A causa real de "sem som" para o usuário NÃO foi confirmada. Precisa ser verificada no navegador do usuário.
- Alterações desta rodada: (1) `spu.pull` com pré-carga e limite de latência; (2) modo tempo real do mixer na página (`io.pumpAudio`, `io.rtAudio`), gerando 44.100 amostras/s de relógio de parede em vez de 735 por quadro (a página roda ~200 quadros/s, o que enchia o anel).
- Assinaturas: boot `ad9b2e8f194f` (estável). Jogo: `3129744f09d1` -> `0426e3677f33`, causa AINDA NÃO IDENTIFICADA. Testado e descartado: `spu.js` (antes/depois da correção), `io.js` modo tempo real, cópia direta de setores. Com cópia byte a byte forçada o valor é `890b283ff52c`: a assinatura do jogo depende do caminho de cópia de setores, o que contraria a verificação de `verify-cd.mjs` (feita em outro cenário). Investigar antes de qualquer otimização.
- Não verificado: som do Ben 10 e do IWL (discos não disponíveis no ambiente). Som do BIOS: o BIOS não dispara canal nem usa o FIFO de software em 2000M de instruções (silêncio esperado, não confirmado contra o hardware real).

## Atualização — retomada de canal por endereço de onda (spu.js)
- Fonte: `hyperscan-homebrew/audio/spu-mame-audio.md` (IWL). O jogo re-dispara o canal a cada quadro com o mesmo endereço; reiniciar o decodificador do zero gerava um zumbido de 60 Hz.
- `start()` agora compara o endereço com o último estado salvo daquela onda (chave: endereço × 4 + tipo de codificação). Se houver estado salvo do mesmo tipo, retoma posição e decodificador (`C.resumed = true`). Caso contrário reinicia.
- `saveResume(C)` guarda o estado quando o canal termina (fim de onda) ou é parado por `ChEn = 0`.
- Medido no Spider-Man (fase): 6 inícios frescos, 1 retomado, 4 salvamentos, 7 disparos de ChEn, pico 0,58. As assinaturas do boot (`ad9b2e8f194f`) e do jogo (`0426e3677f33`) não mudaram.
- Limitação conhecida (do próprio documento): SFX e música podem compartilhar o mesmo canal com endereços diferentes. Com a chave por endereço isso já é tratado para ondas já vistas, mas o estado de uma onda pode ser sobrescrito por outra no mesmo canal. A solução completa é um mapa por endereço com preservação independente, que ainda não foi implementado.
- Ainda NÃO feito: o canal de software (FIFO de 4096 palavras, IRQ por metade). É o próximo passo, e é o caminho usado pela maioria dos jogos.
- Não verificado contra hardware: o efeito sonoro da retomada precisa ser ouvido no IWL, que não temos.

## Teste de som na página (tools/page-sound-test.cjs)
- Abre a página entregue no Chromium (Playwright), carrega BIOS + Spider-Man, aguarda o menu e mede o áudio por fase. O medidor lê o buffer de saída depois que a página o preenche.
- Resultado medido: boot e menu parado sem som (esperado); cursor do menu: 6 callbacks com som, pico 0,392; Start: pico 0,492. Sem erros de JavaScript.
- Medições anteriores de "silêncio na página" usavam um medidor que perdia callbacks e estão descartadas.
- Não verificado: o som com o áudio real do usuário (Ben 10 e IWL não testados na página), política de áudio do navegador e dispositivo de saída.

## Interface: engrenagem e controle virtual
- Arquivos (BIOS e disco), opções (boot rápido, som, controle virtual) e ferramentas (Passo, Reset, Passar cartão) ficam no painel aberto pela engrenagem ⚙. Clique fora ou na engrenagem fecha.
- Controle virtual: D-pad (setas = analógico), Start, Select, botões de cor (Amarelo, Vermelho, Verde, Azul), ombros L/R e gatilhos LT/RT. Mostrado por padrão em telas de toque; ligado/desligado pelo painel.
- Toque multitoque: cada botão usa captura de ponteiro, então dois ou mais dedos funcionam juntos e soltar um não solta os outros.
- Teclado continua igual (Enter=Start, Shift=Select, z/x/c/v = Verde/Vermelho/Amarelo/Azul, a/s/q/w = ombros/gatilhos, setas).
- Testes: `tools/ui-test.cjs` (engrenagem, carga de arquivos, botões virtuais, dpad, teclado, emulação) e `tools/ui-multitouch.cjs` (dois dedos com eventos de toque reais). Os dois passam.
- Limitação de teste: multitoque com mouse não é possível (um só ponteiro); a validação de multitoque usa eventos de toque.

## Tela cheia e controle sobre o jogo (interface final)
- A tela ocupa o viewport inteiro (paisagem: jogo em tela cheia; retrato: jogo no topo e controle abaixo). Em celular, Rodar entra em tela cheia e tenta travar a orientação em paisagem.
- Controle virtual por cima do jogo: ombros L/R e gatilhos LT/RT nos cantos superiores, D-pad à esquerda, botões de cor à direita (Amarelo, Vermelho, Verde, Azul), Select/Start embaixo.
- Engrenagem ⚙ (canto superior direito) abre o painel: arquivos, opções, tela cheia, trocas de controle, ferramentas e diagnóstico (UART e log).
- Trocas de controle (para botões invertidos): Verde↔Vermelho, Amarelo↔Azul, inverter analógico vertical e horizontal. Os rótulos mostram a cor que realmente é enviada ao jogo.
- Mapeamento conferido com o driver do MAME (hyperscan_ctrl.cpp): Azul=IN.0 0x01, Start=0x02, Select=0x04, ombros=0x08/0x10, gatilhos=0x20/0x40; Amarelo=IN.1 0x20, Vermelho=0x40, Verde=0x80. O driver marca os eixos analógicos como PORT_REVERSE; por isso existe a opção de inverter o analógico.
- Testes: tools/fullscreen-test.cjs (tela cheia, rótulos, trocas, analógico invertido), tools/ui-multitouch.cjs (dois dedos), tools/ui-test.cjs (engrenagem, carga, controle, teclado). A única falha de ui-test é o multitoque com mouse, que é limitação do teste (um só ponteiro).

## Áudio: falhas intermitentes (AudioWorklet)
- Causa medida: o ScriptProcessor roda na thread principal, a mesma do emulador (fatias de 12 ms por quadro). Os callbacks de áudio atrasavam até 159 ms, com 15 atrasos acima de 80 ms em 60 s. O dispositivo de som ficava sem dados e entrava silêncio.
- Correção: `audio-worklet.js` (thread de áudio) recebe blocos da thread principal e mantém ~300 ms de colchão. `feedAudio()` repõe o colchão a cada 20 ms e só enquanto o jogo roda. O ScriptProcessor fica como fallback.
- Também removido o reinício da pré-carga dentro de `spu.pull` (criava silêncios longos a cada esvaziamento).
- Medido (tools/audio-worklet-test.cjs, 60 s de jogo no Chromium): worklet ativo a 44,1 kHz; colchão estável em ~277 ms; zero underruns depois do início.
- Não verificado: o som em aparelhos reais (celular, navegador próprio). O ambiente de teste não toca áudio audível.

## Desempenho (renderização e laço de quadro)
- PPU (src/ppu.js): paletas lidas uma vez por quadro (antes havia uma busca em Map por pixel), tabelas de cor, escrita de pixel direta e limpeza do quadro em uma passada. Camada de bitmap sem chamada de função por pixel.
  Verificado byte a byte contra o renderizador anterior (tools/ppu-equivalence.mjs, tools/ppu_reference.js) em menu, cartão, fase e quadros seguintes: 0 bytes diferentes.
- Página: só desenha quando o emulador avança um quadro de vídeo (antes desenhava a cada requestAnimationFrame mesmo sem mudança). Fatia de emulação de 13 ms.
- Medido na página (Chromium, mesmos passos, tools/speed-page-test.cjs): antes 137 quadros/s e 33 MIPS; depois 264 quadros/s e 46 MIPS.
- Restante do custo: a emulação (CPU) e o desenho de bitmap/sprites (~8 ms por quadro de 640x480). Próximo ganho grande: encadear blocos do JIT (ver seção do JIT).
- Assinaturas do boot e do jogo, interface, multitoque, tela cheia e áudio: sem mudança.

## Renderização (segunda rodada)
- Fade do TV encoder por tabela pré-calculada (antes: uma conta em ponto flutuante por componente de cada pixel, a cada quadro). A tabela guarda exatamente o valor que Uint8ClampedArray armazena, então o resultado é idêntico.
- Camada de bitmap lê a RAM direto pelo DataView (sem chamada de barramento por palavra) quando o endereço está na RAM.
- Sprites sem mistura de cor: escrita direta de pixel, sem chamada de função por pixel.
- Medido: renderização de 640x480 caiu de cerca de 9 para 5,5 ms. Página (mesmos passos): 270 para 336 quadros/s.
- Verificado byte a byte contra o renderizador original (tools/ppu-equivalence.mjs, referência tools/ppu_reference.js) em menu, cartão, fase e quadros seguintes, com fade ativo: 0 bytes diferentes.
- O que sobrou no desenho: a cópia da imagem para o canvas (putImageData) e as camadas de caractere. Próximo passo, se precisar: desenhar via WebGL, o que evita a cópia de 1,2 MB por quadro.

## Layout (tela inicial, cabeçalho e painel)
- Tela inicial: passo 1 (BIOS) e passo 2 (disco) com estado (✓) e botão Rodar, desabilitado até o BIOS ser carregado. Some ao começar o jogo.
- Cabeçalho (Rodar, estado, ⚙): some depois de 2,5 s sem toque durante o jogo e volta ao tocar, mover o mouse ou apertar uma tecla. Fica visível com o painel aberto.
- Erro do emulador aparece como faixa vermelha no topo (antes só no log).
- Painel: arquivos em linhas com estado, opacidade do controle virtual, seções "Trocar botões" (aberta), "Ferramentas" e "Diagnóstico" recolhidas.
- Testes: tools/layout-test.cjs (fluxo guiado, cabeçalho some e volta, sem erro JavaScript). Os testes de interface foram ajustados para começar pela tela inicial (botão #start).
- Assinaturas do boot e do jogo: sem mudança.

## SPU integrado (Flick + MAME)
- `src/spu.js` reescrito a partir da estrutura do Flick 0.1.3 (src/spu.c): síntese no tempo emulado (sync até o instante atual), 24 canais, status e flags de parada, DAC FIFO de DMA (0x1080/0x1088/0x1064, IRQ por metade), mistura com pan/VOLSEL/volume principal.
- Do MAME (o Flick não tem): envelope automático (bit 0 em 0x1054 = automático; reset 0x3f), interpolação linear (CONTROL bit 9 = NOINT), tom 0 (CPU alimenta WAVE_DATA) e laço (tone 2).
- Relógio do DAC: 54 MHz (homebrew, medido contra hardware). O Flick usa 27 MHz; mantemos 54 MHz (ver docs/audio-research.md, seção 11).
- Retomada por endereço removida: o Flick reinicia na borda de ChEn e o status correto evita o reinício indevido (divergência a validar com o IWL).
- `io.js`: o IO só repassa leitura/escrita do SPU e sincroniza o chip a cada quadro. O relógio de parede (pumpAudio) saiu da página.
- Página: a emulação é limitada pelo áudio (só emula enquanto há menos de 0,3 s de som pronto). Colchão do worklet estável (~300 ms), sem underruns depois do início.
- Verificado:
  - DMA do FIFO liga no BIOS em 200 M instruções, a 44117,6 Hz, metades de 1024 quadros (tools/fifo-check.mjs). O jingle sai com pico ~0,9.
  - Spider-Man: cursor pico 0,43 e Start pico 0,07 na página (tools/page-audio-peaks.cjs); no Node, cursor 0,42.
  - Interface, tela cheia, multitoque e layout: sem regressão (a falha do mouse é limitação do teste).
  - Custo do SPU: 2,4% do tempo de emulação em gameplay (tools/sm-sound.mjs, medição de render).
- Assinatura do boot mudou: ad9b2e8f194f -> 2284dc89bcd7. É esperado: o FIFO levanta FIQs e o BIOS segue outro caminho. O boot continua até o menu.
- Pendente: validar o IWL (canal 0, reinício por ChEn) com o novo modelo; ADPCM IMA (tabela padrão vs a do Flick, que usa 1.1^n); EQ e compressor (não existem no MAME).

## Chiado do jingle do BIOS (diagnóstico)
- O intervalo entre metades do FIFO bate com o esperado (1023,6 amostras), sem underruns no Node.
- Nenhuma metade copiada é dado antigo com áudio: o BIOS reescreve cada metade antes da próxima cópia.
- Causa medida na página: a emulação roda abaixo do tempo real (~30 quadros/s no teste headless), o anel do SPU esvazia e o `pull` entregava zeros. Cada esvaziamento virava estalo.
- Mitigação: no underrun, o SPU repete a última amostra e decai (~3 ms) em vez de silêncio; o orçamento por quadro sobe para 25 ms quando o colchão de áudio está abaixo de 0,15 s.
- Solução de fundo: velocidade da emulação no navegador (ver seção de desempenho). Com a emulação em tempo real o chiado some.
- WAV do jingle (Node, 150–420 M instruções): docs gerado em bios-jingle.wav.

## Gargalos medidos para 60 fps (página)
- Menu e jogo: já acima de 400 quadros/s (o atalho de ociosidade funciona). Não é o gargalo.
- Boot do BIOS: ~690 M instruções até o menu. A página emula ~45–60 MIPS, então o boot leva ~15–20 s. Os laços de espera do BIOS fazem trabalho real (a variável de pilha conta 0..4 e é escrita a cada volta), então não são ociosos e não podem ser pulados sem mudar o boot. Aumentar o divisor de timers não ajuda (testado: 8 → 687 M, 32 → 841 M, 128 → não converge).
- Bugs de contabilidade de áudio corrigidos: o worklet informava o consumo tarde e contava silêncio como consumido; a página enviava silêncio do anel vazio como se fosse som. Agora o nível do colchão reflete só amostras reais.
- Resultado real: colchão ~56 ms e ~8000 underruns por minuto durante o boot nesta máquina. Esses underruns são o chiado.
- Próximo passo para 60 fps no boot: encadear blocos do JIT (sucessor direto) e reduzir o custo de despacho por instrução. Meta: 2–3x MIPS. Exige verificação de equivalência byte a byte (assinaturas) a cada etapa.
- Ferramentas: tools/boot-progress-test.cjs (tempo até o menu), tools/boot-audio-level-test.cjs (tempo de emulação por quadro, paradas por áudio, nível real).

## Correções aplicadas (versão enviada pelo usuário) — validadas
- spu.js: FIX 1 (reset completo do decodificador no laço tone 2), FIX 2 (pré-enchimento das duas metades do FIFO), FIX 3 (incremento de fase em Q16 sem Math.floor acumulado), FIX 4 (marcador de fim 0xFFFF só no início da palavra em IMA/ADPCM36), FIX 5 (taxa de áudio derivada de io.frameLen), FIX 6 (fiqEnable uint32), FIX 7 (contador de eventos de underrun).
- cpu.js: removida dupla contagem de cycles em stepSlow (causava desalinhamento áudio/vídeo).
- idle.js: pulo ocioso soma cycles (sincroniza o áudio com o vídeo). Muda a assinatura determinística do jogo.
- io.js: fast path do pendingList; batching de spu.sync (8192 instr).
- jit.js: MAXLEN 128. Verificado: JIT ligado e desligado dão a mesma assinatura no boot (3cb8390ce304) e no jogo (94e8ca1c6f05).
- hyperscan.js: chunk 1024; window.hs (diagnóstico) removido.
- Velocidade: jogo 72 quadros/s em Node. Note que instr/quadro agora inclui o pulo ocioso.
- Som: cursor 0,39 e Start 0,25 no Spider-Man. O sinal do BIOS continua tonal (139 Hz, correlação 0,84); a escolha de formato ainda depende da audição dos WAVs.

## Desempenho na fase (medições desta rodada)
- Trabalho real na fase: ~412 mil instruções por quadro (tools/real-work.mjs). Com 1,09 M de ociosidade pulada, o total de 1,5 M é o que o MIPS mostra. Por isso o MIPS exibido não mede trabalho real.
- JIT na fase: 0 invalidações de página, traduções caem para perto de zero em regime (tools/jit-pixels.mjs). A imagem é idêntica com JIT ligado e desligado.
- Renderizador: caminho rápido também para camadas de caracteres (2/4/8 bpp), verificado contra a referência em 60 quadros de jogo (tools/ppu-long.mjs). Ganho medido pequeno (~0 a 1 ms por quadro).
- Desenho desacoplado da emulação: a página pula desenhos quando copiar a imagem excede o orçamento de quadro (drawMs > 6 ms reduz a taxa de desenho). A emulação segue o áudio, sem mudança na lógica do jogo.
- Hipótese para o celular: o custo por quadro é copiar a imagem (renderTo + putImageData). A medição de fase no celular não foi feita aqui.
- Faixas de ruído na tela de jogo: não reproduzidas. JIT on/off e PPU otimizado batem com a referência. Precisa de quadro específico para investigar.

## Save states (salve de jogo)
- src/savestate.js: serializa o estado completo (CPU, RAM, IO, timers, PPU, I2C, pad, SPU com canais/FIFO/anel, servo) em arquivo .hsstate (gzip). Caches de JIT e hooks são reconstruídos ao carregar.
- Verificado (tools/savestate-test.mjs): salvar na fase, continuar 300 quadros, carregar numa máquina nova e rodar 300 quadros dá o mesmo hash de estado (36e62fa6fb65). Execução idêntica.
- Página: botões "Salvar estado" e "Carregar estado" em Ferramentas (tools/savestate-page-test.cjs: download, carga e sem erros JS).
- Tamanho: ~1,3 a 4,5 MB comprimido, dependendo da RAM usada. Save ~0,5 s, load ~0,3 s.
- Limitações: o estado só carrega com o mesmo BIOS e o mesmo disco inserido. O áudio em reprodução é reiniciado no carregamento.

## Cache do BIOS e ajuda
- O BIOS é guardado no IndexedDB do navegador (banco "hyperscan", chave "bios"). Discos e saves nunca são guardados pelo emulador.
- Ao abrir a página o BIOS lembrado é restaurado e o botão Rodar já fica habilitado. ⚙ → Arquivos → "Esquecer BIOS" apaga o cache.
- Guia "Como usar o HyperScan" (modal): acessível pela tela inicial ("Como usar o emulador"), pelo painel (⚙ → Ajuda), fecha com Esc ou clicando fora. Cobre primeiros passos, controles (toque e teclado), trocar botões, salvar estado, dicas e privacidade.
- Testes: tools/help-bios-test.cjs (cache sobrevive ao recarregar, disco não é lembrado, ajuda abre/fecha, esquecer apaga) e tools/help-screenshot.cjs.

## Visual do controle (estilo do controle original)
- Start e Select: pílulas vermelhas, com o rótulo em maiúsculas (formato da legenda do próprio jogo).
- Verde e Vermelho: quadrados arredondados nas cores da legenda (verde e vermelho).
- Amarelo e Azul: cores de referência, NÃO confirmadas pelas capturas. Posições dos quatro botões de cor: losango, também não confirmado (a legenda sugere verde embaixo à direita e vermelho embaixo à esquerda).
- Para fechar o layout: enviar uma foto frontal do controle original, com os botões de cor e as posições.
- Mapeamento de entrada inalterado.

## Layout do controle (conforme a foto do controle original)
- Esquerda: analógico (VR de X/Y), arrastável na tela. Substitui o D-pad de setas, que não existe no controle físico. As setas do teclado continuam funcionando.
- Direita: losango de botões de cor: Vermelho em cima, Amarelo à esquerda, Azul à direita, Verde embaixo (mapeamento por cor, inalterado).
- Centro superior: START em cima e SELECT embaixo, empilhados.
- Ombros: um L à esquerda e um R à direita. Não há LT e RT no controle físico, então eles saem da tela (as teclas q/w continuam mapeadas no teclado, sem efeito no controle físico).
- Testes: tools/photo-layout-test.cjs (21 verificações de posição, analógico e botões), tools/ui-test.cjs e tools/fullscreen-test.cjs (adaptados para o analógico). Interface: 15 de 16, com a falha conhecida do mouse; tela cheia 13 de 13; multitoque ok.
- Assinatura do boot inalterada (3cb8390ce304).
