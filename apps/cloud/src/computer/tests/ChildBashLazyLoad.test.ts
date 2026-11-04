import { afterEach, expect, it, vi } from "vite-plus/test";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelSyscallPort } from "../../kernel/KernelSyscallPort.ts";
import type { KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

afterEach(() => {
  vi.doUnmock("../childBash/start.ts");
  vi.resetModules();
});

async function fixture(loadFailure?: Error) {
  vi.resetModules();
  const importing = Promise.withResolvers<void>();
  const releaseImport = Promise.withResolvers<void>();
  const initialized = vi.fn();
  const started = vi.fn();
  vi.doMock("../childBash/start.ts", async (importOriginal) => {
    initialized();
    importing.resolve();
    await releaseImport.promise;
    if (loadFailure !== undefined) throw loadFailure;
    const actual = await importOriginal<Record<string, unknown>>();
    const start = actual.startChildBash;
    if (typeof start !== "function") throw new Error("Bash start entry is missing");
    return {
      startChildBash: (...args: unknown[]) => {
        started();
        return Reflect.apply(start, undefined, args);
      },
    };
  });
  const { commandGatewayFixture, exited, readAll, writeStdio } =
    await import("../commandGatewayTesting.ts");
  const dispatched = vi.fn();
  const f = commandGatewayFixture({
    async run(input, invocation) {
      dispatched(input.command.executable);
      const host = await invocation.host<KernelBashPort & KernelSyscallPort>();
      try {
        await writeStdio(host, 1, new TextEncoder().encode(input.command.executable));
        if (["/bin/bash", "/bin/sh"].includes(input.command.executable))
          await host.complete({ kind: "exit", status: exited(23) });
        return exited(23);
      } finally {
        invocation.acknowledge();
      }
    },
  });
  const children: KernelCommandChild[] = [];
  return {
    ...f,
    importing: importing.promise,
    releaseImport: () => releaseImport.resolve(),
    initialized,
    started,
    dispatched,
    async exec(executable: string, argv = [executable], signal = f.controller.signal) {
      const child = await f.gateway.exec(
        { executable, argv, cwd: "/workspace", env: {} },
        signal,
        undefined,
      );
      children.push(child);
      return child;
    },
    async output(child: KernelCommandChild) {
      const [status, stdout] = await Promise.all([child.exited, readAll(child.stdout)]);
      expect(status).toEqual(exited(23));
      return new TextDecoder().decode(stdout);
    },
    async close() {
      releaseImport.resolve();
      try {
        await Promise.all(children.map((child) => child.dispose()));
      } finally {
        await f.close();
      }
    },
  };
}

it("keeps file reads and search independent, then shares one Bash import across aliases and uses", async () => {
  const f = await fixture();
  try {
    f.write("/workspace/input", "needle\n");
    const { createNodeFs } = await import("../../isolate/NodeFs.ts");
    expect(createNodeFs(f.filesystem).fs.readFileSync("/workspace/input", "utf8")).toBe("needle\n");
    for (const executable of ["/bin/rg", "/bin/ugrep"])
      expect(await f.output(await f.exec(executable, [executable, "needle"]))).toBe(executable);
    await f.gateway.drain();
    expect(f.initialized).not.toHaveBeenCalled();

    const commands = [f.exec("/bin/bash"), f.exec("/bin/sh")];
    await f.importing;
    expect(f.initialized).toHaveBeenCalledTimes(1);
    expect(f.started).not.toHaveBeenCalled();
    expect(f.capacity.active).toBe(0);
    f.releaseImport();
    const children = await Promise.all(commands);
    expect(await Promise.all(children.map(f.output))).toEqual(["/bin/bash", "/bin/bash"]);
    expect(await f.output(await f.exec("/bin/bash"))).toBe("/bin/bash");
    await f.gateway.drain();
    expect(f.initialized).toHaveBeenCalledTimes(1);
    expect(f.started).toHaveBeenCalledTimes(3);
    expect(f.capacity.active).toBe(0);
    expect(f.capacity.waiting).toBe(0);
    expect(f.machineSpawn).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("cancels a command waiting for the import without opening a Bash host or dispatching", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const reason = new Error("Cancelled while loading Bash");
    const cancelled = f
      .exec("/bin/bash", undefined, controller.signal)
      .catch((error: unknown) => error);
    await f.importing;
    controller.abort(reason);
    expect(await cancelled).toBe(reason);
    const draining = f.gateway.close();
    f.releaseImport();
    await draining;
    expect(f.started).not.toHaveBeenCalled();
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(f.capacity.active).toBe(0);
    expect(f.capacity.waiting).toBe(0);
  } finally {
    await f.close();
  }
});

it("keeps a shared first import usable when one concurrent command is cancelled", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const reason = new Error("One Bash caller cancelled");
    const cancelled = f
      .exec("/bin/bash", undefined, controller.signal)
      .catch((error: unknown) => error);
    const retained = f.exec("/bin/sh");
    await f.importing;
    controller.abort(reason);
    expect(await cancelled).toBe(reason);
    f.releaseImport();
    expect(await f.output(await retained)).toBe("/bin/bash");
    await f.gateway.drain();
    expect(f.initialized).toHaveBeenCalledTimes(1);
    expect(f.started).toHaveBeenCalledTimes(1);
    expect(f.dispatched).toHaveBeenCalledTimes(1);
    expect(f.capacity.active).toBe(0);
  } finally {
    await f.close();
  }
});

it("joins a failed first import in drain and preserves it for repeated commands", async () => {
  const failure = new Error("Bash module could not load");
  const f = await fixture(failure);
  try {
    const command = f.exec("/bin/bash").catch((error: unknown) => error);
    await f.importing;
    const draining = f.gateway.drain();
    const drained = draining.catch((error: unknown) => error);
    f.releaseImport();
    // Vite wraps a rejected mock import, retaining the import's original failure as its cause.
    expect(await command).toMatchObject({ cause: failure });
    expect(await drained).toMatchObject({ cause: failure });
    await expect(f.exec("/bin/sh")).rejects.toMatchObject({ cause: failure });
    expect(f.initialized).toHaveBeenCalledTimes(1);
    expect(f.started).not.toHaveBeenCalled();
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(f.capacity.active).toBe(0);
    expect(f.capacity.waiting).toBe(0);
  } finally {
    await expect(f.close()).rejects.toMatchObject({ cause: failure });
  }
});
