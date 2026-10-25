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
  it("retries the Cloudflare route 404 and accepts the no-session worker response", async () => {
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
        return requests.length === 1
          ? routeNotFound()
          : new Response("Invalid session", { status: 400 });
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);
    expect(requests[0]?.signal).not.toBe(requests[1]?.signal);
    for (const request of requests) {
      expect(request.url).toBe(url);
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
      expect(request.redirect).toBe("error");
      expect(request.cache).toBe("no-store");
      expect(new URL(request.url).search).toBe("");
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
