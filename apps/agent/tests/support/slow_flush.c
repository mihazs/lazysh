/* Test-only LD_PRELOAD simulation of a slow shared durable volume: every
 * fsync/fdatasync waits LAZYSH_TEST_SLOW_FLUSH_MS while holding an exclusive
 * flock on LAZYSH_TEST_SLOW_FLUSH_LOCK, so flushes from every thread and
 * process queue behind each other, as NTFS log commits do. Data is unchanged. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <sys/file.h>
#include <time.h>
#include <unistd.h>

static void queue_behind_other_flushes(void) {
  const char *delay = getenv("LAZYSH_TEST_SLOW_FLUSH_MS");
  const char *path = getenv("LAZYSH_TEST_SLOW_FLUSH_LOCK");
  if (!delay || !path) return;
  int lock = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
  if (lock < 0 || flock(lock, LOCK_EX) != 0) abort();
  long ms = atol(delay);
  struct timespec wait = {ms / 1000, (ms % 1000) * 1000000L};
  while (nanosleep(&wait, &wait) != 0) {}
  close(lock);
}

int fsync(int fd) {
  static int (*real)(int);
  if (!real) real = (int (*)(int))dlsym(RTLD_NEXT, "fsync");
  queue_behind_other_flushes();
  return real(fd);
}

int fdatasync(int fd) {
  static int (*real)(int);
  if (!real) real = (int (*)(int))dlsym(RTLD_NEXT, "fdatasync");
  queue_behind_other_flushes();
  return real(fd);
}
