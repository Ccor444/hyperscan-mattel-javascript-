# HyperScan WASM

Migração do emulador `hyperscan-js` para C++ → WebAssembly. Mesma interface (`index.html`), núcleo em `wasm/hyperscan.wasm`.

## Uso
    python3 -m http.server      # abrir index.html (módulos ES não carregam por file://)
`wasm/hyperscan.wasm` já vem compilado. Para recompilar: `WASI_SDK=/caminho/wasi-sdk-25.0-x86_64-linux ./build.sh`
(wasi-sdk: https://github.com/WebAssembly/wasi-sdk/releases) ou CMake (o caminho Emscripten não foi testado).

## Estrutura
- `src/*.cpp`, `include/*.h`: núcleo (CPU S+core7, Bus, IO, SPU, PPU, Servo, Disc, CDHLE, idle/fastpaths, save state). `src/capi.cpp` = API C exportada.
- `wasm/hyperscan-wasm.js`: carregador; classe `HyperScan` com API parecida com a do JS (`create`, `insertDisc`, `run`, `renderTo`, `setPad`, `pullAudio`, `saveState/loadState`...).
- `tests/`: testes diferenciais contra o JS original (`node tests/cpufuzz.mjs` etc.); copie a pasta `src/` do projeto JS para `tests/jsref/`.

## Diferenças em relação ao JS
- Save states têm formato novo (binário "HSST" v2 + gzip): `.hsstate` antigos do JS não carregam.
- Sem JIT/caches de decodificação: o interpretador C++ lê a RAM a cada instrução.
- Camada de caracteres do PPU segue o caminho "lento" do JS (= MAME). O atalho rápido do JS desenhava errado tiles mais estreitos que a palavra de pixels (ex.: 2 bpp com tile 8 px).
- Executar além do fim do BIOS (>1 MiB): o JS reaproveitava cache de outro endereço; aqui lê zeros.

## JIT para WebAssembly (desempenho)
O interpretador C++ roda ~100 MIPS (o jogo precisa de ~90 M ciclos/s). Para ter folga, blocos quentes da CPU são traduzidos
em funções WebAssembly em tempo de execução (`src/Jit.cpp`):
- o C++ gera os bytes do módulo; o loader (`wasm/hyperscan-wasm.js`) compila e instala as funções na tabela indireta
  (`--export-table --growable-table`); `runN` chama o bloco por `call_indirect`;
- superblocos (seguem saltos e desvios para frente com saída lateral), laços internos com orçamento de instruções,
  registradores/flags em locais wasm, eliminação de flags mortas, pares "paralelos" traduzidos com `if (T)`;
- acessos à RAM inline; E/S, BIOS e instruções raras (cr/rte, pares com saltos) chamam o interpretador/barramento;
- escrita em página de código invalida os blocos (flags por página de 1 KiB no `Bus`; CDHLE e load state também invalidam);
- contagem de instruções/ciclos **exata** (mesmo resultado com JIT ligado ou desligado, qualquer tamanho de `run(n)`).
- Compilação síncrona (Node/Worker). Na thread principal do Chrome (limite de 4 KB) módulos maiores usam o caminho assíncrono.
- Opções: `HyperScan.create(bios, { jit: false, jitThreshold: 20, jitSync: true })`; `hs.jitStats()`, `hs.jitFallbacks()`.

Medido com BIOS+Spider-Man reais (Node): 2 bi de instruções idênticas ao JS (regs, PC, ciclos, UART, quadro, áudio) em 8,1 s
(JS puro 20,9 s; interpretador WASM 19,5 s). Emulação 3–5× mais rápida que o tempo real (antes 1,0–1,3×). No Chromium: 60 fps estáveis.
Testes: `tests/jitfuzz.mjs` (fuzz diferencial com/sem JIT, código em RAM com laços e auto-modificação),
`tests/realboot.mjs`, `tests/realplay.mjs` (BIOS/disco via variáveis `BIOS` e `DISC`), `tests/rt.mjs` (razão tempo real).

## Worker (página)
`index.html` roda o emulador num Web Worker (`emu-worker.js`): compilação síncrona do JIT sem o limite de 4 KB da thread principal,
página e áudio não travam. O worker alimenta o AudioWorklet por uma `MessageChannel` própria e se pace pelo consumo do áudio
(ou por 59,94 quadros/s de parede se não houver áudio). Se o navegador não abrir o Worker, use `index-mainthread.html` (versão sem Worker).
Teste: `tests/realsmoke.cjs` / `realsmoke2.cjs` (Playwright, BIOS e disco reais em `/home/claude/game`).

## Renderização (PPU)
`renderPPU` usa tabelas RGB565/ARGB1555→RGBA, recorte por linha/ladrilho e cópia direta do buffer da TV (antes: um lambda por pixel).
Quadro 640x480 do menu: 2,3 ms → 1,7 ms. A página transfere o canvas ao worker (`OffscreenCanvas`), então renderizar e desenhar
não ocupam a thread principal. Bit-exato: `tests/ppufuzz.mjs` (300 sementes contra o caminho de referência do JS) e quadros reais idênticos.

## Sessões longas
Slots da tabela de funções de blocos invalidados/descartados são reaproveitados (`hs_jit_free_slot`) e, se o código se reescrever
sem parar (>100 mil registros), o JIT recomeça do zero. `tests/jittable.mjs`: 9,4 mil blocos instalados e 8 mil invalidações
mantiveram a tabela em ~1,4 mil entradas.
