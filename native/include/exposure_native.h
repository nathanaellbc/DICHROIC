#ifndef EXPOSURE_NATIVE_H
#define EXPOSURE_NATIVE_H
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif

void *dichroic_gpu_create(uint64_t memory_budget);
const char *dichroic_gpu_execute(void *handle, const char *descriptor);
int32_t dichroic_gpu_upload(void *handle, uint64_t buffer_id, uint64_t offset, const uint8_t *bytes, size_t length);
int32_t dichroic_gpu_read(void *handle, uint64_t buffer_id, uint64_t offset, uint8_t *output, size_t length);
void dichroic_gpu_destroy(void *handle);
int32_t dichroic_source_box(const uint8_t *bytes, size_t length, const float *lookup, size_t lookup_length,
    const char *descriptor, float *output, size_t output_length);
/* All operations are serialized by the caller. Errors never cross the ABI. */
void *exposure_create(void);
void exposure_destroy(void *engine);
int32_t exposure_render(void *engine, const uint8_t *rgba, size_t length,
    uint32_t width, uint32_t height, float exposure_ev,
    uint8_t *output, size_t output_length);
int32_t exposure_render_in_place(void *engine, uint8_t *rgba, size_t length,
    uint32_t width, uint32_t height, float exposure_ev);
/* Thread-local; copy immediately, before the next native operation. */
const char *exposure_last_error(void);
#ifdef __cplusplus
}
#endif
#endif
