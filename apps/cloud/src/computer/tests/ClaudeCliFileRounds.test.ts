import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("CLI filesystem rounds", () => {
  it("asks Computer once per metadata call during a background machine command", async () => {
    let machine = { machine: 0, machineRunning: false };
    const f = await fixture(1024, ["/sync"], false, {
      metadataLimit: 1_024,
      machine: () => machine,
      seed(fs) {
        fs.mkdirSync("/src");
        for (let index = 0; index < 200; index++) fs.writeFileSync(`/src/f${index}`, "x");
      },
    });
    try {
      // A dev server started in the background: a child that keeps running on the machine.
      await f.files.beforeRemote();
      machine = { machine: 1, machineRunning: true };
      await f.files.refresh();
      const before = f.calls.total;
      const started = performance.now();
      // A Glob-like walk: each entry's stat and realpath.
      for (const name of await f.fs.promises.readdir("/src"))
        await Promise.all([
          f.fs.promises.stat(`/src/${name}`),
          f.fs.promises.realpath(`/src/${name}`),
        ]);
      const seconds = Math.ceil((performance.now() - started) / 1_000);
      // One answer each from Computer (a listing takes three), and one check of Computer a second.
      expect(f.calls.total - before).toBeLessThanOrEqual(403 + seconds);
    } finally {
      await f.close();
    }
  });

  it("backs off a round that keeps failing, and traces it, while calls keep answering", async () => {
    const f = await fixture(1024, ["/sync"], false, { metadataLimit: 40 });
    try {
      // A child pushes the tree past what the view may index, as a large install can.
      await f.files.beforeRemote();
      f.canonical.mkdirSync("/many");
      for (let index = 0; index < 60; index++) f.canonical.writeFileSync(`/many/f${index}`, "");
      await f.files.afterRemote();
      const rounds = f.rounds;
      for (let index = 0; index < 20; index++) await f.files.barrier();
      expect(f.rounds - rounds).toBe(0);
      expect(f.traces).toContainEqual({ kind: "backoff", failures: 1, retryMs: 250 });
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
      expect((await f.fs.promises.stat("/many/f1")).isFile()).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("finishes a CLI call whose round could not refill descriptor leases", async () => {
    let failLeases = false;
    const f = await fixture(1024, ["/sync"], false, {
      onLeaseRefill() {
        if (failLeases) throw new Error("lease refill failed");
      },
    });
    try {
      const fd = f.fs.openSync("/sync", "r");
      failLeases = true;
      await expect(f.fs.promises.writeFile("/written", "async")).resolves.toBeUndefined();
      failLeases = false;
      f.fs.closeSync(fd);
      expect(f.canonical.readFileSync("/written", "utf8")).toBe("async");
    } finally {
      await f.close();
    }
  });
});
