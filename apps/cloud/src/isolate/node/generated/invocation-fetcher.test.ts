import { describe, expect, it } from "@effect/vitest";
import { createNodeGeneratedCodeFetcher } from "./invocation-fetcher.ts";
import { NodeGeneratedCodeCleanupError } from "./invocation-errors.ts";
import type { NodeGeneratedCodeInvocation, NodeGeneratedCodeResponseHead } from "./invocation.ts";

const envelope = JSON.stringify({
  id: "caller",
  mainModule: "main.js",
  modules: { "main.js": "export default {};" },
  input: { answer: 42 },
});
const request = (signal?: AbortSignal) =>
  new Request("https://code-generation.invalid/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: envelope,
    ...(signal ? { signal } : {}),
  });
const head: NodeGeneratedCodeResponseHead = {
  status: 418,
  statusText: "Generated teapot",
  headers: [["x-generated", "kept"]],
  hasBody: true,
};

function fixture(overrides: Partial<NodeGeneratedCodeInvocation> = {}) {
  let disposals = 0;
  let cancellations = 0;
  let runs = 0;
  const invocation: NodeGeneratedCodeInvocation = {
    async run() {
      runs++;
      return head;
    },
    async read() {
      return { done: true, value: undefined };
    },
    async cancel() {
      cancellations++;
    },
    [Symbol.dispose]() {
      disposals++;
    },
    ...overrides,
  };
  const fetcher = createNodeGeneratedCodeFetcher({
    async open(body) {
      expect(body).toBe(envelope);
      return invocation;
    },
  });
  return { fetcher, invocation, counts: () => ({ disposals, cancellations, runs }) };
}

