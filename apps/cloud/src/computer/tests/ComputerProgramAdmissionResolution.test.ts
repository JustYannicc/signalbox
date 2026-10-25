import { describe, expect, it, vi } from "vite-plus/test";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import {
  createComputerProgramAdmission,
  type ComputerProgramResolution,
} from "../ComputerProgramAdmission.ts";
import { ComputerEscalationTable } from "../EscalationTable.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";
import { machinePort, prepared, requestFor } from "./ComputerProgramAdmissionTestSupport.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("Computer command resolution admission", () => {
  it.each(["close", "abort"] as const)(
    "settles a pending resolver on %s before evidence or reservation",
    async (operation) => {
      const fixture = childBusyboxFixture();
      const capacity = new ChildWorkerCapacity(1, {
        RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
        owner: "test/resolution-admission",
      });
      const entered = Promise.withResolvers<AbortSignal>();
      const resolved = Promise.withResolvers<ComputerProgramResolution>();
      const controller = new AbortController();
      const evidence = vi.fn(async () => ({ workspaceBytes: 0 }));
      const prepare = vi.fn(async () => prepared());
      const implementation = { kind: "async" as const, prepare, run: async () => exited() };
      const request = { ...requestFor(fixture.context, implementation), signal: controller.signal };
      const admission = createComputerProgramAdmission({
        capacity,
        escalation: new ComputerEscalationTable(),
        machine: machinePort(),
        evidence,
        resolve: async (input) => {
          entered.resolve(input.signal);
          return resolved.promise;
        },
      });
      const enqueue = vi.spyOn(capacity, "enqueue");
      const reason = new Error("Command resolution cancelled");
      try {
        const pending = admission.admit(request);
        const rejected =
          operation === "close"
            ? expect(pending).rejects.toMatchObject({ code: "ECANCELED" })
            : expect(pending).rejects.toBe(reason);
        const signal = await entered.promise;
        if (operation === "close") admission.close();
        else controller.abort(reason);
        await rejected;
        expect(signal.aborted).toBe(true);
        if (operation === "abort") expect(signal.reason).toBe(reason);
        expect(evidence).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
        expect(capacity.active).toBe(0);
      } finally {
        resolved.resolve({ command: request.command });
        admission.close();
        await fixture.close();
      }
    },
  );
});
