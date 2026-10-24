import { describe, expect, it } from "vite-plus/test";
import { ChildWorkerCapacity, type ChildWorkerSlotRequest } from "../ChildWorkerCapacity.ts";
import { createComputerProgramAdmission } from "../ComputerProgramAdmission.ts";
import { ComputerEscalationTable } from "../EscalationTable.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";
import {
  machinePort,
  observeTicketReservations,
  prepared,
  requestFor,
} from "./ComputerProgramAdmissionTestSupport.ts";

describe("Computer program admission tickets", () => {
  it("removes its FIFO ticket and rejects when the Computer closes during preparation", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1, { owner: "test/admission-close-during-prepare" });
    const prepareEntered = Promise.withResolvers<void>();
    const pendingPrepare = Promise.withResolvers<ChildWorkerSlotRequest>();
    const admission = createComputerProgramAdmission({
      capacity,
      escalation: new ComputerEscalationTable(),
      machine: machinePort(),
    });
    const implementation = {
      kind: "async" as const,
      prepare: () => {
        prepareEntered.resolve();
        return pendingPrepare.promise;
      },
      run: async () => exited(),
    };
    try {
      const pending = admission.admit(requestFor(fixture.context, implementation));
      await prepareEntered.promise;
      expect(capacity.active).toBe(0);
      expect(capacity.waiting).toBe(1);
      admission.close();
      await expect(pending).rejects.toMatchObject({ code: "ECANCELED" });
      expect(capacity.active).toBe(0);
      expect(capacity.waiting).toBe(0);
    } finally {
      admission.close();
      pendingPrepare.resolve(prepared());
      await fixture.close();
    }
  });

  it("rejects request abort during preparation without waiting for the prepared request", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1, { owner: "test/admission-abort-during-prepare" });
    const prepareEntered = Promise.withResolvers<void>();
    const pendingPrepare = Promise.withResolvers<ChildWorkerSlotRequest>();
    const controller = new AbortController();
    const reason = new Error("request stopped during preparation");
    const admission = createComputerProgramAdmission({
      capacity,
      escalation: new ComputerEscalationTable(),
      machine: machinePort(),
    });
    const implementation = {
      kind: "async" as const,
      prepare: () => {
        prepareEntered.resolve();
        return pendingPrepare.promise;
      },
      run: async () => exited(),
    };
    try {
      const request = Object.freeze({
        ...requestFor(fixture.context, implementation),
        signal: controller.signal,
      });
      const pending = admission.admit(request);
      await prepareEntered.promise;
      expect(capacity.waiting).toBe(1);
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(capacity.active).toBe(0);
      expect(capacity.waiting).toBe(0);
    } finally {
      admission.close();
      pendingPrepare.resolve(prepared());
      await fixture.close();
    }
  });

  it("removes its ticket after preparation fails", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1, { owner: "test/admission-prepare-failure" });
    const failure = new Error("module hash failed");
    const admission = createComputerProgramAdmission({
      capacity,
      escalation: new ComputerEscalationTable(),
      machine: machinePort(),
    });
    const implementation = {
      kind: "async" as const,
      prepare: async () => {
        throw failure;
      },
      run: async () => exited(),
    };
    try {
      await expect(admission.admit(requestFor(fixture.context, implementation))).rejects.toBe(
        failure,
      );
      expect(capacity.active).toBe(0);
      expect(capacity.waiting).toBe(0);
    } finally {
      admission.close();
      await fixture.close();
    }
  });

  it("keeps prepared roots FIFO without holding a permit during delayed preparation", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1, { owner: "test/admission-delayed-prepare-fifo" });
    const firstPrepared = Promise.withResolvers<ChildWorkerSlotRequest>();
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const secondReserveEntered = Promise.withResolvers<void>();
    const firstCode = Object.freeze({ codeId: "first-root", residentBytes: 0 });
    const secondCode = Object.freeze({ codeId: "second-root", residentBytes: 0 });
    const observed = observeTicketReservations(capacity, undefined, (code) => {
      if (code === secondCode) secondReserveEntered.resolve();
    });
    const admission = createComputerProgramAdmission({
      capacity,
      escalation: new ComputerEscalationTable(),
      machine: machinePort(),
    });
    const first = {
      kind: "async" as const,
      prepare: () => {
        firstEntered.resolve();
        return firstPrepared.promise;
      },
      run: async () => exited(),
    };
    const second = {
      kind: "async" as const,
      prepare: async () => {
        secondEntered.resolve();
        return secondCode;
      },
      run: async () => exited(),
    };
    try {
      const firstDecision = admission.admit(requestFor(fixture.context, first));
      await firstEntered.promise;
      const secondDecision = admission.admit(requestFor(fixture.context, second));
      await secondEntered.promise;
      await secondReserveEntered.promise;
      expect(capacity.active).toBe(0);
      expect(capacity.waiting).toBe(2);

      firstPrepared.resolve(firstCode);
      const firstGrant = await firstDecision;
      expect(observed.granted).toEqual([firstCode.codeId]);
      expect(observed.requests).toEqual([secondCode, firstCode]);
      expect(observed.requests[0]).toBe(secondCode);
      expect(observed.requests[1]).toBe(firstCode);
      expect(capacity.active).toBe(1);
      expect(capacity.waiting).toBe(1);

      firstGrant.cancel?.();
      const secondGrant = await secondDecision;
      expect(observed.granted).toEqual([firstCode.codeId, secondCode.codeId]);
      secondGrant.cancel?.();
      expect(capacity.active).toBe(0);
      expect(capacity.waiting).toBe(0);
    } finally {
      admission.close();
      firstPrepared.resolve(firstCode);
      await fixture.close();
    }
  });

  it("records nested priority before its preparation finishes", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1, { owner: "test/admission-nested-ticket" });
    const parentEntered = Promise.withResolvers<void>();
    const parentFinished = Promise.withResolvers<void>();
    const nestedEntered = Promise.withResolvers<void>();
    const nestedPrepared = Promise.withResolvers<ChildWorkerSlotRequest>();
    const rootReserved = Promise.withResolvers<void>();
    const rootCode = Object.freeze({ codeId: "root-ticket", residentBytes: 0 });
    const nestedCode = Object.freeze({ codeId: "nested-ticket", residentBytes: 0 });
    const requester = {
      processes: fixture.context.processes,
      process: fixture.context.identity.handle,
    };
    const rootFinished = Promise.withResolvers<ReturnType<typeof exited>>();
    const rootProcess = fixture.context.processes.spawn(
      undefined,
      () => ({
        completion: rootFinished.promise,
        signal: () => ({ status: "ok", value: undefined }),
      }),
      () => {},
    );
    if (rootProcess.status !== "ok") throw new Error("Root process admission failed");
    const rootContext = { ...fixture.context, identity: rootProcess.value };
    const pendingDecisions: Promise<unknown>[] = [];
    const observed = observeTicketReservations(capacity, undefined, (code) => {
      if (code === rootCode) rootReserved.resolve();
    });
    const admission = createComputerProgramAdmission({
      capacity,
      escalation: new ComputerEscalationTable(),
      machine: machinePort(),
    });
    const parentRun = capacity.run(
      fixture.context.signal,
      async () => {
        parentEntered.resolve();
        await parentFinished.promise;
      },
      requester,
      Object.freeze({ codeId: "parent-ticket", residentBytes: 0 }),
    );
    const root = {
      kind: "async" as const,
      prepare: async () => rootCode,
      run: async () => exited(),
    };
    const nested = {
      kind: "async" as const,
      prepare: () => {
        nestedEntered.resolve();
        return nestedPrepared.promise;
      },
      run: async () => exited(),
    };
    try {
      await parentEntered.promise;
      const rootDecision = admission.admit(requestFor(rootContext, root));
      pendingDecisions.push(rootDecision);
      await rootReserved.promise;
      const nestedDecision = admission.admit(requestFor(fixture.context, nested));
      pendingDecisions.push(nestedDecision);
      await nestedEntered.promise;
      parentFinished.resolve();
      await parentRun;
      expect(capacity.active).toBe(0);
      expect(capacity.waiting).toBe(2);

      nestedPrepared.resolve(nestedCode);
      const nestedGrant = await nestedDecision;
      expect(observed.granted).toEqual([nestedCode.codeId]);
      expect(capacity.active).toBe(1);
      expect(capacity.waiting).toBe(1);
      nestedGrant.cancel?.();

      const rootGrant = await rootDecision;
      expect(observed.granted).toEqual([nestedCode.codeId, rootCode.codeId]);
      rootGrant.cancel?.();
      expect(capacity.active).toBe(0);
    } finally {
      parentFinished.resolve();
      nestedPrepared.resolve(nestedCode);
      admission.close();
      rootFinished.resolve(exited());
      await Promise.allSettled(pendingDecisions);
      await parentRun;
      await fixture.close();
    }
  });
});
