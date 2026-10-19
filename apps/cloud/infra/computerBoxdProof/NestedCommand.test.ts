import { describe, expect, it } from "@effect/vitest";
import type { KernelCommand } from "../../src/kernel/KernelCommandForwarder.ts";
import {
  captureNestedForwarding,
  NESTED_NATIVE_SCRIPT,
  nestedProofEscalation,
} from "./NestedCommand.ts";
import { PROOF_COMMAND } from "./Command.ts";

const nativeCommand = (): KernelCommand => ({
  executable: "/bin/sh",
  argv: ["/bin/sh", "-c", NESTED_NATIVE_SCRIPT, "nested sh identity"],
  cwd: "/workspace",
  env: { ...PROOF_COMMAND.env, PROOF_ROOT_ARGV0: "custom argv0" },
});
const signal = new AbortController().signal;

describe("nested proof admission evidence", () => {
  it("keeps the root isolate command local and forwards the literal native shell envelope", () => {
    const table = nestedProofEscalation();
    expect(table.decide(PROOF_COMMAND)).toEqual({ kind: "isolate" });
    expect(table.decide(nativeCommand())).toEqual({
      kind: "machine",
      ruleId: "proof-nested-native-shell",
    });
    expect(
      table.decide({ ...nativeCommand(), argv: ["/bin/sh", "-c", "printf unrelated"] }),
    ).toEqual({ kind: "isolate" });
  });

  it("snapshots raw admission evidence and rejects a second physical forward before dispatch", async () => {
    let starts = 0;
    const capture = captureNestedForwarding({
      spawn: async () => {
        starts++;
        throw new Error("stand-in machine stopped");
      },
    });
    const command = nativeCommand();
    await expect(capture.machine.spawn(command, signal)).rejects.toThrow(
      "stand-in machine stopped",
    );
    Reflect.set(command.argv, 0, "changed");
    Reflect.set(command.env, "EXACT", "changed");
    expect(capture.diagnostics()).toEqual({
      nestedMachineForwardExactlyOnce: true,
      nestedRawArgvAndShIdentity: true,
      nestedRawCwdAndEnvironment: true,
    });
    expect(() => capture.machine.spawn(nativeCommand(), signal)).toThrow("command replay");
    expect(starts).toBe(1);
    expect(capture.diagnostics().nestedMachineForwardExactlyOnce).toBe(false);
  });
});
