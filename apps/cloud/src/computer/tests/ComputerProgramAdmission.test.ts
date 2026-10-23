import { describe, expect, it, vi } from "vite-plus/test";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildWorkerProgram } from "../ChildWorkerProgram.ts";
import { createComputerProgramAdmission } from "../ComputerProgramAdmission.ts";
import { ComputerEscalationTable } from "../EscalationTable.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";
import {
  machinePort,
  observeTicketReservations,
  prepared,
  requestFor,
} from "./ComputerProgramAdmissionTestSupport.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("Computer program admission", () => {
  it("queues before preparing and reserves the same prepared request object", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1, {
      owner: "test/src-computer-tests-computerprogramadmission-test-1",
    });
    const order: string[] = [];
    const preparedRequest = prepared();
    const implementation = {
      kind: "async" as const,
      prepare: async () => {
        order.push("prepare");
        return preparedRequest;
      },
      run: async () => exited(),
    };
    const observed = observeTicketReservations(
      capacity,
      () => order.push("enqueue"),
      () => order.push("reserve"),
    );
    const admission = createComputerProgramAdmission({
      capacity,
      escalation: new ComputerEscalationTable(),
      machine: machinePort(),
    });
    try {
      const decision = await admission.admit(requestFor(fixture.context, implementation));
      expect(order).toEqual(["enqueue", "prepare", "reserve"]);
      expect(observed.enqueue).toHaveBeenCalledOnce();
      expect(observed.requests).toEqual([preparedRequest]);
      expect(observed.requests[0]).toBe(preparedRequest);
      expect(observed.granted).toEqual([preparedRequest.codeId]);
      decision.cancel?.();
      expect(capacity.active).toBe(0);
    } finally {
      admission.close();
      await fixture.close();
    }
  });

  it("consumes the captured binding's slot once at full capacity without reacquisition", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1, {
      owner: "test/src-computer-tests-computerprogramadmission-test-2",
    });
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
      const queued = admission.admit({
        ...requestFor(fixture.context, program),
        kind: "command",
        stdio: "piped",
      });
      if (decision.admission === undefined) throw new Error("Expected a reserved dispatch");
      const context = Object.freeze({ ...fixture.context, admission: decision.admission });
      decision.assertCurrent?.();
      decision.onDispatch?.(context);
      await expect(program.run(context)).resolves.toEqual(exited(17));
      await expect(program.run(context)).rejects.toThrow("does not belong");
      expect(capacityRun).not.toHaveBeenCalled();
      expect(modules).toHaveBeenCalledTimes(2);
      const next = await queued;
      expect(capacity.active).toBe(1);
      next.cancel?.();
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
      const capacity = new ChildWorkerCapacity(1, {
        owner: "test/src-computer-tests-computerprogramadmission-test-3",
      });
      const options = {
        capacity,
        escalation: new ComputerEscalationTable(),
        machine: machinePort(),
      };
      const admission = createComputerProgramAdmission(options);
      const other = createComputerProgramAdmission(options);
      const program = {
        kind: "async" as const,
        prepare: async () => prepared(),
        run: async () => exited(),
      };
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
    const capacity = new ChildWorkerCapacity(2, {
      owner: "test/src-computer-tests-computerprogramadmission-test-4",
    });
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
      const program = {
        kind: "async" as const,
        prepare: async () => prepared(),
        run: async () => exited(),
      };
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
    const capacity = new ChildWorkerCapacity(1, {
      owner: "test/src-computer-tests-computerprogramadmission-test-5",
    });
    const admission = createComputerProgramAdmission({
      capacity,
      escalation: new ComputerEscalationTable(),
      machine: machinePort(),
    });
    try {
      const program = {
        kind: "async" as const,
        prepare: async () => prepared(),
        run: async () => exited(),
      };
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

  it("cancels queued reservations on owner shutdown without leaking the next slot", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1, {
      owner: "test/src-computer-tests-computerprogramadmission-test-6",
    });
    const admission = createComputerProgramAdmission({
      capacity,
      escalation: new ComputerEscalationTable(),
      machine: machinePort(),
    });
    const program = {
      kind: "async" as const,
      prepare: async () => prepared(),
      run: async () => exited(),
    };
    try {
      const held = await capacity.acquire(fixture.context.signal, undefined, prepared());
      const reserving = Promise.withResolvers<void>();
      observeTicketReservations(capacity, undefined, () => reserving.resolve());
      const queued = admission.admit(requestFor(fixture.context, program));
      const rejected = expect(queued).rejects.toMatchObject({ code: "ECANCELED" });
      await reserving.promise;
      admission.close();
      await rejected;
      expect(capacity.active).toBe(1);
      await held.release();
      await expect(
        capacity.run(
          fixture.context.signal,
          async () => 23,
          {
            processes: fixture.context.processes,
            process: fixture.context.identity.handle,
          },
          prepared(),
        ),
      ).resolves.toBe(23);
      expect(capacity.active).toBe(0);
    } finally {
      admission.close();
      await fixture.close();
    }
  });
});
