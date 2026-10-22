import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const source = NodeFS.readFileSync(process.argv[2], "utf8");
const wrapper = source.match(/int __wrap_fcntl\(int fd, int cmd, \.\.\.\) \{[\s\S]*?\n\}/)?.[0];
NodeAssert.ok(wrapper, "Patched Nimbus shim must contain the fcntl wrapper");
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bash-fcntl-"));
try {
  const input = NodePath.join(scratch, "fcntl.c");
  const executable = NodePath.join(scratch, "fcntl-test");
  NodeFS.writeFileSync(
    input,
    `
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
static int flags;
int __np_dup(int fd) { return fd + 1; }
int __np_fd_getfd(int fd) { return fd == 29 ? 0 : EBADF; }
int __np_fd_getflags(int fd) { return fd == 29 ? flags : -EBADF; }
int __np_fd_setfd(int fd, int value) {
  if (fd != 29) return -EBADF;
  flags = value & FD_CLOEXEC;
  return 0;
}
${wrapper}
int main(void) {
  assert(__wrap_fcntl(29, F_GETFD) == 0);
  assert(__wrap_fcntl(29, F_SETFD, FD_CLOEXEC) == 0);
  assert(flags == FD_CLOEXEC);
  assert(__wrap_fcntl(29, F_GETFD) == FD_CLOEXEC);
  assert(__wrap_fcntl(29, F_SETFD, 0) == 0);
  assert(__wrap_fcntl(29, F_GETFD) == 0);
  errno = 0;
  assert(__wrap_fcntl(999, F_GETFD) == -1 && errno == EBADF);
  errno = 0;
  assert(__wrap_fcntl(999, F_SETFD, FD_CLOEXEC) == -1 && errno == EBADF);
  return 0;
}
`,
  );
  const compile = NodeChildProcess.spawnSync(
    process.env.CC ?? "cc",
    ["-std=c11", "-Wall", "-Wextra", "-Werror", input, "-o", executable],
    { encoding: "utf8" },
  );
  NodeAssert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
  const result = NodeChildProcess.spawnSync(executable, [], { encoding: "utf8" });
  NodeAssert.equal(result.status, 0, result.error?.message ?? result.stderr);
  console.log("Patched Bash fcntl descriptor flags passed");
} finally {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
}
