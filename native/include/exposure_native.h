#ifndef EXPOSURE_NATIVE_H
#define EXPOSURE_NATIVE_H
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
/* All operations are serialized by the caller. Errors never cross the ABI. */
void *exposure_create(void);
void exposure_destroy(void *engine);
int32_t exposure_render(void *engine, const uint8_t *rgba, size_t length,
    uint32_t width, uint32_t height, float exposure_ev,
    uint8_t *output, size_t output_length);
/* Thread-local; copy immediately, before the next native operation. */
const char *exposure_last_error(void);
#ifdef __cplusplus
}
#endif
#endif
