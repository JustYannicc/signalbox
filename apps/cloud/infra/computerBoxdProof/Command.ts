import type { KernelCommand, KernelCommandChild } from "../../src/kernel/KernelCommandForwarder.ts";

export const INITIAL_FILE = new Uint8Array([1, 2, 3, 4]);
export const RESULT_FILE = new Uint8Array([0, 255, 65, 66]);
export const PROOF_COMMAND: KernelCommand = Object.freeze({
  executable: "/bin/bash",
  argv: Object.freeze([
    "custom argv0",
    "--noprofile",
    "--norc",
    "-c",
    String.raw`IFS= read -r input
[[ "$EMPTY" == "" ]] || exit 91
printf '\000\377AB' > out.bin
printf '\000\377%s|%s|%s|%s' "$0" "$PWD" "$EXACT" "$input"
printf '\200\000' >&2
exit 17`,
  ]),
  cwd: "/workspace",
  env: Object.freeze({
    HOME: "/workspace",
    PATH: "/bin:/usr/bin",
    PWD: "/workspace",
    EMPTY: "",
    EXACT: "雪",
  }),
});
export const EXPECTED_STDOUT = new Uint8Array([
  0,
  255,
  ...new TextEncoder().encode("custom argv0|/workspace|雪|input 雪"),
]);

export async function runProofCommand(child: KernelCommandChild) {
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    for await (const bytes of stream) chunks.push(bytes.slice());
    const result = new Uint8Array(chunks.reduce((size, bytes) => size + bytes.length, 0));
    let offset = 0;
    for (const bytes of chunks) {
      result.set(bytes, offset);
      offset += bytes.length;
    }
    return result;
  };
  const stdout = read(child.stdout);
  const stderr = read(child.stderr);
  void stdout.catch(() => undefined);
  void stderr.catch(() => undefined);
  try {
    const input = child.stdin.getWriter();
    await input.write(new TextEncoder().encode("input 雪\n"));
    await input.close();
    input.releaseLock();
    const [out, err, exit] = await Promise.all([stdout, stderr, child.exited]);
    if (
      !sameBytes(out, EXPECTED_STDOUT) ||
      !sameBytes(err, new Uint8Array([128, 0])) ||
      exit.exitCode !== 17 ||
      exit.signal !== 0 ||
      exit.coreDumped
    ) {
      throw new Error(
        "Proof command changed argv0, cwd, env, binary streams, stdin or exit status",
      );
    }
    return { stdout: out, stderr: err, exit };
  } finally {
    await child.dispose();
  }
}

export function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
