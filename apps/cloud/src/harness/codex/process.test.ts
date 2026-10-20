import { describe, expect, it, vi } from "vite-plus/test";
import { startCodexHarnessProcess } from "../CodexHarnessProcess.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { deferred, fixture } from "./tests/fixture.ts";
import { echoEngine, exitBeforeReadyEngine, READY_LINE } from "./tests/wasm.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function collect(stream: ReadableStream<Uint8Array>) {
  let result = "";
  for await (const chunk of stream) result += decoder.decode(chunk, { stream: true });
  return result;
}

describe("Codex WASI process", () => {
  it.each([0, 23])("preserves silent pre-ready WASI exit status %s", async (exitCode) => {
    const context = fixture(exitBeforeReadyEngine(exitCode));
    try {
      const process = await startCodexHarnessProcess(context.options);
      const output = collect(process.stdout);
      const error = collect(process.stderr);
      const status = { exitCode, signal: 0, coreDumped: false };
      await expect(process.ready).rejects.toMatchObject({
        message: "Codex exited before signalbox/ready",
        cause: status,
      });
      expect(await process.exited).toEqual(status);
      expect(await output).toBe("");
      expect(await error).toBe("");
      const snapshot = process.startup?.();
      expect(snapshot).toMatchObject({
        bootstrap: {
          bytes: encoder.encode(JSON.stringify(context.options.bootstrap) + "\n").length,
        },
        wasi: "returned",
        exit: status,
      });
      expect(snapshot?.bootstrap?.state).not.toBe("pending");
      expect(JSON.stringify(snapshot)).not.toContain("overrides");
      if (snapshot?.exit) Object.assign(snapshot.exit, { exitCode: 99 });
      expect(process.startup?.().exit).toEqual(status);
      expect(context.host.processes.size).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("preserves the same pre-ready WASI trap as readiness and execution failure", async () => {
    const context = fixture(exitBeforeReadyEngine());
    try {
      const process = await startCodexHarnessProcess(context.options);
      const output = collect(process.stdout);
      const error = collect(process.stderr);
      const failure = await process.ready.catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(WebAssembly.RuntimeError);
      await expect(process.exited).rejects.toBe(failure);
      expect(process.startup?.()).toMatchObject({ wasi: "failed", exit: null });
      expect(await output).toBe("");
      expect(await error).toBe("");
      expect(context.host.processes.size).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("sends the exact bootstrap before an immediate client write and leaves borrowed files usable", async () => {
    const context = fixture(echoEngine());
    const descriptors = [...context.files.descriptors.entries()];
    try {
      const process = await startCodexHarnessProcess(context.options);
      const output = collect(process.stdout);
      const error = collect(process.stderr);
      const writer = process.stdin.getWriter();
      const request = '{"id":7,"method":"initialize"}\n';
      await writer.write(encoder.encode(request));
      await process.ready;
      await writer.close();
      writer.releaseLock();
      expect(await process.exited).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
      expect(await output).toBe(
        READY_LINE + JSON.stringify(context.options.bootstrap) + "\n" + request,
      );
      expect(await error).toBe("");
      await process.dispose();
      await process.dispose();
      expect(context.host.processes.size).toBe(0);
      expect(context.wakes.size).toBe(0);
      expect([...context.files.descriptors.entries()]).toEqual(descriptors);
      const fd = context.files.open(
        "/still-usable",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
      );
      context.files.close(fd);
      expect(context.stdio.stdin.locked).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("interrupts a real suspended stdin read and awaits process and descriptor cleanup", async () => {
    const context = fixture(echoEngine());
    const blocked = deferred<void>();
    const endpoint = context.stdio.stdio[0];
    const read = endpoint.readInto!;
    vi.spyOn(endpoint, "readInto").mockImplementation((target, flags) => {
      const result = read(target, flags);
      if (result instanceof Promise) blocked.resolve();
      return result;
    });
    try {
      const process = await startCodexHarnessProcess(context.options);
      const output = collect(process.stdout);
      const error = collect(process.stderr);
      await process.ready;
      await blocked.promise;
      expect(context.host.processes.size).toBe(1);
      await Promise.all([process.abort(new Error("stop")), process.dispose()]);
      expect(await process.exited).toEqual({ exitCode: 0, signal: 15, coreDumped: false });
      expect(context.host.processes.size).toBe(0);
      expect(context.wakes.size).toBe(0);
      expect(context.stdio.stdin.locked).toBe(false);
      await output;
      await error;
    } finally {
      await context.close();
    }
  });

  it("rejects missing imports before guest code runs and reaps its admitted process", async () => {
    const context = fixture(echoEngine(true));
    try {
      const process = await startCodexHarnessProcess(context.options);
      const output = collect(process.stdout);
      const error = collect(process.stderr);
      const failure = await process.ready.catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ message: "Unsupported Codex import missing.must_reject" });
      await expect(process.exited).rejects.toBe(failure);
      expect(process.startup?.()).toMatchObject({ wasi: "not-started", exit: null });
      await expect(process.dispose()).rejects.toThrow(
        "Unsupported Codex import missing.must_reject",
      );
      expect(await output).toBe("");
      expect(await error).toBe("");
      expect(context.host.processes.size).toBe(0);
      expect(context.wakes.size).toBe(0);
      expect(context.stdio.stdin.locked).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("continues cleanup when finishing output fails", async () => {
    const context = fixture(echoEngine());
    const failure = new Error("finish failed");
    const finish = context.stdio.finish;
    vi.spyOn(context.stdio, "finish").mockImplementation(() => {
      finish();
      throw failure;
    });
    try {
      const process = await startCodexHarnessProcess(context.options);
      const output = collect(process.stdout);
      const error = collect(process.stderr);
      await process.ready;
      const writer = process.stdin.getWriter();
      await writer.close();
      writer.releaseLock();
      await expect(process.exited).rejects.toBe(failure);
      expect(context.host.processes.size).toBe(0);
      expect(context.wakes.size).toBe(0);
      expect(context.stdio.stdin.locked).toBe(false);
      await output;
      await error;
    } finally {
      await context.close();
    }
  });

  it("finishes when the guest exits with a bootstrap write still blocked", async () => {
    const context = fixture(echoEngine(false, true));
    try {
      const process = await startCodexHarnessProcess({
        ...context.options,
        bootstrap: { ...context.options.bootstrap, overrides: { value: "x".repeat(100_000) } },
      });
      const output = collect(process.stdout);
      const error = collect(process.stderr);
      expect(await process.exited).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
      expect(await output).toBe(READY_LINE);
      expect(await error).toBe("");
      expect(context.host.processes.size).toBe(0);
      expect(context.wakes.size).toBe(0);
      expect(context.stdio.stdin.locked).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("cleans up an already aborted launch without admitting guest code", async () => {
    const context = fixture(echoEngine());
    const controller = new AbortController();
    const failure = new Error("cancelled before launch");
    controller.abort(failure);
    try {
      await expect(
        startCodexHarnessProcess({ ...context.options, signal: controller.signal }),
      ).rejects.toBe(failure);
      expect(context.host.processes.size).toBe(0);
      expect(context.stdio.stdin.locked).toBe(false);
      expect(context.wakes.size).toBe(0);
    } finally {
      await context.close();
    }
  });
});
