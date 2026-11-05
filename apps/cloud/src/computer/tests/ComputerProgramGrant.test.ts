import { expect, it, vi } from "vite-plus/test";
import { ChildWorkerDispatchError } from "../ChildWorkerDispatchError.ts";
import { computerProgramGrantFixture } from "./ComputerProgramGrant.fixture.ts";
import { exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

it("releases 64 sequential phase duplicates while retaining the continuing parent process", async () => {
  const f = await computerProgramGrantFixture();
  try {
    for (let index = 0; index < 64; index++) {
      const phase = f.phase();
      expect(await f.grant.run(phase.port, index === 0, 0)).toEqual({ ok: true, exit: exited() });
      await phase.released;
      expect(phase.active()).toBe(0);
      expect(phase.stopped()).toBe(1);
      expect(phase.revoked()).toBe(1);
      expect(f.parent.active()).toBe(1);
      expect(f.signal.aborted).toBe(false);
    }
    expect(f.capacity.active).toBe(0);
  } finally {
    await f.close();
  }
  expect(f.parent.active()).toBe(0);
});

it("keeps an unconfirmed phase until physical stop even after its failure was returned", async () => {
  const stopped = Promise.withResolvers<void>();
  const f = await computerProgramGrantFixture({
    run: async () => {
      throw new ChildWorkerDispatchError(new Error("Transport lost"), {
        kind: "unconfirmed",
        stopped: stopped.promise,
      });
    },
  });
  const phase = f.phase();
  try {
    expect((await f.grant.run(phase.port, true, 0)).ok).toBe(false);
    expect(phase.active()).toBe(1);
    expect(phase.stopped()).toBe(0);
    expect(f.capacity.active).toBe(1);
    stopped.resolve();
    await phase.released;
    expect(phase.stopped()).toBe(1);
    expect(phase.revoked()).toBe(1);
    expect(phase.active()).toBe(0);
    expect(f.parent.active()).toBe(1);
    expect(f.signal.aborted).toBe(false);
  } finally {
    stopped.resolve();
    await f.close();
  }
});

it.each(["describeFailure", "openFailure"] as const)(
  "cleans a phase after pre-dispatch %s",
  async (key) => {
    const f = await computerProgramGrantFixture();
    const phase = f.phase({ [key]: new Error("Cannot prepare phase") });
    try {
      expect((await f.grant.run(phase.port, true, 0)).ok).toBe(false);
      await phase.released;
      expect(phase.active()).toBe(0);
      expect(phase.stopped()).toBe(1);
      expect(phase.revoked()).toBe(1);
      expect(f.parent.active()).toBe(1);
      expect(f.signal.aborted).toBe(false);
    } finally {
      await f.close();
    }
  },
);

it("joins cancellation cleanup before releasing the phase and ignores its disposal rejection", async () => {
  const entered = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const f = await computerProgramGrantFixture({
    run: async () => {
      entered.resolve();
      await stopped.promise;
      return exited();
    },
  });
  const phase = f.phase();
  const running = f.grant.run(phase.port, true, 0);
  try {
    await entered.promise;
    await f.grant.cancel(new Error("Parent cancelled"));
    expect(phase.active()).toBe(1);
    expect(phase.stopped()).toBe(0);
    stopped.resolve();
    await running;
    await phase.released;
    expect(phase.active()).toBe(0);
    expect(phase.stopped()).toBe(1);
    expect(f.parent.active()).toBe(1);
  } finally {
    stopped.resolve();
    await f.close();
  }
});

it("cleans a cancelled phase before it can dispatch", async () => {
  const f = await computerProgramGrantFixture({
    run: async () => {
      throw new Error("Cancelled phase must not dispatch");
    },
  });
  const phase = f.phase();
  try {
    await f.grant.cancel(new Error("Cancel before phase admission"));
    expect((await f.grant.run(phase.port, true, 0)).ok).toBe(false);
    expect(phase.active()).toBe(0);
    expect(phase.stopped()).toBe(1);
    expect(phase.revoked()).toBe(1);
  } finally {
    await f.close();
  }
});

it("ignores a completed phase's late cancellation during the next phase", async () => {
  const f = await computerProgramGrantFixture();
  const old = f.phase({ keepAbortPendingAfterDisposal: true });
  try {
    expect((await f.grant.run(old.port, true, 0)).ok).toBe(true);
    await old.released;
    old.abort(new Error("Late cancellation"));
    const next = f.phase();
    expect((await f.grant.run(next.port, false, 0)).ok).toBe(true);
    await next.released;
    expect(f.signal.aborted).toBe(false);
  } finally {
    await f.close();
  }
});
