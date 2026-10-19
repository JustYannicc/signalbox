import type { StandardProofNativeFileRead } from "./standardProofEvidence.ts";

/** The pinned release wraps its tool command in setup and a cwd-file write. */
export function matchesClaudeNativeFileRead(
  read: StandardProofNativeFileRead | undefined,
  command: string,
): boolean {
  if (read?.executable !== "/bin/bash" || read.argv[0] !== "/bin/bash") return false;
  if (!/^cat \/[A-Za-z0-9/._-]+$/.test(command)) return false;
  const script = read.argv.at(-1);
  if (script === undefined) return false;
  const snapshot =
    /^source (\/home\/claude\/\.claude\/shell-snapshots\/snapshot-bash-[0-9]+-[a-z0-9]+\.sh) 2>\/dev\/null \|\| true && /.exec(
      script,
    );
  if (snapshot === null) {
    if (read.argv.length !== 4 || read.argv[1] !== "-c" || read.argv[2] !== "-l") return false;
  } else if (read.argv.length !== 3 || read.argv[1] !== "-c") {
    return false;
  }
  const cwd = / && pwd -P >\| (\/tmp\/claude-[a-f0-9]+-cwd)$/.exec(script);
  if (cwd === null) return false;
  const expected =
    (snapshot?.[0] ?? "") +
    "shopt -u extglob 2>/dev/null || true && " +
    "{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && " +
    `eval '${command}' < /dev/null && pwd -P >| ${cwd[1]}`;
  return script === expected;
}
