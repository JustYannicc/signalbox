import * as Schema from "effect/Schema";

export interface BoxdProofMachineIdentity {
  readonly imageRefSha256: string;
  readonly sourceKind: "image" | "fork" | "snapshot";
  readonly resources: {
    readonly vcpu: number;
    readonly memoryBytes: number;
    readonly diskBytes: number;
  };
  readonly unameSrvm: string;
  readonly hostname: string;
  readonly osRelease: string;
}

export const boxdProofMachineIdentitySchema = Schema.Struct({
  imageRefSha256: Schema.String,
  sourceKind: Schema.Literals(["image", "fork", "snapshot"]),
  resources: Schema.Struct({
    vcpu: Schema.Number,
    memoryBytes: Schema.Number,
    diskBytes: Schema.Number,
  }),
  unameSrvm: Schema.String,
  hostname: Schema.String,
  osRelease: Schema.String,
});

export type BoxdProofMachineIdentityStatus = "pending" | "captured" | "failed";

export type BoxdProofMachineIdentityObservation =
  | { readonly status: "captured"; readonly identity: BoxdProofMachineIdentity }
  | { readonly status: "failed" };

export interface BoxdProofIdentityProbePort {
  readonly getMachine: (
    machineId: string,
    signal: AbortSignal,
  ) => Promise<{
    readonly id: string;
    readonly imageRef: string;
    readonly resources: BoxdProofMachineIdentity["resources"];
    readonly source: { readonly kind: "fork" | "snapshot" } | null;
  }>;
  readonly exec: (
    machineId: string,
    command: readonly string[],
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

export const BOXD_PROOF_IDENTITY_COMMANDS = Object.freeze([
  Object.freeze(["uname", "-srvm"]),
  Object.freeze(["hostname"]),
  Object.freeze(["cat", "/etc/os-release"]),
] as const);

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024;
const MAX_TOTAL_OUTPUT_BYTES = 48 * 1024;

/** Reads the VM identity before the command Runner can set its per-thread hostname. */
export async function measureBoxdProofMachineIdentity(
  port: BoxdProofIdentityProbePort,
  machineId: string,
  signal: AbortSignal,
): Promise<BoxdProofMachineIdentity> {
  signal.throwIfAborted();
  const machine = await port.getMachine(machineId, signal);
  signal.throwIfAborted();
  if (
    machine.id !== machineId ||
    machine.imageRef.length === 0 ||
    !Number.isSafeInteger(machine.resources.vcpu) ||
    machine.resources.vcpu < 1 ||
    !Number.isSafeInteger(machine.resources.memoryBytes) ||
    machine.resources.memoryBytes < 1 ||
    !Number.isSafeInteger(machine.resources.diskBytes) ||
    machine.resources.diskBytes < 1
  ) {
    throw new Error("Boxd machine identity metadata is unavailable");
  }

  const outputs: string[] = [];
  for (const command of BOXD_PROOF_IDENTITY_COMMANDS) {
    signal.throwIfAborted();
    const result = await port.exec(machineId, command, COMMAND_TIMEOUT_MS, signal);
    signal.throwIfAborted();
    const size = new TextEncoder().encode(result.stdout).byteLength;
    if (
      result.exitCode !== 0 ||
      result.stdout.length === 0 ||
      result.stdout.includes("\0") ||
      size > MAX_COMMAND_OUTPUT_BYTES
    ) {
      throw new Error("Boxd machine identity command failed");
    }
    outputs.push(result.stdout);
  }

  if (
    outputs.reduce((total, output) => total + new TextEncoder().encode(output).byteLength, 0) >
    MAX_TOTAL_OUTPUT_BYTES
  ) {
    throw new Error("Boxd machine identity output is too large");
  }

  const imageDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(machine.imageRef),
  );
  signal.throwIfAborted();
  const sourceKind = machine.source?.kind ?? "image";
  if (sourceKind !== "image" && sourceKind !== "fork" && sourceKind !== "snapshot") {
    throw new Error("Boxd machine source identity is unavailable");
  }

  return Object.freeze({
    imageRefSha256: Array.from(new Uint8Array(imageDigest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    sourceKind,
    resources: Object.freeze({ ...machine.resources }),
    unameSrvm: outputs[0]!,
    hostname: outputs[1]!,
    osRelease: outputs[2]!,
  });
}
