#pragma once
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace hyperscan {

struct DirEntry {
    std::string name;
    uint32_t    lba  = 0;
    uint32_t    size = 0;
    bool        dir  = false;
};

class Disc {
public:
    explicit Disc(std::vector<uint8_t> data);
    ~Disc() = default;

    Disc(const Disc&) = delete;
    Disc& operator=(const Disc&) = delete;
    Disc(Disc&&) = default;

    // Cada setor lógico tem sempre 2048 bytes úteis (independente do formato físico).
    const uint8_t* readSector(uint32_t lba) const;      // 2048 bytes
    std::vector<uint8_t> readSectors(uint32_t lba, uint32_t n) const;

    // Navegação ISO9660
    std::vector<DirEntry> list(const DirEntry& dir) const;
    std::optional<DirEntry> find(const std::string& path) const;
    std::vector<uint8_t> readFile(const std::string& path) const;

    // Estado
    std::vector<uint8_t> data;
    uint32_t sectorSize = 2048;
    uint32_t dataOff    = 0;
    uint32_t sectors    = 0;
    std::string volumeId;
    std::optional<DirEntry> root;
};

} // namespace hyperscan
