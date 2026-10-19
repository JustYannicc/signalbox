import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelAsyncProgramContext } from "../../kernel/KernelAsyncProgram.ts";
import type { KernelProgramAdmissionRequest } from "../../kernel/KernelProgramAdmission.ts";
import type { KernelProgramImplementation } from "../../kernel/KernelProgramHost.ts";
import { ABI_VERSION, KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildWorkerProgram } from "../ChildWorkerProgram.ts";
import { createComputerProgramAdmission } from "../ComputerProgramAdmission.ts";
import { ComputerEscalationTable } from "../EscalationTable.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

function requestFor(
  context: KernelAsyncProgramContext,
  implementation: KernelProgramImplementation,
): KernelProgramAdmissionRequest {
  const manifest = {
    name: "tool",
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: [],
    entrypoint: "tool",
  };
  const registry = new KernelProgramRegistry();
  registry.register(manifest);
  const resolved = registry.resolve("tool", "1", [ABI_VERSION], {});
  if (resolved.status !== "ok") throw new Error("Could not resolve test program");
  return Object.freeze({
    kind: "exec",
    command: Object.freeze({
      executable: "/bin/tool",
      argv: Object.freeze([...context.args]),
      env: Object.freeze({ ...context.env }),
      cwd: context.filesystem.cwd,
    }),
    baseCwd: context.filesystem.cwd,
    actions: [],
    attributes: undefined,
    filesystem: context.filesystem,
    processes: context.processes,
    signal: context.signal,
    identity: context.identity,
    target: {
      kind: "resolved" as const,
      program: resolved.value,
      binding: {
        manifest,
        implementation,
      },
    },
  });
}

function machinePort() {
  return {
    spawn: vi.fn(async () => {
      throw new Error("Unexpected machine dispatch");
    }),
  };
}

describe("Computer program admission", () => {
  it("consumes the captured binding's slot once at full capacity without reacquisition", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1);
    const capacityRun = vi.spyOn(capacity, "run");
    const admission = createComputerProgramAdmission({
      capacity,
      escalation: new ComputerEscalationTable(),
      machine: machinePort(),
    });
    let program: ReturnType<typeof createChildWorkerProgram>;
    const modules = vi.fn(() => ({ "entry.js": "export default 0" }));
    program = createChildWorkerProgram({
      executable: "/bin/tool",
      code: { mainModule: "entry.js", modules },
      capacity,
      reservationFor: (context) => admission.reservationFor(context, program),
      createHost: () => ({ host: {}, close() {} }),
      dispatch: {
        run: async (input) => {
          expect(input.command.argv).toEqual(fixture.context.args);
          expect(input.command.env).toEqual(fixture.context.env);
          expect(capacity.active).toBe(1);
          return exited(17);
        },
      },
    });
    try {
      const decision = await admission.admit(requestFor(fixture.context, program));
      expect(capacity.active).toBe(1);
      await expect(admission.admit(requestFor(fixture.context, program))).rejects.toMatchObject({
        code: "RESOURCE_LIMIT",
      });
      if (decision.admission === undefined) throw new Error("Expected a reserved dispatch");
      const context = Object.freeze({ ...fixture.context, admission: decision.admission });
      decision.assertCurrent?.();
      decision.onDispatch?.(context);
      await expect(program.run(context)).resolves.toEqual(exited(17));
      await expect(program.run(context)).rejects.toThrow("does not belong");
      expect(capacityRun).not.toHaveBeenCalled();
      expect(modules).toHaveBeenCalledOnce();
      expect(capacity.active).toBe(0);
    } finally {
      admission.close();
      await fixture.close();
    }
  });

  it.each(["owner", "binding", "context", "environment"] as const)(
    "rejects a changed %s before module loading and cancels the unused grant",
    async (mismatch) => {
      const fixture = childBusyboxFixture();
      const capacity = new ChildWorkerCapacity(1);
      const options = {
        capacity,
        escalation: new ComputerEscalationTable(),
        machine: machinePort(),
      };
      const admission = createComputerProgramAdmission(options);
      const other = createComputerProgramAdmission(options);
      const program = { kind: "async" as const, run: async () => exited() };
      try {
        const decision = await admission.admit(requestFor(fixture.context, program));
        if (decision.admission === undefined) throw new Error("Expected a reserved dispatch");
        const context = { ...fixture.context, admission: decision.admission };
        decision.onDispatch?.(context);
        const resolver = mismatch === "owner" ? other : admission;
        const supplied = mismatch === "context" ? { ...context } : context;
        if (mismatch === "environment") supplied.env = { OTHER: "changed" };
        expect(() =>
          resolver.reservationFor(supplied, mismatch === "binding" ? { ...program } : program),
        ).toThrow();
        // A foreign owner cannot release this owner's grant. Its explicit cancellation still can.
        decision.cancel?.();
        expect(capacity.active).toBe(0);
      } finally {
        admission.close();
        other.close();
        await fixture.close();
      }
    },
  );

  it("invalidates pending evidence and unconsumed grants when the Computer closes", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(2);
    const gate = Promise.withResolvers<{ workspaceBytes: number }>();
    const entered = Promise.withResolvers<void>();
    const admission = createComputerProgramAdmission({
      capacity,
      escalation: new ComputerEscalationTable(),
      machine: machinePort(),
      evidence: async () => {
        entered.resolve();
        return gate.promise;
      },
    });
    try {
      const program = { kind: "async" as const, run: async () => exited() };
      const pending = admission.admit(requestFor(fixture.context, program));
      const rejected = expect(pending).rejects.toMatchObject({ code: "ECANCELED" });
      await entered.promise;
      admission.close();
      gate.resolve({ workspaceBytes: 0 });
      await rejected;
      expect(capacity.active).toBe(0);
    } finally {
      admission.close();
      await fixture.close();
    }
  });

  it("releases a grant and rejects its precommit assertion after owner shutdown", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1);
    const admission = createComputerProgramAdmission({
      capacity,
      escalation: new ComputerEscalationTable(),
      machine: machinePort(),
    });
    try {
      const program = { kind: "async" as const, run: async () => exited() };
      const decision = await admission.admit(requestFor(fixture.context, program));
      expect(capacity.active).toBe(1);
      admission.close();
      admission.close();
      expect(capacity.active).toBe(0);
      expect(() => decision.assertCurrent?.()).toThrow("owner changed");
    } finally {
      admission.close();
      await fixture.close();
    }
  });
});
