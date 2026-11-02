#include "Disc.h"
#include <algorithm>
#include <cctype>
#include <cstring>

namespace hyperscan {

static inline uint32_t ld32(const uint8_t* p) { uint32_t v; std::memcpy(&v, p, 4); return v; }

static bool iequals(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i)
        if (std::tolower((unsigned char)a[i]) != std::tolower((unsigned char)b[i])) return false;
    return true;
}

Disc::Disc(std::vector<uint8_t> d) : data(std::move(d)) {
    static const uint8_t sync[12] = {0,255,255,255,255,255,255,255,255,255,255,0};
    bool raw = data.size() >= 12 && std::memcmp(data.data(), sync, 12) == 0;
    sectorSize = raw ? 2352 : 2048;
    if (raw) dataOff = (data[15] == 2) ? 24 : 16;
    sectors = (uint32_t)(data.size() / sectorSize);
    if (sectors >= 17) {
        const uint8_t* pvd = readSector(16);
        if (pvd[1]=='C' && pvd[2]=='D' && pvd[3]=='0' && pvd[4]=='0' && pvd[5]=='1') {
            volumeId.assign((const char*)pvd + 40, 32);
            while (!volumeId.empty() && std::isspace((unsigned char)volumeId.back())) volumeId.pop_back();     // String.trim() do JS
            size_t b = 0; while (b < volumeId.size() && std::isspace((unsigned char)volumeId[b])) ++b;
            volumeId.erase(0, b);
            DirEntry e;
            e.lba = ld32(pvd + 158);
            e.size = ld32(pvd + 166);
            e.dir = true;
            root = e;
        }
    }
}

const uint8_t* Disc::readSector(uint32_t lba) const {
    static const uint8_t kZero[2048] = {0};
    size_t o = (size_t)lba * sectorSize + dataOff;
    if (o + 2048 > data.size()) return kZero;     // fora da imagem (o JS devolveria um subarray curto)
    return data.data() + o;
}

std::vector<uint8_t> Disc::readSectors(uint32_t lba, uint32_t n) const {
    std::vector<uint8_t> out((size_t)n * 2048);
    for (uint32_t i = 0; i < n; ++i)
        std::memcpy(out.data() + (size_t)i * 2048, readSector(lba + i), 2048);
    return out;
}

std::vector<DirEntry> Disc::list(const DirEntry& dir) const {
    auto d = readSectors(dir.lba, (dir.size + 2047) / 2048);
    std::vector<DirEntry> out;
    size_t i = 0, end = dir.size;
    while (i < end && i < d.size()) {
        uint8_t len = d[i];
        if (!len) { i = (i / 2048 + 1) * 2048; continue; }
        if (i + 34 > d.size()) break;
        uint8_t nl = d[i + 32];
        if (i + 33 + nl > d.size()) break;
        std::string name((const char*)&d[i + 33], nl);
        if (nl == 1 && (name[0] == '\0' || name[0] == '\x01')) { i += len; continue; }
        if (name.size() >= 2 && name.substr(name.size() - 2) == ";1") name.resize(name.size() - 2);
        DirEntry e;
        e.name = name;
        e.lba = ld32(&d[i + 2]);
        e.size = ld32(&d[i + 10]);
        e.dir = (d[i + 25] & 2) != 0;
        out.push_back(std::move(e));
        i += len;
    }
    return out;
}

std::optional<DirEntry> Disc::find(const std::string& path) const {
    if (!root) return std::nullopt;
    DirEntry dir = *root;
    std::optional<DirEntry> ent;
    size_t pos = 0;
    while (pos < path.size()) {
        size_t slash = path.find('/', pos);
        if (slash == std::string::npos) slash = path.size();
        std::string part = path.substr(pos, slash - pos);
        pos = slash + 1;
        if (part.empty()) continue;
        auto entries = list(dir);
        bool found = false;
        for (auto& e : entries) {
            if (iequals(e.name, part)) { ent = e; dir = e; found = true; break; }
        }
        if (!found) return std::nullopt;
    }
    return ent;
}

std::vector<uint8_t> Disc::readFile(const std::string& path) const {
    auto e = find(path);
    if (!e) return {};
    auto d = readSectors(e->lba, (e->size + 2047) / 2048);
    d.resize(e->size);
    return d;
}

} // namespace hyperscan
