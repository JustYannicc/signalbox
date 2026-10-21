import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelAsyncProgramContext } from "../../kernel/KernelAsyncProgram.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { ChildWorkerDispatchError } from "../ChildWorkerDispatchError.ts";
import { createChildWorkerProgram } from "../ChildWorkerProgram.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

describe("Child worker environment after admission", () => {
  it("claims the original context before deriving one environment for host and command", async () => {
    const fixture = childBusyboxFixture({ env: { PATH: "/bin", PWD: "/old" } });
    const capacity = new ChildWorkerCapacity(1);
    const reservation = await capacity.reserve(fixture.context.signal, {
      processes: fixture.context.processes,
      process: fixture.context.identity.handle,
    });
    const order: string[] = [];
    let hostEnvironment: Readonly<Record<string, string>> | undefined;
    const childEnv = vi.fn((context: KernelAsyncProgramContext) => {
      order.push("environment");
      expect(context).toBe(fixture.context);
      return { ...context.env, PWD: context.filesystem.cwd };
    });
    const program = createChildWorkerProgram({
      executable: "/bin/tool",
      code: { mainModule: "main.js", modules: {} },
      capacity,
      reservationFor(context) {
        order.push("claim");
        expect(context).toBe(fixture.context);
        expect(context.env.PWD).toBe("/old");
        return reservation;
      },
      childEnv,
      createHost(context) {
        hostEnvironment = context.env;
        expect(context.filesystem).toBe(fixture.context.filesystem);
        expect(context.identity).toBe(fixture.context.identity);
        return { host: {}, close() {} };
      },
      dispatch: {
        async run(input) {
          expect(input.command.env).toBe(hostEnvironment);
          expect(input.command.env).toEqual({ PATH: "/bin", PWD: "/workspace" });
          expect(Object.isFrozen(input.command.env)).toBe(true);
          return exited();
        },
      },
    });
    try {
      await expect(program.run(fixture.context)).resolves.toEqual(exited());
      await program.drain();
      expect(order).toEqual(["claim", "environment"]);
      expect(childEnv).toHaveBeenCalledOnce();
      expect(fixture.context.env.PWD).toBe("/old");
      expect(capacity.active).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("never derives an environment after a rejected claim", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1);
    const reservation = await capacity.reserve(fixture.context.signal, {
      processes: fixture.context.processes,
      process: fixture.context.identity.handle,
    });
    reservation.cancel();
    const childEnv = vi.fn(() => ({}));
    const createHost = vi.fn(() => ({ host: {}, close() {} }));
    const dispatch = vi.fn(async () => exited());
    const program = createChildWorkerProgram({
      executable: "/bin/tool",
      code: { mainModule: "main.js", modules: {} },
      capacity,
      reservationFor: () => reservation,
      childEnv,
      createHost,
      dispatch: { run: dispatch },
    });
    try {
      await expect(program.run(fixture.context)).rejects.toThrow("no longer available");
      await expect(program.drain()).resolves.toBeUndefined();
      expect(childEnv).not.toHaveBeenCalled();
      expect(createHost).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(capacity.active).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("releases a claimed slot and reports environment preparation failure to its caller only", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1);
    const reservation = await capacity.reserve(fixture.context.signal, {
      processes: fixture.context.processes,
      process: fixture.context.identity.handle,
    });
    const failure = new Error("environment unavailable");
    const createHost = vi.fn(() => ({ host: {}, close() {} }));
    const program = createChildWorkerProgram({
      executable: "/bin/tool",
      code: { mainModule: "main.js", modules: {} },
      capacity,
      reservationFor: () => reservation,
      childEnv() {
        throw failure;
      },
      createHost,
      dispatch: { run: async () => exited() },
    });
    try {
      await expect(program.run(fixture.context)).rejects.toBe(failure);
      await expect(program.drain()).resolves.toBeUndefined();
      expect(createHost).not.toHaveBeenCalled();
      expect(capacity.active).toBe(0);
    } finally {
      await fixture.close();
    }
  });
  it("reports a close failure that follows a dispatch error its caller received", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1);
    const dispatchFailure = new ChildWorkerDispatchError(new Error("child failed"), {
      kind: "stopped",
    });
    const closeFailure = new Error("close failed");
    const program = createChildWorkerProgram({
      executable: "/bin/tool",
      code: { mainModule: "main.js", modules: {} },
      capacity,
      createHost: () => ({
        host: {},
        close() {
          throw closeFailure;
        },
      }),
      dispatch: {
        run: async () => {
          throw dispatchFailure;
        },
      },
    });
    try {
      await expect(program.run(fixture.context)).rejects.toBe(dispatchFailure);
      await expect(program.drain()).rejects.toBe(closeFailure);
    } finally {
      await fixture.close();
    }
  });

  it("reports a cleanup rejection with no value after the command already exited", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1);
    const program = createChildWorkerProgram({
      executable: "/bin/tool",
      code: { mainModule: "main.js", modules: {} },
      capacity,
      createHost: () => ({
        host: {},
        exited: Promise.resolve(exited()),
        close: () => Promise.reject(),
      }),
      dispatch: { run: async () => exited() },
    });
    try {
      await expect(program.run(fixture.context)).resolves.toEqual(exited());
      await expect(program.drain()).rejects.toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
