import { describe, expect, it } from "vite-plus/test";
import {
  BOXD_PROOF_IDENTITY_COMMANDS,
  measureBoxdProofMachineIdentity,
  type BoxdProofIdentityProbePort,
} from "./Identity.ts";

function machine() {
  return {
    id: "machine-1",
    imageRef: "https://private.invalid/image?token=never-retain",
    resources: { vcpu: 2, memoryBytes: 8_589_934_592, diskBytes: 21_474_836_480 },
    source: { kind: "fork" as const },
  };
}

describe("boxd proof machine identity", () => {
  it("retains exact stdout and measured resources without retaining the raw image reference", async () => {
    const calls: { machineId: string; command: readonly string[]; timeoutMs: number }[] = [];
    const outputs = [
      "Linux 6.12.8 #1 SMP x86_64\n",
      "raw-boxd-host\n",
      'ID=linux\nPRETTY_NAME="Linux"\n',
    ];
    const port: BoxdProofIdentityProbePort = {
      getMachine: async () => machine(),
      exec: async (machineId, command, timeoutMs) => {
        calls.push({ machineId, command, timeoutMs });
        return { exitCode: 0, stdout: outputs[calls.length - 1]!, stderr: "" };
      },
    };

    const identity = await measureBoxdProofMachineIdentity(
      port,
      "machine-1",
      new AbortController().signal,
    );

    expect(identity).toMatchObject({
      sourceKind: "fork",
      resources: { vcpu: 2, memoryBytes: 8_589_934_592, diskBytes: 21_474_836_480 },
      unameSrvm: outputs[0],
      hostname: outputs[1],
      osRelease: outputs[2],
    });
    const expectedDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(machine().imageRef),
    );
    expect(identity.imageRefSha256).toBe(
      Array.from(new Uint8Array(expectedDigest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      ),
    );
    expect(JSON.stringify(identity)).not.toContain("private.invalid");
    expect(JSON.stringify(identity)).not.toContain("never-retain");
    expect(calls).toEqual(
      BOXD_PROOF_IDENTITY_COMMANDS.map((command) => ({
        machineId: "machine-1",
        command,
        timeoutMs: 15_000,
      })),
    );
  });

  it("stops at the first failed command and does not return partial identity", async () => {
    const calls: string[][] = [];
    const port: BoxdProofIdentityProbePort = {
      getMachine: async () => machine(),
      exec: async (_machineId, command) => {
        calls.push([...command]);
        return { exitCode: 127, stdout: "private partial output", stderr: "private error" };
      },
    };

    await expect(
      measureBoxdProofMachineIdentity(port, "machine-1", new AbortController().signal),
    ).rejects.toThrow("Boxd machine identity command failed");
    expect(calls).toEqual([["uname", "-srvm"]]);
  });
});
