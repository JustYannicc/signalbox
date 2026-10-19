import type { createProofAdmittedCommands } from "./AdmittedCommands.ts";
import { INITIAL_FILE, PROOF_COMMAND, sameBytes } from "./Command.ts";

export const LOCAL_CAT_COMMAND = Object.freeze({
  ...PROOF_COMMAND,
  argv: Object.freeze(["local proof root", "--noprofile", "--norc", "-c", "/bin/cat out.bin"]),
});

/** Both shell and external cat must remain local despite the normal cat machine rule. */
export async function runLocalOnlyControl(
  admitted: ReturnType<typeof createProofAdmittedCommands>,
  signal: AbortSignal,
) {
  const before = admitted.snapshot();
  const child = await admitted.commands.isolate.exec(LOCAL_CAT_COMMAND, signal);
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: number[] = [];
    for await (const bytes of stream) chunks.push(...bytes);
    return new Uint8Array(chunks);
  };
  const outputs = Promise.all([read(child.stdout), read(child.stderr), child.exited]);
  void outputs.catch(() => undefined);
  try {
    const input = child.stdin.getWriter();
    await input.close();
    input.releaseLock();
    const [out, err, exit] = await outputs;
    if (
      !sameBytes(out, INITIAL_FILE) ||
      err.length !== 0 ||
      exit.exitCode !== 0 ||
      exit.signal !== 0 ||
      exit.coreDumped
    )
      throw new Error("Local Bash-to-cat control changed its bytes or exit status");
  } finally {
    await child.dispose();
  }
  await admitted.drain();
  let rejected = false;
  try {
    const unsupported = await admitted.commands.isolate.exec(
      {
        ...PROOF_COMMAND,
        executable: "/bin/proof-unsupported",
        argv: ["proof-unsupported"],
      },
      signal,
    );
    await unsupported.dispose();
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "NOT_FOUND"
    )
      throw error;
    rejected = true;
  }
  await admitted.drain();
  const after = admitted.snapshot();
  if (
    !rejected ||
    after.local.rootRequests - before.local.rootRequests !== 2 ||
    after.local.rootClaims - before.local.rootClaims !== 1 ||
    after.local.descendantClaims - before.local.descendantClaims !== 1 ||
    after.local.forwards !== 0 ||
    after.normal.forwards !== 0 ||
    after.fallbackRuns !== 0 ||
    after.active !== 0
  )
    throw new Error("Local-only admission did not retain root and descendant placement");
  return {
    localOnlyRootAndDescendantAdmitted: true,
    localOnlyNormalMachineRuleOverridden:
      admitted.escalation.decide({
        ...PROOF_COMMAND,
        executable: "/bin/cat",
        argv: ["/bin/cat", "out.bin"],
      }).kind === "machine",
    localOnlyUnsupportedRejected: rejected,
    localOnlyZeroForwards: after.local.forwards === 0 && after.normal.forwards === 0,
    localOnlyPhysicalCapacityDrained: after.active === 0,
  };
}