describe("managed generated-code Fetcher", () => {
  it("preserves the envelope, unsuccessful status, headers and binary bytes through EOF", async () => {
    const chunks = [new Uint8Array([0, 255, 128]), new Uint8Array([42])];
    const test = fixture({
      async read() {
        const value = chunks.shift();
        return value ? { done: false, value } : { done: true, value: undefined };
      },
    });
    const response = await test.fetcher.fetch(request());
    expect(response.status).toBe(418);
    expect(response.statusText).toBe("Generated teapot");
    expect(response.headers.get("x-generated")).toBe("kept");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128, 42]));
    expect(test.counts()).toEqual({ disposals: 1, cancellations: 0, runs: 1 });
  });

  it("finishes a null body without a body RPC", async () => {
    const test = fixture({
      async run() {
        return { ...head, status: 204, hasBody: false };
      },
    });
    const response = await test.fetcher.fetch(request());
    expect(response.body).toBeNull();
    expect(test.counts().disposals).toBe(1);
  });

  it("never opens pre-aborted work", async () => {
    const reason = new Error("already stopped");
    const test = fixture();
    await expect(test.fetcher.fetch(request(AbortSignal.abort(reason)))).rejects.toBe(reason);
    expect(test.counts()).toEqual({ disposals: 0, cancellations: 0, runs: 0 });
  });

  it("cancels an acquired handle without running when abort arrives during open", async () => {
    const opened = Promise.withResolvers<NodeGeneratedCodeInvocation>();
    const started = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const test = fixture({
      cancel() {
        cancelled.resolve();
        return cleanup.promise;
      },
    });
    const fetcher = createNodeGeneratedCodeFetcher({
      open() {
        started.resolve();
        return opened.promise;
      },
    });
    const signal = new AbortController();
    const reason = new Error("stopped opening");
    let settled = false;
    const result = fetcher.fetch(request(signal.signal)).catch((error) => {
      settled = true;
      return error;
    });
    await started.promise;
    signal.abort(reason);
    opened.resolve(test.invocation);
    await cancelled.promise;
    expect(settled).toBe(false);
    expect(test.counts()).toEqual({ disposals: 0, cancellations: 0, runs: 0 });
    cleanup.resolve();
    expect(await result).toBe(reason);
    expect(test.counts().disposals).toBe(1);
  });

  it("waits for cancellation acknowledgment after a before-header fetch rejection", async () => {
    const started = Promise.withResolvers<void>();
    const running = Promise.withResolvers<NodeGeneratedCodeResponseHead>();
    const cancelled = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const test = fixture({
      run() {
        started.resolve();
        return running.promise;
      },
      cancel() {
        cancelled.resolve();
        return cleanup.promise;
      },
    });
    const signal = new AbortController();
    const reason = new Error("stop before headers");
    let settled = false;
    const result = test.fetcher.fetch(request(signal.signal)).catch((error) => {
      settled = true;
      return error;
    });
    await started.promise;
    signal.abort(reason);
    await cancelled.promise;
    running.reject(new Error("child observed abort"));
    await running.promise.catch(() => undefined);
    expect(settled).toBe(false);
    expect(test.counts().disposals).toBe(0);
    cleanup.resolve();
    expect(await result).toBe(reason);
    expect(test.counts().disposals).toBe(1);
  });

  it("does not expose signal-driven EOF before the child's cancel acknowledgment", async () => {
    const readStarted = Promise.withResolvers<void>();
    const next = Promise.withResolvers<ReadableStreamReadResult<Uint8Array>>();
    const cancelled = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const test = fixture({
      read() {
        readStarted.resolve();
        return next.promise;
      },
      cancel() {
        cancelled.resolve();
        return cleanup.promise;
      },
    });
    const signal = new AbortController();
    const reason = new Error("stop stream");
    const response = await test.fetcher.fetch(request(signal.signal));
    const reader = response.body!.getReader();
    let settled = false;
    const reading = reader.read().then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await readStarted.promise;
    signal.abort(reason);
    await cancelled.promise;
    next.resolve({ done: true, value: undefined });
    await next.promise;
    expect(settled).toBe(false);
    cleanup.resolve();
    expect(await reading).toBe(reason);
    expect(test.counts().disposals).toBe(1);
    reader.releaseLock();
  });

  it("keeps a failed body cancellation unconfirmed and does not dispose the handle", async () => {
    const cause = new Error("cleanup failed inside child");
    const test = fixture({
      async cancel() {
        throw cause;
      },
    });
    const response = await test.fetcher.fetch(request());
    const error = await response.body!.cancel().catch((value) => value);
    expect(error).toBeInstanceOf(NodeGeneratedCodeCleanupError);
    expect(error).toMatchObject({ code: "CLEANUP_UNCONFIRMED", cause });
    expect(test.counts().disposals).toBe(0);
  });

  it("reports a cancellation transport failure while the run RPC is still pending", async () => {
    const started = Promise.withResolvers<void>();
    const running = Promise.withResolvers<NodeGeneratedCodeResponseHead>();
    const cause = new Error("RPC disconnected");
    const test = fixture({
      run() {
        started.resolve();
        return running.promise;
      },
      cancel() {
        throw cause;
      },
    });
    const signal = new AbortController();
    const result = test.fetcher.fetch(request(signal.signal)).catch((error) => error);
    await started.promise;
    signal.abort(new Error("owner stopped"));
    expect(await result).toMatchObject({ code: "CLEANUP_UNCONFIRMED", cause });
    expect(test.counts().disposals).toBe(0);
    running.reject(new Error("late RPC failure"));
  });

  it("preserves ordinary fetch failure only after successful cleanup", async () => {
    const cause = new Error("user fetch threw");
    const test = fixture({
      async run() {
        throw cause;
      },
    });
    await expect(test.fetcher.fetch(request())).rejects.toBe(cause);
    expect(test.counts()).toMatchObject({ cancellations: 1, disposals: 1 });
  });

  it("reports unconfirmed cleanup when a failed body read cannot be cancelled", async () => {
    const cause = new Error("reader cleanup rejected");
    const test = fixture({
      async read() {
        throw new Error("body failed");
      },
      async cancel() {
        throw cause;
      },
    });
    const response = await test.fetcher.fetch(request());
    await expect(response.arrayBuffer()).rejects.toMatchObject({
      code: "CLEANUP_UNCONFIRMED",
      cause,
    });
    expect(test.counts().disposals).toBe(0);
  });

  it("preserves open failures before user execution", async () => {
    const cause = new Error("module compilation failed");
    const fetcher = createNodeGeneratedCodeFetcher({
      async open() {
        throw cause;
      },
    });
    await expect(fetcher.fetch(request())).rejects.toBe(cause);
  });
});
