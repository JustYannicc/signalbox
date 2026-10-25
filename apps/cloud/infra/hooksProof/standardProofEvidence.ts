import { standardProofFilledWrite, STANDARD_PROOF_WRITE } from "./standardProofAdapter.ts";

export interface StandardProofNativeFileRead {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly stdout: Uint8Array;
}

export const STANDARD_PROOF_WIRE_TEXT = STANDARD_PROOF_WRITE.replace(
  "{{op://proof/item/password}}",
  "{{secret:VAULT_TOKEN}}",
);

export function inspectStandardProofNativeFileRead(
  read: StandardProofNativeFileRead | undefined,
  command: string,
) {
  const expected = new TextEncoder().encode(standardProofFilledWrite());
  const commandMatched =
    read !== undefined && isBashCatCommand(read.executable, read.argv, command);
  const output = read?.stdout;
  return {
    commandMatched,
    outputBytes: output instanceof Uint8Array ? output.byteLength : null,
    expectedBytes: expected.byteLength,
    matchesFilledBytes: output instanceof Uint8Array && sameBytes(output, expected),
  };
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isBashCatCommand(executable: string, argv: readonly string[], command: string): boolean {
  const basename = executable.split("/").at(-1);
  const commandFlag = argv.slice(0, -1).some((argument) => /^-[a-z]*c[a-z]*$/.test(argument));
  return basename === "bash" && argv.at(-1) === command && commandFlag;
}
