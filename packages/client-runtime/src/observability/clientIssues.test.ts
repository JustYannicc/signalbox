import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  clearClientIssueState,
  configureClientIssueReporting,
  flushClientIssues,
  reportClientIssue,
  type ClientIssueReportInput,
} from "@t3tools/client-runtime/observability/client-issues";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

afterEach(() => configureClientIssueReporting(null));

describe("shared client issue reporting", () => {
  it.each(["1.0.1-nightly.20260905.123", "0.1.0-pr.12.34"])(
    "retains the shipped release %s",
    async (release) => {
      const outbound: unknown[] = [];
      configureClientIssueReporting({
        client: "web",
        release,
        send: async (event) => {
          outbound.push(event);
        },
      });
      reportClientIssue({ code: "runtime.uncaught", severity: "error", source: "exception" });
      await flushClientIssues();
      expect(outbound).toMatchObject([{ release }]);
    },
  );

  it.each([
    {},
    { traceId: "a".repeat(32) },
    { spanId: "b".repeat(16) },
    { traceId: "invalid", spanId: "b".repeat(16) },
    { traceId: "a".repeat(32), spanId: "0".repeat(16) },
    { traceId: "0".repeat(32), spanId: "b".repeat(16) },
  ])("does not claim an existing span with incomplete or invalid IDs %j", async (ids) => {
    configureClientIssueReporting({ client: "web", release: "development", send: async () => {} });
    const captured = reportClientIssue({
      code: "rpc.failed",
      severity: "error",
      source: "rpc",
      ...ids,
    });
    await flushClientIssues();
    expect(captured?.traceId).toMatch(/^(?!0{32}$)[a-f0-9]{32}$/);
    expect(captured?.spanId).toMatch(/^(?!0{16}$)[a-f0-9]{16}$/);
    expect(captured).not.toHaveProperty("existingSpan");
  });

  it("sends only schema fields and never forwards content-shaped extras", async () => {
    const outbound: unknown[] = [];
    configureClientIssueReporting({
      client: "web",
      release: "not-a-release-content-canary",
      context: () => ({ threadId: UUID, folderId: UUID, environmentId: "env-1" }),
      send: async (event) => {
        outbound.push(event);
      },
    });

    const input = {
      code: "runtime.uncaught",
      severity: "error",
      source: "exception",
      message: "private-message-canary",
      error: new Error("stack-canary"),
      file: "file-content-canary",
      route: "/route-content-canary",
      title: "title-content-canary",
    } as unknown as ClientIssueReportInput;
    const captured = reportClientIssue(input);
    await flushClientIssues();

    expect(captured).toMatchObject({
      release: "unknown",
      threadId: UUID,
      folderId: UUID,
      environmentId: "env-1",
    });
    expect(Object.keys(captured ?? {}).sort()).toEqual(
      [
        "client",
        "code",
        "environmentId",
        "folderId",
        "release",
        "severity",
        "source",
        "spanId",
        "threadId",
        "traceId",
      ].sort(),
    );
    expect(JSON.stringify(outbound)).not.toMatch(/canary/);
  });

  it("rejects codes outside the contract schema and sanitizes invalid context IDs", async () => {
    const outbound: unknown[] = [];
    configureClientIssueReporting({
      client: "web",
      release: "development",
      context: () => ({
        threadId: "thread-private",
        folderId: "folder-private",
        environmentId: "x".repeat(129),
      }),
      send: async (event) => {
        outbound.push(event);
      },
    });

    expect(
      reportClientIssue({
        code: "user message content" as ClientIssueReportInput["code"],
        severity: "error",
        source: "exception",
      }),
    ).toBeNull();
    reportClientIssue({ code: "runtime.uncaught", severity: "error", source: "exception" });
    await flushClientIssues();

    expect(outbound).toMatchObject([{ threadId: null, folderId: null, environmentId: null }]);
  });

  it("uses explicit destination context and resolves a background thread's own folder", async () => {
    const outbound: unknown[] = [];
    const folderLookups: Array<[string, string]> = [];
    configureClientIssueReporting({
      client: "desktop",
      release: "development",
      context: () => ({
        threadId: UUID,
        folderId: "123e4567-e89b-12d3-a456-426614174001",
        environmentId: "env-current",
      }),
      folderOfThread: (environmentId, threadId) => {
        folderLookups.push([environmentId, threadId]);
        return "123e4567-e89b-12d3-a456-426614174002";
      },
      send: async (event) => {
        outbound.push(event);
      },
    });

    const traceId = "a".repeat(32);
    const spanId = "b".repeat(16);
    const captured = reportClientIssue({
      code: "rpc.failed",
      severity: "error",
      source: "rpc",
      environmentId: "env-other",
      threadId: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      traceId,
      spanId,
      method: "server.getConfig",
      durationMs: 125,
    });
    await flushClientIssues();

    expect(captured).toMatchObject({
      environmentId: "env-other",
      threadId: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      folderId: "123e4567-e89b-12d3-a456-426614174002",
      traceId,
      spanId,
      existingSpan: true,
      method: "server.getConfig",
      durationMs: 125,
    });
    expect(folderLookups).toEqual([["env-other", "user_01ARZ3NDEKTSV4RRFFQ69G5FAV"]]);
    expect(outbound).toHaveLength(1);
  });

  it("does not borrow the active thread or folder for another environment", async () => {
    const outbound: unknown[] = [];
    configureClientIssueReporting({
      client: "mobile",
      release: "development",
      context: () => ({ threadId: UUID, folderId: UUID, environmentId: "env-current" }),
      send: async (event) => {
        outbound.push(event);
      },
    });

    reportClientIssue({
      code: "connection.status",
      severity: "warning",
      source: "ui",
      environmentId: "env-other",
    });
    await flushClientIssues();

    expect(outbound).toMatchObject([
      { threadId: null, folderId: null, environmentId: "env-other" },
    ]);
  });

  it("deduplicates only an explicit unchanged state and reports a changed state immediately", async () => {
    const outbound: unknown[] = [];
    configureClientIssueReporting({
      client: "web",
      release: "development",
      send: async (event) => {
        outbound.push(event);
      },
    });

    reportClientIssue({
      code: "connection.status",
      severity: "warning",
      source: "ui",
      dedupeKey: "connection:primary",
    });
    expect(
      reportClientIssue({
        code: "connection.status",
        severity: "warning",
        source: "ui",
        dedupeKey: "connection:primary",
      }),
    ).toBeNull();
    reportClientIssue({
      code: "connection.status",
      severity: "error",
      source: "ui",
      dedupeKey: "connection:primary",
    });
    await flushClientIssues();

    expect(outbound).toHaveLength(2);
    expect(outbound).toMatchObject([{ severity: "warning" }, { severity: "error" }]);
  });
  it("preserves a folder-only view and drops unregistered method text", async () => {
    const outbound: unknown[] = [];
    configureClientIssueReporting({
      client: "web",
      release: "development",
      context: () => ({ threadId: null, folderId: UUID, environmentId: "env-current" }),
      send: async (event) => {
        outbound.push(event);
      },
    });
    const captured = reportClientIssue({
      code: "toast.warning",
      severity: "warning",
      source: "ui",
      method: "method-private-canary",
    });
    await flushClientIssues();
    expect(captured).toMatchObject({ threadId: null, folderId: UUID });
    expect(captured).not.toHaveProperty("method");
    expect(JSON.stringify(outbound)).not.toContain("canary");
  });

  it("reports the same warning again after its state clears", async () => {
    const outbound: unknown[] = [];
    configureClientIssueReporting({
      client: "web",
      release: "development",
      send: async (event) => {
        outbound.push(event);
      },
    });
    const warning = {
      code: "connection.status",
      severity: "warning",
      source: "ui",
      dedupeKey: "connection:primary",
    } as const;
    reportClientIssue(warning);
    clearClientIssueState(warning.dedupeKey);
    reportClientIssue(warning);
    await flushClientIssues();
    expect(outbound).toHaveLength(2);
  });
});
