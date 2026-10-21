import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeDns } from "../NodeDns.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function pendingFetch() {
  const started = deferred<AbortSignal>();
  const cancelled = deferred<void>();
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error("DNS did not supply an abort signal");
    started.resolve(signal);
    await new Promise<void>((_resolve, reject) => {
      const abort = () => {
        cancelled.resolve();
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    throw new Error("Unreachable");
  };
  return { started, cancelled, fetch };
}

describe("Node DNS cancellation", () => {
  it("cancels only that resolver and permits subsequent queries", async () => {
    const pending = pendingFetch();
    let calls = 0;
    const modules = createNodeDns({
      fetch: (...args) =>
        ++calls === 1
          ? pending.fetch(...args)
          : Promise.resolve(
              Response.json({
                Status: 0,
                Answer: [{ name: "example.test.", type: 1, TTL: 20, data: "192.0.2.1" }],
              }),
            ),
    });
    const resolver = new modules.dns.promises.Resolver();
    const active = resolver.resolve4("example.test");
    const rejection = expect(active).rejects.toMatchObject({
      code: "ECANCELLED",
      syscall: "queryA",
      hostname: "example.test",
    });
    await pending.started.promise;
    resolver.cancel();
    await pending.cancelled.promise;
    await rejection;
    expect(await resolver.resolve4("example.test")).toEqual(["192.0.2.1"]);
    expect(await modules.dns.promises.resolve4("example.test")).toEqual(["192.0.2.1"]);
    await modules.drain();
  });
  it("cancels callback requests immediately after submission", async () => {
    const pending = pendingFetch();
    const modules = createNodeDns({ fetch: pending.fetch });
    const resolver = new modules.dns.Resolver();
    const completed = new Promise<unknown>((resolve) => {
      resolver.resolve4("example.test", resolve);
    });
    resolver.cancel();
    await expect(completed).resolves.toMatchObject({ code: "ECANCELLED" });
    await modules.drain();
  });
  it("aborts all resolver instances on process shutdown and drain waits for transport settlement", async () => {
    const lifetime = new AbortController();
    const started = deferred<void>();
    const settled = deferred<void>();
    let signal: AbortSignal | null | undefined;
    const modules = createNodeDns({
      signal: lifetime.signal,
      fetch: async (_url, init) => {
        signal = init?.signal;
        started.resolve();
        await settled.promise;
        throw signal?.reason;
      },
    });
    const request = new modules.dns.promises.Resolver().resolve4("example.test");
    const rejected = expect(request).rejects.toMatchObject({ code: "ECANCELLED" });
    await started.promise;
    lifetime.abort();
    expect(signal?.aborted).toBe(true);
    let drained = false;
    const draining = modules.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    settled.resolve();
    await rejected;
    await draining;
    await expect(modules.dns.promises.lookup("new.test")).rejects.toMatchObject({
      code: "ECANCELLED",
    });
  });
  it("applies per-resolver timeouts and bounded retries", async () => {
    vi.useFakeTimers();
    try {
      const pending = pendingFetch();
      const fetch = vi.fn(pending.fetch);
      const modules = createNodeDns({ fetch });
      const resolver = new modules.dns.promises.Resolver({ timeout: 10, tries: 2 });
      const query = resolver.resolve4("slow.test");
      const rejected = expect(query).rejects.toMatchObject({
        code: "ETIMEOUT",
        hostname: "slow.test",
      });
      await pending.started.promise;
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(fetch).toHaveBeenCalledTimes(2);
      await modules.drain();
    } finally {
      vi.useRealTimers();
    }
  });
  it("cancels an in-progress response body", async () => {
    const reading = deferred<void>();
    const lifetime = new AbortController();
    const modules = createNodeDns({
      signal: lifetime.signal,
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
                once: true,
              });
              reading.resolve();
            },
          }),
        ),
    });
    const query = modules.dns.promises.resolve4("example.test");
    const rejection = expect(query).rejects.toMatchObject({ code: "ECANCELLED" });
    await reading.promise;
    lifetime.abort();
    await rejection;
    await modules.drain();
  });
});
