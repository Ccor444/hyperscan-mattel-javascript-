cmake_minimum_required(VERSION 3.20)
project(hyperscan CXX)
# Núcleo WASM sem Embind: exporta a API C de src/capi.cpp e gera wasm/hyperscan.wasm (carregado por wasm/hyperscan-wasm.js).
#  wasi-sdk : cmake -B build -DCMAKE_TOOLCHAIN_FILE=$WASI_SDK/share/cmake/wasi-sdk.cmake && cmake --build build   (testado via build.sh)
#  Emscripten: emcmake cmake -B build && cmake --build build                                                      (NÃO testado)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_executable(hyperscan src/Bus.cpp src/SCore7.cpp src/Jit.cpp src/Disc.cpp src/IO.cpp src/SPU.cpp src/PPU.cpp src/Servo.cpp
  src/CDHLE.cpp src/HyperScan.cpp src/State.cpp src/capi.cpp)
target_include_directories(hyperscan PRIVATE include)
target_compile_options(hyperscan PRIVATE -O3 -fno-exceptions -Wall -Wextra -Wno-unused-parameter)
if(EMSCRIPTEN)
  target_link_options(hyperscan PRIVATE -O3 -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=2048MB
    -sSTACK_SIZE=1MB --no-entry -sEXPORT_ALL=1)
else()
  target_link_options(hyperscan PRIVATE -mexec-model=reactor -Wl,--no-entry -Wl,--initial-memory=67108864 -Wl,--max-memory=2147483648
    -Wl,--export-memory -Wl,--export-table -Wl,--growable-table -Wl,-z,stack-size=1048576 -Wl,--strip-all)
endif()
set_target_properties(hyperscan PROPERTIES SUFFIX ".wasm" RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/wasm")
