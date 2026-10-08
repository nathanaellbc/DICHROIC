#include "raw_native.h"
#include <cstdio>
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    DichroicRawInfo info{};
    if (dichroic_raw_decode(argv[1], argv[2], &info)) {
        std::fprintf(stderr, "%s\n", dichroic_raw_error()); return 1;
    }
    std::printf("{\"width\":%u,\"height\":%u,\"channels\":%u,\"bits\":%u,\"offset\":%u}\n", info.width, info.height, info.channels, info.bits, info.byte_offset);
}
