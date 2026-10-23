import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelAsyncProgramContext } from "../../kernel/KernelAsyncProgram.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildWorkerProgram } from "../ChildWorkerProgram.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("child programs without reservations", () => {
  it("admits a nested child without exceeding the strict worker cap", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(2, {
      owner: "test/src-computer-tests-childworkernestedprogram-test-1",
    });
    const childStarted = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<ReturnType<typeof exited>>();
    let maximum = 0;
    const spawn = (args: readonly string[], parent?: KernelAsyncProgramContext) => {
      const child = fixture.context.processes.spawn(
        parent?.identity.handle,
        () => ({
          completion: completion.promise,
          signal: () => ({ status: "ok", value: undefined }),
        }),
        () => {},
      );
      if (child.status !== "ok") throw new Error("Test child could not start");
      return { ...fixture.context, identity: child.value, args };
    };
    const program: ReturnType<typeof createChildWorkerProgram> = createChildWorkerProgram({
      executable: "/bin/worker",
      code: { mainModule: "worker.js", modules: {} },
      capacity,
      createHost: (context) => ({ host: context, close() {} }),
      dispatch: {
        async run(input, context) {
          maximum = Math.max(maximum, capacity.active);
          if (input.command.argv[0] === "child") {
            childStarted.resolve();
            return exited(17);
          }
          return program.run(spawn(["child"], context));
        },
      },
    });
    try {
      const command = program.run(spawn(["parent"]));
      await childStarted.promise;
      expect(capacity.active).toBe(capacity.limit);
      expect(maximum).toBeLessThanOrEqual(capacity.limit);
      expect(await command).toEqual(exited(17));
      await program.drain();
      expect(capacity.active).toBe(0);
    } finally {
      completion.resolve(exited());
      await fixture.close();
    }
  });
});
