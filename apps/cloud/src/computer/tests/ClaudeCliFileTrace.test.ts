// @effect-diagnostics globalTimers:off - The test lets the view's event-loop timer fire.
import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";
import { lowerLayer } from "./helpers/lowerLayer.ts";

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
    const lower = lowerLayer({ "/etc/tool.conf": "machine bytes" });
    let machine = { machine: 0, machineRunning: false };
    const f = await fixture(256, ["/sync", "/big", "/etc/tool.conf"], true, {
      machine: () => machine,
      seed(fs, files) {
        fs.writeFileSync("/big", "b".repeat(100));
        lower.install(files);
      },
    });
    try {
      const bytes = f.prefetchedBytes;
      // A machine command runs, so Computer can't list changes and the view re-indexes.
      machine = { machine: 1, machineRunning: true };
      f.traces.length = 0;
      await f.files.refresh();
      const digests = f.traces.filter((event) => event.kind === "digest" && event.phase === "end");
      // The machine's file is still hashed; Computer's two are proven unchanged without a read.
      expect(digests).toEqual([expect.objectContaining({ files: 3, unchanged: 2 })]);
      expect(f.prefetchedBytes - bytes).toBe(0);
      expect(f.fs.readFileSync("/big", "utf8")).toBe("b".repeat(100));
      expect(f.fs.readFileSync("/etc/tool.conf", "utf8")).toBe("machine bytes");
    } finally {
      await f.close();
    }
  });

  it("re-reads Computer's file rewritten at the same size and inode during an index", async () => {
    let machine = { machine: 0, machineRunning: false };
    let rewrite = () => {};
    const f = await fixture(256, ["/sync", "/big"], false, {
      machine: () => machine,
      duringRefresh: () => rewrite(),
      seed(fs) {
        fs.writeFileSync("/big", "b".repeat(100));
      },
    });
    try {
      machine = { machine: 1, machineRunning: true };
      // Same inode and size, and this fixture's clock gives the same mtime too.
      rewrite = () => {
        rewrite = () => {};
        f.canonical.writeFileSync("/big", "c".repeat(100));
      };
      await f.files.refresh();
      expect(f.refreshes).toBeGreaterThan(1);
      expect(f.fs.readFileSync("/big", "utf8")).toBe("c".repeat(100));
    } finally {
      await f.close();
    }
  });

  it("never vouches for a machine file rewritten at the same size", async () => {
    const lower = lowerLayer({ "/etc/tool.conf": "v1" });
    let machine = { machine: 0, machineRunning: false };
    const f = await fixture(256, ["/sync", "/etc/tool.conf"], true, {
      machine: () => machine,
      seed: (_fs, files) => lower.install(files),
    });
    try {
      expect(f.fs.readFileSync("/etc/tool.conf", "utf8")).toBe("v1");
      machine = { machine: 1, machineRunning: true };
      lower.write("/etc/tool.conf", "v2");
      lower.refreshAfterCommand();
      f.traces.length = 0;
      await f.files.refresh();
      // Only Computer's own /sync is vouched for; the machine file is hashed and re-read.
      expect(f.traces.filter((event) => event.kind === "digest" && event.phase === "end")).toEqual([
        expect.objectContaining({ files: 2, unchanged: 1 }),
      ]);
      expect(f.fs.readFileSync("/etc/tool.conf", "utf8")).toBe("v2");
    } finally {
      await f.close();
    }
  });

  it("keeps traces in Computer's own log when the session never reaches a turn", async () => {
    const f = await fixture(256, ["/sync", "/big"], false, {
      changeFeed: false,
      seed(fs) {
        fs.writeFileSync("/big", "b".repeat(100));
      },
    });
    try {
      // There is no turn here: the view opens, indexes again, and the CLI goes quiet.
      await f.files.beforeRemote();
      f.canonical.writeFileSync("/sync", "child wrote");
      await f.files.afterRemote();
      await f.files.barrier();
      const all = f.traceRows();
      // Computer traces each page of an index it reads; the view traces the rounds around them.
      expect(
        all
          .filter(({ source }) => source === "kernel")
          .map(({ event }) => `${event.kind}:${event.phase}`),
      ).toEqual(["index-page:start", "index-page:end", "index-page:start", "index-page:end"]);
      const rows = all.filter(({ source }) => source === "cli");
      expect(rows.map(({ event }) => `${event.kind}:${event.phase}:${event.mode ?? ""}`)).toEqual([
        "round:start:index",
        "round:end:index",
        "round:start:index",
        "digest:start:",
        "digest:end:",
        "round:end:index",
      ]);
      expect(JSON.stringify(all)).not.toMatch(/\/sync|\/big/);
    } finally {
      await f.close();
    }
  });

  it("indexes past a file removed between its directory listing and its lstat", async () => {
    let remove: (() => void) | undefined;
    const f = await fixture(256, ["/sync"], false, {
      changeFeed: false,
      seed(fs, files) {
        fs.writeFileSync("/victim", "gone soon");
        // Where storage can take no snapshot, the index reads path by path.
        files.metadataTree = () => undefined;
        const readdir = files.readdirAsync.bind(files);
        files.readdirAsync = async (...args) => {
          const names = await readdir(...args);
          // The CLI's rename onto it, or another writer, lands while the walk yields.
          if (args[0] === "/" && remove !== undefined) remove();
          return names;
        };
      },
    });
    try {
      remove = () => {
        remove = undefined;
        f.canonical.unlinkSync("/victim");
      };
      await f.files.beforeRemote();
      f.canonical.writeFileSync("/sync", "child wrote");
      await f.files.afterRemote();
      expect(f.fs.readdirSync("/")).not.toContain("victim");
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("child wrote");
    } finally {
      await f.close();
    }
  });

  it("indexes from one snapshot, so a file removed while it is read is gone by the next round", async () => {
    let remove: (() => void) | undefined;
    const f = await fixture(256, ["/sync"], false, {
      changeFeed: false,
      seed(fs, files) {
        fs.writeFileSync("/victim", "gone soon");
        const metadataTree = files.metadataTree.bind(files);
        files.metadataTree = (maxEntries) => {
          const tree = metadataTree(maxEntries);
          remove?.();
          return tree;
        };
      },
    });
    try {
      remove = () => {
        remove = undefined;
        f.canonical.unlinkSync("/victim");
      };
      await f.files.beforeRemote();
      f.canonical.writeFileSync("/sync", "child wrote");
      await f.files.afterRemote();
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("child wrote");
      await f.files.barrier();
      expect(f.fs.readdirSync("/")).not.toContain("victim");
    } finally {
      await f.close();
    }
  });

  it("finishes an index when the CLI unlinks a file while Computer digests it", async () => {
    const f = await fixture(256, ["/sync", "/big"], false, {
      changeFeed: false,
      seed(fs) {
        fs.writeFileSync("/big", "b".repeat(100));
      },
    });
    const gate = f.holdNext("digest");
    let after: Promise<void> | undefined;
    try {
      await f.files.beforeRemote();
      f.canonical.writeFileSync("/sync", "child wrote");
      after = f.files.afterRemote();
      void after.catch(() => {});
      await gate.entered;
      f.fs.unlinkSync("/big");
      gate.release();
      await expect(after).resolves.toBeUndefined();
      expect(f.fs.existsSync("/big")).toBe(false);
      await f.files.barrier();
      expect(f.canonical.existsSync("/big")).toBe(false);
    } finally {
      gate.release();
      await Promise.allSettled([after]);
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
