// @effect-diagnostics globalTimers:off - The test lets the view's event-loop timer fire.
import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("CLI filesystem view traces", () => {
  it("reports index rounds and digest batches as counts, never paths", async () => {
    const f = await fixture(256, ["/sync", "/big"], false, {
      changeFeed: false,
      seed(fs) {
        fs.writeFileSync("/big", "b".repeat(100));
      },
    });
    try {
      f.traces.length = 0;
      await f.files.beforeRemote();
      f.canonical.writeFileSync("/sync", "child wrote");
      await f.files.afterRemote();
      const kinds = f.traces.map((event) =>
        event.kind === "round" || event.kind === "digest"
          ? `${event.kind}:${event.phase}`
          : event.kind,
      );
      expect(kinds).toEqual(["round:start", "digest:start", "digest:end", "round:end"]);
      expect(f.traces[0]).toMatchObject({ mode: "index", entries: expect.any(Number) });
      // Only the unchanged-size file is a digest candidate; the changed one is dropped outright.
      expect(f.traces[1]).toEqual({ kind: "digest", phase: "start", files: 1, bytes: 100 });
      expect(f.traces[2]).toMatchObject({
        files: 1,
        bytes: 100,
        unchanged: 0,
        durationMs: expect.any(Number),
      });
      expect(f.traces[3]).toMatchObject({
        mode: "index",
        entries: expect.any(Number),
        durationMs: expect.any(Number),
      });
      expect(JSON.stringify(f.traces)).not.toMatch(/\/sync|\/big/);
    } finally {
      await f.close();
    }
  });

  it("verifies Computer's own files from its change feed instead of hashing them", async () => {
    let machine = { machine: 0, machineRunning: false };
    const f = await fixture(256, ["/sync", "/big", "/lower"], false, {
      machine: () => machine,
      lowerPaths: (path) => path === "/lower",
      seed(fs) {
        fs.writeFileSync("/big", "b".repeat(100));
        fs.writeFileSync("/lower", "machine bytes");
      },
    });
    try {
      const bytes = f.prefetchedBytes;
      // A machine command runs, so Computer can't list changes and the view re-indexes.
      machine = { machine: 1, machineRunning: true };
      f.traces.length = 0;
      await f.fs.promises.stat("/sync");
      const digests = f.traces.filter((event) => event.kind === "digest" && event.phase === "end");
      // The machine's file is still hashed; Computer's two are proven unchanged without a read.
      expect(digests).toEqual([expect.objectContaining({ files: 3, unchanged: 2 })]);
      expect(f.prefetchedBytes - bytes).toBe(0);
      expect(f.fs.readFileSync("/big", "utf8")).toBe("b".repeat(100));
      expect(f.fs.readFileSync("/lower", "utf8")).toBe("machine bytes");
    } finally {
      await f.close();
    }
  });

  it("reports a held event loop with the view's last call", async () => {
    const f = await fixture();
    try {
      f.traces.length = 0;
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
      const held = performance.now() + 400;
      while (performance.now() < held);
      // The view's timer expired first, so it runs before this one.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const lag = f.traces.find((event) => event.kind === "loop-lag");
      expect(lag).toMatchObject({ kind: "loop-lag", lagMs: expect.any(Number) });
      expect(lag?.kind === "loop-lag" && lag.lagMs).toBeGreaterThanOrEqual(250);
      expect(lag?.kind === "loop-lag" && lag.activity).toMatch(/^no round, \w+$/);
    } finally {
      await f.close();
    }
  });
});
