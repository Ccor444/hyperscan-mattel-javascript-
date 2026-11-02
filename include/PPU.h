#pragma once
#include <cstdint>

namespace hyperscan {

class IO;
class Bus;

// Dimensões atuais (via TV encoder, ou fallback para P_PPU_Control).
void ppuSize(IO& io, int& w, int& h);

// Renderiza um quadro em RGBA (out: w*h*4 bytes, little-endian). Devolve `true`
// se pelo menos uma camada desenhou algo — útil para diagnóstico.
bool renderPPU(IO& io, Bus& bus, uint8_t* out);

} // namespace hyperscan
