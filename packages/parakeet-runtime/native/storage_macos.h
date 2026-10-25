#ifndef LAZYSH_PARAKEET_STORAGE_MACOS_H
#define LAZYSH_PARAKEET_STORAGE_MACOS_H
#ifdef __cplusplus
extern "C" {
#endif
/* 0: ancestor directory, 1: private directory, 2: private regular file.
 * Zero means admitted. No path is opened and the caller retains its descriptor. */
int lazysh_parakeet_macos_check_fd(int fd, int role);
#ifdef __cplusplus
}
#endif
#endif
