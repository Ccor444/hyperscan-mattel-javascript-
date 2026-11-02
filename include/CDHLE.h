#pragma once

namespace hyperscan {

class HyperScan;

// Instala os hooks HLE do driver de CD do BIOS (leitura, TOC, open(NULL), cartões).
// Idempotente: chamadas repetidas apenas re-registram os mesmos endereços.
void installCdHle(HyperScan& machine);

} // namespace hyperscan
