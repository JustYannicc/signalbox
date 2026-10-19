import { describe, expect, it, vi } from "vite-plus/test";
import { KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildProgramCatalog } from "../ChildProgramCatalog.ts";
import type { ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import type { ChildWorkerInvocation } from "../ChildWorkerProgram.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

function acknowledgement(value: object): asserts value is { stopped(): void } {
  if (!("stopped" in value) || typeof value.stopped !== "function") {
    throw new Error("Dispatch omitted the private completion acknowledgement");
  }
}

function fixture(failure?: Error, afterStop?: (input: ChildWorkerInvocation) => Promise<void>) {
  const kernel = childBusyboxFixture();
  const capacity = new ChildWorkerCapacity();
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const loader: ChildWorkerLoaderPort = {
    async run(input, invocation) {
      started.resolve();
      await stopped.promise;
      try {
        await afterStop?.(input);
        if (failure) throw failure;
        return exited();
      } finally {
        acknowledgement(invocation);
        invocation.stopped();
      }
    },
  };
  const code = { mainModule: "main.js", modules: { "main.js": "export default {};" } };
  const catalog = createChildProgramCatalog({
    registry: new KernelProgramRegistry(),
    filesystem: kernel.filesystem,
    loader,
    capacity,
    programs: { bash: code, busyboxCat: code, ripgrep: code },
    hostname: "catalog-test",
  });
  const program = catalog.bindings.get("/bin/rg")?.implementation;
  if (program?.kind !== "async") throw new Error("Missing child ripgrep binding");
  return { kernel, capacity, started, stopped, catalog, program };
}

describe("ChildProgramCatalog cleanup", () => {
  it("joins the admitted child lifetime before drain completes", async () => {
    const f = fixture();
    try {
      const running = f.program.run({ ...f.kernel.context, args: ["/bin/rg", "pattern"] });
      await f.started.promise;
      let drained = false;
      const draining = f.catalog.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(f.capacity.active).toBe(1);
      expect(drained).toBe(false);
      f.stopped.resolve();
      await running;
      await draining;
      expect(drained).toBe(true);
      expect(f.capacity.active).toBe(0);
    } finally {
      f.stopped.resolve();
      await f.kernel.close();
    }
  });

  it("reports an acknowledged child failure even when drain starts after it exited", async () => {
    const failure = new Error("child cleanup failed");
    const f = fixture(failure);
    try {
      const running = f.program.run({ ...f.kernel.context, args: ["/bin/rg", "pattern"] });
      const rejected = expect(running).rejects.toMatchObject({ cause: failure });
      await f.started.promise;
      f.stopped.resolve();
      await rejected;
      await expect(f.catalog.drain()).rejects.toMatchObject({
        name: "AggregateError",
        errors: [expect.objectContaining({ cause: failure })],
      });
      expect(f.capacity.active).toBe(0);
    } finally {
      f.stopped.resolve();
      await f.kernel.close();
    }
  });

  it("joins a sibling launched after drain began and reports its late failure", async () => {
    const siblingStarted = Promise.withResolvers<void>();
    const siblingStopped = Promise.withResolvers<void>();
    const failure = new Error("late sibling cleanup failed");
    let sibling: Promise<unknown> | undefined;
    const f = fixture(undefined, async (input) => {
      if (input.command.executable === "/bin/rg") {
        const cat = f.catalog.bindings.get("/bin/cat")?.implementation;
        if (cat?.kind !== "async") throw new Error("Missing child cat binding");
        sibling = cat.run({ ...f.kernel.context, args: ["/bin/cat"] });
        void sibling.catch(() => {});
      } else {
        siblingStarted.resolve();
        await siblingStopped.promise;
        throw failure;
      }
    });
    try {
      const running = f.program.run({ ...f.kernel.context, args: ["/bin/rg", "pattern"] });
      await f.started.promise;
      const draining = expect(f.catalog.drain()).rejects.toMatchObject({
        name: "AggregateError",
        errors: [expect.objectContaining({ cause: failure })],
      });
      f.stopped.resolve();
      await siblingStarted.promise;
      await running;
      expect(f.capacity.active).toBe(1);
      siblingStopped.resolve();
      await expect(sibling).rejects.toMatchObject({ cause: failure });
      await draining;
      expect(f.capacity.active).toBe(0);
    } finally {
      siblingStopped.resolve();
      f.stopped.resolve();
      await sibling?.catch(() => {});
      await f.kernel.close();
    }
  });
});
