#include "raw_native.h"
#include "libraw/libraw.h"
#include <cstdio>
#include <memory>
#include <stdexcept>
#include <string>

static thread_local std::string error_message;
extern "C" const char *dichroic_raw_error() { return error_message.c_str(); }

extern "C" int32_t dichroic_raw_decode(const char *source, const char *output, DichroicRawInfo *info) {
    try {
        if (!source || !output || !info) throw std::runtime_error("RAW paths are missing");
        LibRaw raw;
        // Same options and LibRaw 0.22.1 as libraw-wasm 1.6.0. Retain dcraw's
        // encoded 16-bit codes; the shared TS inverse curve restores linear
        // ACES2065-1 without an alternate RAW color treatment.
        raw.imgdata.params.output_color = 6;
        raw.imgdata.params.output_bps = 16;
        raw.imgdata.params.no_auto_bright = 1;
        raw.imgdata.params.use_camera_wb = 1;
        raw.imgdata.params.gamm[0] = 0.45;
        raw.imgdata.params.gamm[1] = 4.5;
        raw.imgdata.params.output_tiff = 0;
        raw.imgdata.params.output_flags = 0;
        raw.imgdata.rawparams.max_raw_memory_mb = 768;
        auto check = [](int status) { if (status != LIBRAW_SUCCESS) throw std::runtime_error(libraw_strerror(status)); };
        check(raw.open_file(source));
        const uint64_t pixels = uint64_t(raw.imgdata.sizes.width) * raw.imgdata.sizes.height;
        if (!pixels || pixels > 50'000'000) throw std::runtime_error("Open a RAW photo of 50 MP or less");
        check(raw.unpack()); check(raw.dcraw_process());
        int width, height, colors, bits;
        raw.get_mem_image_format(&width, &height, &colors, &bits);
        if (bits != 16 || (colors != 1 && colors != 3)) throw std::runtime_error("LibRaw did not return a 16-bit bitmap");
        // LibRaw's PPM writer applies the identical curve/orientation per row.
        // Avoid dcraw_make_mem_image's additional 6-byte-per-pixel heap copy.
        check(raw.dcraw_ppm_tiff_writer(output));
        std::unique_ptr<FILE, decltype(&fclose)> file(fopen(output, "rb"), &fclose);
        char magic[3]{}; unsigned stored_width = 0, stored_height = 0, maximum = 0;
        if (!file || fscanf(file.get(), "%2s\n%u %u\n%u", magic, &stored_width, &stored_height, &maximum) != 4 ||
            fgetc(file.get()) != '\n' || stored_width != unsigned(width) || stored_height != unsigned(height) || maximum != 65535 ||
            magic[0] != 'P' || magic[1] != (colors == 3 ? '6' : '5')) throw std::runtime_error("Invalid RAW pixel file");
        const auto offset = ftell(file.get());
        if (offset < 0 || fseek(file.get(), 0, SEEK_END) || uint64_t(ftell(file.get())) != uint64_t(offset) + uint64_t(width) * height * colors * 2)
            throw std::runtime_error("RAW pixel file is truncated");
        *info = {uint32_t(width), uint32_t(height), uint32_t(colors), uint32_t(bits), uint32_t(offset), raw.imgdata.other.iso_speed,
            raw.imgdata.other.shutter, raw.imgdata.other.aperture, raw.imgdata.other.focal_len, double(raw.imgdata.other.timestamp)};
        error_message.clear(); return 0;
    } catch (const std::exception &error) { error_message = error.what(); }
      catch (...) { error_message = "Native RAW decoder failed"; }
    if (output) std::remove(output);
    return -1;
}
