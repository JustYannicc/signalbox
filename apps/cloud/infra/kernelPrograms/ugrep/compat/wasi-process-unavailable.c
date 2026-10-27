#include "wasi-process-unavailable.h"

#include <errno.h>
#include <stdlib.h>

/* Preview 1 cannot launch processes, so report the missing capability. */
pid_t fork(void) {
  errno = ENOSYS;
  return (pid_t)-1;
}

int execvp(const char *file, char *const arguments[]) {
  (void)file;
  (void)arguments;
  errno = ENOSYS;
  return -1;
}

int kill(pid_t process, int signal_number) {
  (void)process;
  (void)signal_number;
  errno = ENOSYS;
  return -1;
}

FILE *popen(const char *command, const char *mode) {
  (void)command;
  (void)mode;
  errno = ENOSYS;
  return NULL;
}

int pclose(FILE *stream) {
  (void)stream;
  errno = ENOSYS;
  return -1;
}

int system(const char *command) {
  if (command == NULL) {
    return 0;
  }
  errno = ENOSYS;
  return -1;
}
