import { describe, expect, it, vi } from "vite-plus/test";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildWorkerProgram, type ChildWorkerInvocation } from "../ChildWorkerProgram.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("command process slot leases", () => {
  it("separates concurrent identical programs and reuses an acknowledged warm slot", async () => {
    const first = childBusyboxFixture();
    const second = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(2);
    const entered = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const invocations: ChildWorkerInvocation[] = [];
    const program = createChildWorkerProgram({
      executable: "/bin/cat",
      code: { mainModule: "main.js", modules: { "main.js": "export default class {}" } },
      capacity,
      dispatch: {
        async run(input) {
          invocations.push(input);
          if (invocations.length === 2) entered.resolve();
          if (invocations.length <= 2) await stopped.promise;
          return exited();
        },
      },
      createHost: () => ({ host: {}, close() {} }),
    });
    const running = [program.run(first.context), program.run(second.context)];
    try {
      await entered.promise;
      expect(invocations[0]?.loaderId).toEqual(expect.any(String));
      expect(invocations[1]?.loaderId).toEqual(expect.any(String));
      expect(invocations[1]?.loaderId).not.toBe(invocations[0]?.loaderId);
      expect(capacity.active).toBe(2);
      stopped.resolve();
      await Promise.all(running);
      await program.drain();
      expect(capacity.active).toBe(0);
      await program.run(first.context);
      expect(invocations[2]?.loaderId).toBe(invocations[0]?.loaderId);
      await program.drain();
    } finally {
      stopped.resolve();
      await Promise.allSettled(running);
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("retires a memory-lost generation before dispatching the next process", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1);
    const ids: string[] = [];
    const killed = { exitCode: 0, signal: 9, coreDumped: false };
    let failing = true;
    const program = createChildWorkerProgram({
      executable: "/bin/rg",
      code: { mainModule: "main.js", modules: { "main.js": "export default class {}" } },
      capacity,
      dispatch: {
        async run(input, _host, onMemoryLost) {
          ids.push(input.loaderId);
          if (failing) {
            failing = false;
            await onMemoryLost!();
            return killed;
          }
          return exited();
        },
      },
      createHost: () => ({ host: {}, close() {} }),
    });
    try {
      await expect(program.run(fixture.context)).resolves.toEqual(killed);
      await program.drain();
      await expect(program.run(fixture.context)).resolves.toEqual(exited());
      await program.drain();
      expect(ids).toHaveLength(2);
      expect(ids[0]).toEqual(expect.any(String));
      expect(ids[1]).not.toBe(ids[0]);
      expect(capacity.active).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
