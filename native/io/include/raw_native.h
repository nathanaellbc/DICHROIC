#ifndef DICHROIC_RAW_NATIVE_H
#define DICHROIC_RAW_NATIVE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct {
    uint32_t width, height, channels, bits, byte_offset;
    double iso, shutter, aperture, focal_length, timestamp;
} DichroicRawInfo;
int32_t dichroic_raw_decode(const char *source, const char *output, DichroicRawInfo *info);
const char *dichroic_raw_error(void);
#ifdef __cplusplus
}
#endif
#endif
