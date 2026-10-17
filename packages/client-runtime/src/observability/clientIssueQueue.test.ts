import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  configureClientIssueReporting,
  flushClientIssues,
  getClientIssueReportingStats,
  reportClientIssue,
} from "@t3tools/client-runtime/observability/client-issues";

afterEach(() => configureClientIssueReporting(null));

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

  it("stops after three timer retries and resumes on an explicit flush", async () => {
    const retryCallbacks: Array<() => void> = [];
    let connected = false;
    let attempts = 0;
    configureClientIssueReporting({
      client: "web",
      release: "development",
      scheduleRetry: (callback) => {
        retryCallbacks.push(callback);
        return () => undefined;
      },
      send: async () => {
        attempts += 1;
        if (!connected) throw new Error("offline");
      },
    });

    reportClientIssue({ code: "runtime.uncaught", severity: "error", source: "exception" });
    await flushClientIssues();
    for (let retry = 0; retry < 3; retry += 1) {
      retryCallbacks[retry]!();
      await flushClientIssues();
    }

    expect(attempts).toBe(4);
    expect(retryCallbacks).toHaveLength(3);
    expect(getClientIssueReportingStats().pending).toBe(1);

    connected = true;
    expect(await flushClientIssues()).toMatchObject({ sent: 1, pending: 0 });
    expect(attempts).toBe(5);
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
