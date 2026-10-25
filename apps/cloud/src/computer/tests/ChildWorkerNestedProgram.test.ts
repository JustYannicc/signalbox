import { describe, expect, it } from "vite-plus/test";
import type { KernelAsyncProgramContext } from "../../kernel/KernelAsyncProgram.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildWorkerProgram } from "../ChildWorkerProgram.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

describe("child programs without reservations", () => {
  it("completes when every admitted program starts and waits for a child program", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity();
    const full = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<ReturnType<typeof exited>>();
    let parents = 0;
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
          if (input.command.argv[0] === "child") return exited(Number(input.command.argv[1]));
          if (++parents === capacity.limit) full.resolve();
          await full.promise;
          return program.run(spawn(["child", input.command.argv[1]!], context));
        },
      },
    });
    try {
      const commands = Array.from({ length: capacity.limit }, (_, index) =>
        program.run(spawn(["parent", String(index)])),
      );
      expect(await Promise.all(commands)).toEqual(
        Array.from({ length: capacity.limit }, (_, index) => exited(index)),
      );
      await program.drain();
      expect(maximum).toBe(capacity.limit * 2);
      expect(capacity.active).toBe(0);
    } finally {
      completion.resolve(exited());
      await fixture.close();
    }
  });
});
