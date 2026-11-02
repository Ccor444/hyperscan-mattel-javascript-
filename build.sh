#!/bin/sh
# Compila o núcleo WASM sem Emscripten, usando o wasi-sdk (https://github.com/WebAssembly/wasi-sdk/releases).
# uso: WASI_SDK=/caminho/wasi-sdk-25.0-x86_64-linux ./build.sh   ->  wasm/hyperscan.wasm
set -e
cd "$(dirname "$0")"
: "${WASI_SDK:?defina WASI_SDK com a pasta do wasi-sdk}"
mkdir -p build wasm
for f in Bus SCore7 Jit Disc IO SPU PPU Servo CDHLE HyperScan State capi; do
  "$WASI_SDK/bin/clang++" --sysroot="$WASI_SDK/share/wasi-sysroot" --target=wasm32-wasi -std=c++20 -O3 -fno-exceptions -Iinclude -Wall -Wextra -Wno-unused-parameter -c src/$f.cpp -o build/$f.o
done
"$WASI_SDK/bin/clang++" --sysroot="$WASI_SDK/share/wasi-sysroot" --target=wasm32-wasi -mexec-model=reactor -O3 -fno-exceptions \
  -Wl,--no-entry -Wl,--initial-memory=67108864 -Wl,--max-memory=2147483648 -Wl,--export-memory -Wl,--export-table -Wl,--growable-table -Wl,-z,stack-size=1048576 -Wl,--strip-all \
  build/*.o -o wasm/hyperscan.wasm
ls -l wasm/hyperscan.wasm
