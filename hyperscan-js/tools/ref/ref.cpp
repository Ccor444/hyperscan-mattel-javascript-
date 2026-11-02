#include <cstdio>
#include <cstdlib>
#include <memory>
#include "hyperscan/cpu.h"
#include "hyperscan/io/io.h"
#include "hyperscan/memory/arraymemoryregion.h"
#include "hyperscan/disasm.h"
#include <string>
std::string debugger_get_alias(uint32_t) { return ""; }
using namespace hyperscan;
int main(int argc, char** argv) {
  CPU cpu;
  cpu.miu = std::make_shared<memory::SegmentedMemoryRegion<8, 24>>();
  auto fw = std::make_shared<memory::ArrayMemoryRegion<24>>();
  FILE* f = fopen("/mnt/user-data/uploads/hyperscan.bin","rb"); size_t n = fread(fw->memory.data(),1,1<<24,f); fclose(f);
  auto dram = std::make_shared<memory::ArrayMemoryRegion<24>>();
  auto mmio = std::make_shared<io::IOMemoryRegion>();
  cpu.miu->setRegion(0x9E, fw); cpu.miu->setRegion(0x9F, fw);
  cpu.miu->setRegion(0x80, dram); cpu.miu->setRegion(0xA0, dram);
  cpu.miu->setRegion(0x08, mmio); cpu.miu->setRegion(0x88, mmio);
  cpu.cr29 = 0x20000000; cpu.pc = 0x9F000000;
  long N = atol(argv[1]); long every = argc > 2 ? atol(argv[2]) : 0;
  for (long i = 0; i < N; i++) { if (every && i % every == 0) printf("PC %lu %08x\n", i, cpu.pc); cpu.step(); }
  if (argc > 4) { uint32_t a = strtoul(argv[3],0,16), e = strtoul(argv[4],0,16);
    while (a < e) { CPU::InstructionDecoder ins = cpu.miu->readU32(a - (a & 2)); printf("%08x: ", a);
      if (ins.p0 && !(a&2)) { disasm32((ins.high << 15) | ins.low, a); a += 4; } else { disasm16((a & 2) ? ins.high : ins.low, a); a += 2; } printf("\n"); } }
  printf("\nFINAL pc=%08x r4=%08x r8=%08x r9=%08x\n", cpu.pc, cpu.r4, cpu.r8, cpu.r9);
}
