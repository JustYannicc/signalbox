#ifndef SIGNALBOX_WASI_PROCESS_UNAVAILABLE_H
#define SIGNALBOX_WASI_PROCESS_UNAVAILABLE_H

#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

pid_t fork(void);
int execvp(const char *file, char *const arguments[]);
int kill(pid_t process, int signal_number);
FILE *popen(const char *command, const char *mode);
int pclose(FILE *stream);

#ifdef __cplusplus
}
#endif

#endif
