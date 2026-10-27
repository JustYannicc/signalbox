import { describe, expect, it } from "@effect/vitest";
import { waitForProbeRouter } from "./readiness.ts";

const url = "https://sb-isolate-probe-12345678.account.workers.dev/";
const versionId = "current-upload";
const health = { ready: true, versionId, workerName: "sb-isolate-probe-12345678" };

describe("probe stage version readiness", () => {
  it("waits through the route race and stale versions before calling the router or DO", async () => {
    const paths: string[] = [];
    const pending: string[] = [];
    let now = 0;
    const responses = [
      new Response("<html>Page not found</html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      }),
      Response.json({ ...health, versionId: "old-upload" }),
      Response.json({ ...health, workerName: "sb-another-stage" }),
      Response.json({ ...health, ready: false }),
      Response.json(health),
      new Response("Invalid session", { status: 400 }),
      Response.json({ retainedBytes: 0, memoryUsage: {}, heapStatistics: {} }),
    ];
    await waitForProbeRouter(url, "secret", {
      expectedVersionId: versionId,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      onPending: (reason) => pending.push(reason),
      fetch: async (request) => {
        paths.push(new URL(request.url).pathname);
        expect(request.headers.get("authorization")).toBe("Bearer secret");
        expect(request.cache).toBe("no-store");
        expect(request.redirect).toBe("error");
        const response = responses.shift();
        if (!response) throw new Error("Unexpected extra readiness request");
        return response;
      },
    });
    expect(paths).toEqual([
      "/probe/health",
      "/probe/health",
      "/probe/health",
      "/probe/health",
      "/probe/health",
      "/",
      "/root/status",
    ]);
    expect(pending).toEqual([
      "route-not-found",
      "stage-version-mismatch",
      "stage-version-mismatch",
      "stage-version-mismatch",
    ]);
    expect(now).toBe(2_000);
  });

  it("bounds stale version polling without ever accessing a session", async () => {
    let now = 0;
    let requests = 0;
    await expect(
      waitForProbeRouter(url, "secret", {
        expectedVersionId: versionId,
        timeoutMs: 1_000,
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds;
        },
        fetch: async (request) => {
          requests++;
          expect(new URL(request.url).pathname).toBe("/probe/health");
          expect(new URL(request.url).search).toBe("");
          return Response.json({ ...health, versionId: "old-upload" });
        },
      }),
    ).rejects.toThrow("did not serve the expected version for 1000 ms");
    expect(requests).toBe(2);
  });

  it.each([401, 500])("does not retry unexpected health HTTP %i", async (status) => {
    let requests = 0;
    await expect(
      waitForProbeRouter(url, "secret", {
        expectedVersionId: versionId,
        fetch: async () => {
          requests++;
          return new Response("failure", { status });
        },
      }),
    ).rejects.toThrow(`unexpected HTTP ${status}`);
    expect(requests).toBe(1);
  });
});
