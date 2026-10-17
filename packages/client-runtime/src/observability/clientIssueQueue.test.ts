import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  configureClientIssueReporting,
  flushClientIssues,
  getClientIssueReportingStats,
  reportClientIssue,
  type ClientIssueFlushResult,
} from "@t3tools/client-runtime/observability/client-issues";

afterEach(() => {
  configureClientIssueReporting(null);
  vi.restoreAllMocks();
});

describe("client issue queue", () => {
  it("keeps failures queued, sends independent destinations, and retries after reconnect", async () => {
    const outbound: unknown[] = [];
    const retryCallbacks: Array<() => void> = [];
    const delays: number[] = [];
    let connected = false;
    configureClientIssueReporting({
      client: "web",
      release: "development",
      scheduleRetry: (callback, delayMs) => {
        retryCallbacks.push(callback);
        delays.push(delayMs);
        return () => undefined;
      },
      send: async (event) => {
        if (event.environmentId === "env-offline" && !connected) throw new Error("offline");
        outbound.push(event);
      },
    });

    reportClientIssue({
      code: "connection.status",
      severity: "error",
      source: "ui",
      environmentId: "env-offline",
    });
    reportClientIssue({
      code: "toast.error",
      severity: "error",
      source: "ui",
      environmentId: "env-healthy",
    });
    const firstFlush = await flushClientIssues();

    expect(firstFlush).toMatchObject({ sent: 1, failed: 1, pending: 1 });
    expect(outbound).toMatchObject([{ environmentId: "env-healthy" }]);
    expect(delays).toEqual([1_000]);
    expect(getClientIssueReportingStats()).toMatchObject({ pending: 1, dropped: 0 });

    connected = true;
    retryCallbacks[0]!();
    const retry = await flushClientIssues();
    expect(retry).toMatchObject({ sent: 1, failed: 0, pending: 0 });
    expect(outbound).toHaveLength(2);
  });

  it("exhausts three timer retries and recovers on a new report after the cooldown", async () => {
    let nowMillis = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMillis);
    let connected = false;
    let attempts = 0;
    const retries: Array<{
      callback: () => Promise<ClientIssueFlushResult> | undefined;
      delayMs: number;
    }> = [];
    const recovered = Promise.withResolvers<void>();
    configureClientIssueReporting({
      client: "web",
      release: "development",
      scheduleRetry: (callback, delayMs) => {
        retries.push({ callback, delayMs });
        return () => undefined;
      },
      send: async () => {
        attempts += 1;
        if (!connected) throw new Error("offline");
        if (attempts === 7) recovered.resolve();
      },
    });
    const report = () =>
      reportClientIssue({
        code: "runtime.uncaught",
        severity: "error",
        source: "exception",
      });

    report();
    await flushClientIssues();
    for (const [index, delayMs] of [1_000, 5_000, 30_000].entries()) {
      const retry = retries[index]!;
      expect(retry.delayMs).toBe(delayMs);
      nowMillis += delayMs;
      expect(await retry.callback()).toMatchObject({ sent: 0, failed: 1, pending: 1 });
    }
    expect(attempts).toBe(4);
    expect(retries).toHaveLength(3);
    expect(getClientIssueReportingStats().pending).toBe(1);

    connected = true;
    nowMillis += 29_999;
    report();
    expect(attempts).toBe(4);
    expect(retries).toHaveLength(3);
    nowMillis += 1;
    expect(attempts).toBe(4);
    report();
    await recovered.promise;
    // Join the active delivery before its final send settles; this does not reset retries.
    expect(await flushClientIssues()).toMatchObject({ sent: 3, failed: 0, pending: 0 });
    expect(attempts).toBe(7);
    expect(retries).toHaveLength(3);
    expect(getClientIssueReportingStats()).toEqual({ pending: 0, dropped: 0 });
  });

  it("discards a permanent rejection and sends the next issue to the same destination", async () => {
    const attempted: string[] = [];
    configureClientIssueReporting({
      client: "web",
      release: "development",
      send: async (event) => {
        attempted.push(event.code);
        if (event.code === "runtime.uncaught") return "discarded";
      },
    });
    const rejected = {
      code: "runtime.uncaught",
      severity: "error",
      source: "exception",
      environmentId: "env-1",
      dedupeKey: "runtime:uncaught",
    } as const;
    reportClientIssue(rejected);
    reportClientIssue({
      code: "toast.error",
      severity: "error",
      source: "ui",
      environmentId: "env-1",
    });
    expect(await flushClientIssues()).toEqual({ sent: 1, failed: 0, pending: 0, dropped: 1 });
    expect(attempted).toEqual(["runtime.uncaught", "toast.error"]);
    expect(reportClientIssue(rejected)).not.toBeNull();
    expect(await flushClientIssues()).toEqual({ sent: 0, failed: 0, pending: 0, dropped: 2 });
  });

  it("bounds its queue, counts dropped events, and can discard in-flight account data", async () => {
    let releaseSend: (() => void) | undefined;
    configureClientIssueReporting({
      client: "web",
      release: "development",
      send: () => new Promise<void>((resolve) => (releaseSend = resolve)),
    });

    for (let index = 0; index < 101; index += 1) {
      reportClientIssue({
        code: "runtime.uncaught",
        severity: "error",
        source: "exception",
        method: `failure.${index}`,
      });
    }
    expect(getClientIssueReportingStats()).toEqual({ pending: 100, dropped: 1 });

    const inFlight = flushClientIssues();
    configureClientIssueReporting(null);
    releaseSend?.();
    await inFlight;
  });

  it("cancels retries and clears buffered issues on sign-out or account reconfiguration", async () => {
    const oldRetryCallbacks: Array<() => void> = [];
    const oldEvents: unknown[] = [];
    const newEvents: unknown[] = [];
    let canceledRetries = 0;
    configureClientIssueReporting({
      client: "web",
      release: "development",
      scheduleRetry: (callback) => {
        oldRetryCallbacks.push(callback);
        return () => {
          canceledRetries += 1;
        };
      },
      send: async (event) => {
        oldEvents.push(event);
        throw new Error("offline");
      },
    });

    reportClientIssue({ code: "runtime.uncaught", severity: "error", source: "exception" });
    await flushClientIssues();
    expect(getClientIssueReportingStats().pending).toBe(1);

    configureClientIssueReporting({
      client: "mobile",
      release: "development",
      send: async (event) => {
        newEvents.push(event);
      },
    });
    expect(canceledRetries).toBe(1);
    oldRetryCallbacks[0]!();
    await flushClientIssues();
    expect(oldEvents).toHaveLength(1);
    expect(newEvents).toHaveLength(0);
    expect(getClientIssueReportingStats()).toEqual({ pending: 0, dropped: 0 });

    reportClientIssue({ code: "runtime.uncaught", severity: "error", source: "exception" });
    await flushClientIssues();
    expect(newEvents).toHaveLength(1);
  });

  it("contains sender failures so telemetry cannot change the UI result", () => {
    configureClientIssueReporting({
      client: "web",
      release: "development",
      send: () => {
        throw new Error("offline");
      },
    });

    expect(() =>
      reportClientIssue({ code: "toast.error", severity: "error", source: "ui" }),
    ).not.toThrow();
  });
});
