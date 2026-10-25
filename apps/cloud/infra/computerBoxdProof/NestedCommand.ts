import type {
  KernelCommand,
  KernelCommandForwarder,
} from "../../src/kernel/KernelCommandForwarder.ts";
import { ComputerEscalationTable } from "../../src/computer/EscalationTable.ts";
import { PROOF_COMMAND } from "./Command.ts";

export const NESTED_PRIOR_FILE = new TextEncoder().encode("root-before-native\n");
const PYTHON = String.raw`import os, pathlib, sys
assert sys.argv[1] == "nested sh identity"
assert os.getcwd() == "/workspace"
assert os.environ["EMPTY"] == ""
assert os.environ["EXACT"] == "雪"
assert os.environ["PROOF_ROOT_ARGV0"] == "custom argv0"
assert pathlib.Path("out.bin").read_bytes() == b"root-before-native\n"
assert sys.stdin.buffer.read() == "input 雪\n".encode()
pathlib.Path("out.bin").write_bytes(bytes([0, 255, 65, 66]))
sys.stdout.buffer.write(bytes([0, 255]) + "custom argv0|/workspace|雪|input 雪".encode())
sys.stderr.buffer.write(bytes([128, 0]))
sys.exit(17)`;
export const NESTED_NATIVE_SCRIPT = `exec /usr/bin/python3 -c '${PYTHON}' "$0"`;

/** The root only uses builtins. Its one external command must cross generic admission. */
export const NESTED_PROOF_COMMAND: KernelCommand = Object.freeze({
  ...PROOF_COMMAND,
  argv: Object.freeze([
    "custom argv0",
    "--noprofile",
    "--norc",
    "-c",
    String.raw`IFS= read -r input || exit 92
export PROOF_ROOT_ARGV0="$0"
printf 'root-before-native\n' > out.bin
printf '%s\n' "$input" | /bin/sh -c '` +
      NESTED_NATIVE_SCRIPT.replaceAll("'", "'\\''") +
      String.raw`' 'nested sh identity'
status=$?
[[ $status == 17 ]] || exit 93
exec 3<out.bin
IFS= read -r -d '' zero <&3 || exit 94
IFS= read -r -N 3 tail <&3 || exit 95
exec 3<&-
[[ -z "$zero" && "$tail" == $'\377AB' ]] || exit 96
exit "$status"`,
  ]),
});

export function nestedProofEscalation() {
  return new ComputerEscalationTable([
    {
      id: "proof-nested-native-shell",
      executable: "/bin/sh",
      argvPrefix: ["-c", NESTED_NATIVE_SCRIPT],
    },
  ]);
}

/** Raw command capture stays in this owner. Receipts expose checks, never environment values. */
export function captureNestedForwarding(machine: KernelCommandForwarder) {
  const captures: KernelCommand[] = [];
  return {
    machine: {
      spawn: (command, signal) => {
        captures.push(
          Object.freeze({
            executable: command.executable,
            argv: Object.freeze([...command.argv]),
            cwd: command.cwd,
            env: Object.freeze({ ...command.env }),
          }),
        );
        if (captures.length !== 1) throw new Error("Nested proof attempted a command replay");
        return machine.spawn(command, signal);
      },
    } satisfies KernelCommandForwarder,
    diagnostics() {
      const command = captures[0];
      return Object.freeze({
        nestedMachineForwardExactlyOnce: captures.length === 1,
        nestedRawArgvAndShIdentity:
          command?.executable === "/bin/sh" &&
          JSON.stringify(command.argv) ===
            JSON.stringify(["/bin/sh", "-c", NESTED_NATIVE_SCRIPT, "nested sh identity"]),
        nestedRawCwdAndEnvironment:
          command?.cwd === "/workspace" &&
          command.env.HOME === "/workspace" &&
          command.env.PATH === "/bin:/usr/bin" &&
          command.env.PWD === "/workspace" &&
          command.env.EMPTY === "" &&
          command.env.EXACT === "雪" &&
          command.env.PROOF_ROOT_ARGV0 === "custom argv0",
      });
    },
  };
}
