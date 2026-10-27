import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { waitForProbeRouter } from "./readiness.ts";

const url = "https://sb-isolate-probe-12345678.account.workers.dev/";
const secret = "probe-secret";
const routeNotFound = () =>
  new Response("<!doctype html><h1>Page not found</h1>", {
    status: 404,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });

describe("probe router readiness", () => {
  it("requires the real DO handler after the router is ready and retains precreate failures", async () => {
    const requests: Request[] = [];
    const pending: string[] = [];
    let now = 0;
    await waitForProbeRouter(url, secret, {
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      onPending: (reason) => pending.push(reason),
      fetch: async (request) => {
        requests.push(request);
        if (new URL(request.url).pathname === "/")
          return new Response("Invalid session", { status: 400 });
        return requests.length === 2
          ? Response.json(
              { error: "Error: Handler does not export a fetch() function." },
              { status: 500 },
            )
          : Response.json({ retainedBytes: 0, memoryUsage: {}, heapStatistics: {} });
      },
    });
    expect(requests).toHaveLength(3);
    expect(new URL(requests[1]!.url).pathname).toBe("/root/status");
    expect(new URL(requests[1]!.url).searchParams.get("session")).toBe("readiness");
    expect(pending).toEqual(["durable-object-handler-missing"]);
    expect(now).toBe(500);
  });

  it("does not accept unrelated successful JSON as the DO canary", async () => {
    await expect(
      waitForProbeRouter(url, secret, {
        fetch: async (request) =>
          new URL(request.url).pathname === "/"
            ? new Response("Invalid session", { status: 400 })
            : Response.json({ ok: true }),
      }),
    ).rejects.toThrow("unexpected DO canary response");
  });

  it.each([
    Response.json({ error: "native startup failed" }, { status: 500 }),
    new Response("Unauthorized", { status: 401 }),
    new Response("not JSON", { headers: { "content-type": "application/json" } }),
  ])("fails an unexpected DO response without retrying measurement", async (failure) => {
    let requests = 0;
    await expect(
      waitForProbeRouter(url, secret, {
        fetch: async () =>
          ++requests === 1 ? new Response("Invalid session", { status: 400 }) : failure,
      }),
    ).rejects.toThrow("unexpected");
    expect(requests).toBe(2);
  });

  it("bounds repeated missing-handler setup failures and records every one", async () => {
    let now = 0;
    let requests = 0;
    const pending: string[] = [];
    await expect(
      waitForProbeRouter(url, secret, {
        timeoutMs: 1_000,
        retryIntervalMs: 500,
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds;
        },
        onPending: (reason) => pending.push(reason),
        fetch: async () =>
          ++requests === 1
            ? new Response("Invalid session", { status: 400 })
            : Response.json(
                { error: "Error: Handler does not export a fetch() function." },
                { status: 500 },
              ),
      }),
    ).rejects.toThrow("Durable Object handler remained unavailable for 1000 ms");
    expect(requests).toBe(3);
    expect(pending).toEqual(["durable-object-handler-missing", "durable-object-handler-missing"]);
  });

  it("aborts an in-flight DO canary", async () => {
    const controller = new AbortController();
    const canaryStarted = Promise.withResolvers<Request>();
    const pending = waitForProbeRouter(url, secret, {
      signal: controller.signal,
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/")
          return new Response("Invalid session", { status: 400 });
        canaryStarted.resolve(request);
        return new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      },
    });
    const request = await canaryStarted.promise;
    controller.abort();
    expect(request.signal.aborted).toBe(true);
    await expect(pending).rejects.toThrow("interrupted");
  });

  it("rejects a canary response that arrives after cancellation", async () => {
    const controller = new AbortController();
    const canaryStarted = Promise.withResolvers<void>();
    const releaseCanary = Promise.withResolvers<void>();
    const readiness = waitForProbeRouter(url, secret, {
      signal: controller.signal,
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/")
          return new Response("Invalid session", { status: 400 });
        canaryStarted.resolve();
        await releaseCanary.promise;
        return Response.json({ retainedBytes: 0, memoryUsage: {}, heapStatistics: {} });
      },
    });
    await canaryStarted.promise;
    controller.abort();
    const interrupted = expect(readiness).rejects.toThrow("interrupted");
    releaseCanary.resolve();
    await interrupted;
  });

  it("bounds an in-flight DO canary without retrying it", async () => {
    vi.useFakeTimers();
    try {
      const canaryStarted = Promise.withResolvers<void>();
      let requests = 0;
      const readiness = waitForProbeRouter(url, secret, {
        timeoutMs: 1_000,
        requestTimeoutMs: 25,
        fetch: async (request) => {
          if (++requests === 1) return new Response("Invalid session", { status: 400 });
          canaryStarted.resolve();
          return new Promise<Response>((_, reject) => {
            request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        },
      });
      const timedOut = expect(readiness).rejects.toThrow("request timed out after 25 ms");
      await canaryStarted.promise;
      await vi.advanceTimersByTimeAsync(25);
      await timedOut;
      expect(requests).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires a callable DO after the Cloudflare route and outer router are ready", async () => {
    const requests: Request[] = [];
    let now = 0;
    await waitForProbeRouter(url, secret, {
      timeoutMs: 2_000,
      retryIntervalMs: 250,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      fetch: async (request) => {
        requests.push(request);
        if (requests.length === 1) return routeNotFound();
        return new URL(request.url).pathname === "/"
          ? new Response("Invalid session", { status: 400 })
          : Response.json({ retainedBytes: 0, memoryUsage: {}, heapStatistics: {} });
      },
    });

    expect(requests).toHaveLength(3);
    expect(requests[0]).not.toBe(requests[1]);
    expect(requests[0]?.signal).not.toBe(requests[1]?.signal);
    for (const [index, request] of requests.entries()) {
      expect(new URL(request.url).pathname).toBe(index === 2 ? "/root/status" : "/");
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
      expect(request.redirect).toBe("error");
      expect(request.cache).toBe("no-store");
      expect(new URL(request.url).search).toBe(index === 2 ? "?session=readiness" : "");
    }
  });

  it("stops after the bounded window when the router keeps returning its HTML 404", async () => {
    let now = 0;
    let requests = 0;
    const waits: number[] = [];
    await expect(
      waitForProbeRouter(url, secret, {
        timeoutMs: 1_000,
        retryIntervalMs: 500,
        now: () => now,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
          now += milliseconds;
        },
        fetch: async () => {
          requests++;
          return routeNotFound();
        },
      }),
    ).rejects.toThrow("remained on Cloudflare's HTML 404 for 1000 ms");
    expect(requests).toBe(2);
    expect(waits).toEqual([500, 500]);
  });

  it.each([401, 500])("fails immediately on HTTP %i", async (status) => {
    let requests = 0;
    await expect(
      waitForProbeRouter(url, secret, {
        fetch: async () => {
          requests++;
          return new Response("failure", { status });
        },
      }),
    ).rejects.toThrow(`unexpected HTTP ${status}`);
    expect(requests).toBe(1);
  });

  it("rejects a 404 that does not match the observed router response", async () => {
    let requests = 0;
    await expect(
      waitForProbeRouter(url, secret, {
        fetch: async () => {
          requests++;
          return new Response("Page not found", { status: 404 });
        },
      }),
    ).rejects.toThrow("unexpected HTTP 404");
    expect(requests).toBe(1);
  });

  it("aborts an in-flight request when the run is cancelled", async () => {
    const controller = new AbortController();
    const requestStarted = Promise.withResolvers<Request>();
    const readiness = waitForProbeRouter(url, secret, {
      signal: controller.signal,
      fetch: (request) =>
        new Promise((_, reject) => {
          requestStarted.resolve(request);
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });

    const request = await requestStarted.promise;
    controller.abort();
    expect(request.signal.aborted).toBe(true);
    await expect(readiness).rejects.toThrow("Probe router readiness interrupted");
  });

  it("bounds each in-flight request", async () => {
    vi.useFakeTimers();
    try {
      const requestStarted = Promise.withResolvers<void>();
      const readiness = waitForProbeRouter(url, secret, {
        timeoutMs: 1_000,
        requestTimeoutMs: 25,
        fetch: (request) =>
          new Promise((_, reject) => {
            requestStarted.resolve();
            request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      });
      const timedOut = expect(readiness).rejects.toThrow("request timed out after 25 ms");
      await requestStarted.promise;
      await vi.advanceTimersByTimeAsync(25);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });
});
