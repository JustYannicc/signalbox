import { KernelProcessTable } from "../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { describe, expect, it } from "vite-plus/test";
import { ChildWorkerCapacity } from "../../computer/ChildWorkerCapacity.ts";
import { NodeGeneratedCodeCleanupError } from "../../isolate/NodeGeneratedCode.ts";
import { createHookService, type HookServiceOptions } from "../HookService.ts";

const requester = {
  processes: new KernelProcessTable({ wakes: new KernelWakeRegistry() }),
  process: undefined,
};

const unused = async (): Promise<never> => {
  throw new Error("Wrong hook route");
};
const registration = {
  harness: "claude-code",
  event: "pre-tool-use",
  sessionId: "session",
  kind: "script",
  program: { id: "script", mainModule: "hook.js", modules: { "hook.js": "export default {}" } },
} as const;

function service(generated: HookServiceOptions["generated"], capacity: ChildWorkerCapacity) {
  return createHookService({
    registrations: new Map([["script", registration]]),
    commands: { exec: unused },
    generated,
    capacity,
  });
}

describe("script hook cancellation", () => {
  it("runs queued hooks after the previous invocation releases its permit", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const calls: unknown[] = [];
    const hooks = service(
      {
        async invoke(input) {
          calls.push(input.input);
          started.resolve();
          await finish.promise;
          return new Response(JSON.stringify(input.input));
        },
      },
      capacity,
    );
    const invocation = { requester, cwd: "/work", env: {}, signal: new AbortController().signal };
    const first = hooks.invoke("script", 1, invocation);
    await started.promise;
    const second = hooks.invoke("script", 2, invocation);
    expect(calls).toEqual([1]);
    expect(capacity.active).toBe(1);
    finish.resolve();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => new TextDecoder().decode(result.stdout))).toEqual(["1", "2"]);
    expect(calls).toEqual([1, 2]);
    expect(capacity.active).toBe(0);
  });

  it("retains admission when native invocation cleanup cannot be confirmed", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const failure = new NodeGeneratedCodeCleanupError(
      new Error("Generated child cleanup is unconfirmed"),
    );
    let started = 0;
    const hooks = service(
      {
        invoke: async () => {
          started++;
          throw failure;
        },
      },
      capacity,
    );
    const invocation = { requester, cwd: "/work", env: {}, signal: new AbortController().signal };
    await expect(hooks.invoke("script", {}, invocation)).rejects.toBe(failure);
    expect(capacity.active).toBe(1);
    const queued = new AbortController();
    const reason = new Error("Stop queued hook");
    const waiting = hooks.invoke("script", {}, { ...invocation, signal: queued.signal });
    const rejected = expect(waiting).rejects.toBe(reason);
    expect(started).toBe(1);
    queued.abort(reason);
    await rejected;
    expect(started).toBe(1);
  });

  it("retains admission when response cancellation returns an unconfirmed cleanup failure", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const reading = Promise.withResolvers<void>();
    const controller = new AbortController();
    const failure = new NodeGeneratedCodeCleanupError(
      new Error("Generated child cancellation disconnected"),
    );
    const hooks = service(
      {
        invoke: async () =>
          new Response(
            new ReadableStream(
              {
                pull() {
                  reading.resolve();
                },
                cancel() {
                  throw failure;
                },
              },
              { highWaterMark: 0 },
            ),
          ),
      },
      capacity,
    );
    const pending = hooks.invoke(
      "script",
      {},
      { requester, cwd: "/work", env: {}, signal: controller.signal },
    );
    void pending.catch(() => undefined);
    await reading.promise;
    controller.abort(new Error("Stop script"));
    await expect(pending).rejects.toBe(failure);
    expect(capacity.active).toBe(1);
  });

  it("cancels the response body and holds admission until its cancellation finishes", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const reading = Promise.withResolvers<void>();
    const finishCancellation = Promise.withResolvers<void>();
    const controller = new AbortController();
    const reason = new Error("Stop this script hook");
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelReason: unknown;
    const hooks = service(
      {
        invoke: async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                start(stream) {
                  streamController = stream;
                },
                pull() {
                  reading.resolve();
                },
                async cancel(received) {
                  cancelReason = received;
                  await finishCancellation.promise;
                },
              },
              { highWaterMark: 0 },
            ),
          ),
      },
      capacity,
    );
    const pending = hooks.invoke(
      "script",
      {},
      { requester, cwd: "/work", env: {}, signal: controller.signal },
    );
    void pending.catch(() => undefined);
    await reading.promise;
    try {
      controller.abort(reason);
      expect(cancelReason).toBe(reason);
      expect(capacity.active).toBe(1);
      finishCancellation.resolve();
      await expect(pending).rejects.toBe(reason);
      expect(capacity.active).toBe(0);
    } finally {
      if (cancelReason === undefined) streamController!.close();
      finishCancellation.resolve();
      await pending.catch(() => undefined);
    }
  });

  it("holds admission until an aborted invocation cleans up before producing a response", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const started = Promise.withResolvers<void>();
    const finishCancellation = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const controller = new AbortController();
    const reason = new Error("Cancel before headers");
    let nativeAbortStarted = false;
    const hooks = service(
      {
        invoke: (_input, options?: { readonly signal?: AbortSignal }) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              nativeAbortStarted = true;
              void finishCancellation.promise.then(() => response.reject(options.signal!.reason));
            },
            { once: true },
          );
          started.resolve();
          return response.promise;
        },
      },
      capacity,
    );
    const pending = hooks.invoke(
      "script",
      {},
      { requester, cwd: "/work", env: {}, signal: controller.signal },
    );
    void pending.catch(() => undefined);
    await started.promise;
    try {
      controller.abort(reason);
      expect(nativeAbortStarted).toBe(true);
      expect(capacity.active).toBe(1);
      finishCancellation.resolve();
      await expect(pending).rejects.toBe(reason);
      expect(capacity.active).toBe(0);
    } finally {
      finishCancellation.resolve();
      response.reject(reason);
      await pending.catch(() => undefined);
    }
  });
});
