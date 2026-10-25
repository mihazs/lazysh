#ifndef LAZYSH_PARAKEET_BRIDGE_H
#define LAZYSH_PARAKEET_BRIDGE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
#define LAZYSH_NOEXCEPT noexcept
extern "C" {
#else
#define LAZYSH_NOEXCEPT
#endif
typedef struct LazyshParakeet LazyshParakeet;
enum { LAZYSH_PARAKEET_OK = 0, LAZYSH_PARAKEET_INVALID = 1,
       LAZYSH_PARAKEET_LIBRARY = 2, LAZYSH_PARAKEET_OUTPUT_LIMIT = 3 };
const char *lazysh_parakeet_version(void) LAZYSH_NOEXCEPT;
int lazysh_parakeet_create(const char *encoder, const char *decoder,
                          const char *joiner, const char *tokens,
                          LazyshParakeet **out) LAZYSH_NOEXCEPT;
int lazysh_parakeet_transcribe(LazyshParakeet *engine, const float *samples,
                              int32_t count, char *out, size_t capacity,
                              size_t *written) LAZYSH_NOEXCEPT;
void lazysh_parakeet_destroy(LazyshParakeet *engine) LAZYSH_NOEXCEPT;
#ifdef __cplusplus
}
#endif
#endif
