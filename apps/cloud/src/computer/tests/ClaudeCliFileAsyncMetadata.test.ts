import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const DIRECTORIES = 40;
const FILES = 19_040;

const open = (metadataLimit = 128, files = 4) =>
  fixture(1024, [], false, {
    cwd: "/work",
    home: "/home/u",
    metadataLimit,
    seed(fs) {
      fs.mkdirSync("/home/u", { recursive: true });
      for (let directory = 0; directory < DIRECTORIES; directory++)
        fs.mkdirSync(`/work/d${directory}`, { recursive: true });
      for (let index = 0; index < files; index++)
        fs.writeFileSync(`/work/d${index % DIRECTORIES}/f${index}`, "x".repeat(index % 7));
    },
  });

describe("CLI filesystem async metadata", () => {
  it(
    "answers a walk of the replayed session's size from the view, not with a Computer call each",
    { timeout: 180_000 },
    async () => {
      const f = await open(32_768, FILES);
      try {
        const before = f.calls.total;
        const started = performance.now();
        // The replayed CLI's two minutes: about 56k stats and as many realpaths, many at once.
        for (let batch = 0; batch < 56; batch++) {
          const work: Promise<unknown>[] = [];
          for (let step = 0; step < 1_000; step++) {
            const index = batch * 1_000 + step;
            const path = `/work/d${index % DIRECTORIES}/f${index % (FILES + 500)}`;
            work.push(
              f.fs.promises.stat(path).then(
                (stat) => expect(stat.size).toBe((index % (FILES + 500)) % 7),
                (cause: { code?: string }) => expect(cause.code).toBe("ENOENT"),
              ),
              f.fs.promises.realpath(path).catch(() => undefined),
            );
          }
          await Promise.all(work);
        }
        await new Promise<void>((resolve, reject) =>
          f.fs.lstat("/work/d1", (error, stat) =>
            error ? reject(error) : resolve(expect(stat.isDirectory()).toBe(true)),
          ),
        );
        expect(await f.fs.promises.readdir("/work/d0")).toHaveLength(FILES / DIRECTORIES);
        await f.fs.promises.access("/work/d0/f0");
        // Computer is asked once a second at most, however many calls arrive in it.
        const seconds = Math.ceil((performance.now() - started) / 1_000);
        expect(f.calls.total - before).toBeLessThanOrEqual(seconds + 1);
      } finally {
        await f.close();
      }
    },
  );

  for (const machineRunning of [false, true])
    it(`sees a running child's writes at the next barrier${machineRunning ? ", from Computer during a machine command" : ""}`, async () => {
      let machine = { machine: 0, machineRunning: false };
      const f = await fixture(1024, [], false, { machine: () => machine });
      try {
        await f.files.beforeRemote();
        if (machineRunning) machine = { machine: 1, machineRunning: true };
        f.canonical.writeFileSync("/child", "written by a child");
        // A barrier's round reads the change feed; a machine command leaves only Computer knowing.
        await f.files.refresh();
        const calls = f.calls.total;
        expect((await f.fs.promises.stat("/child")).size).toBe(18);
        if (machineRunning) expect(f.calls.total).toBeGreaterThan(calls);
        else expect(f.calls.total).toBe(calls);
        machine = { machine: 1, machineRunning: false };
        await f.files.afterRemote();
        const after = f.calls.total;
        expect((await f.fs.promises.stat("/child")).size).toBe(18);
        expect(f.calls.total).toBe(after);
      } finally {
        await f.close();
      }
    });

  it("waits for a round in progress rather than answering from the view it replaces", async () => {
    const f = await open();
    try {
      f.canonical.writeFileSync("/work/late", "seen after the round");
      const round = f.holdNext("changes");
      const refreshing = f.files.refresh();
      await round.entered;
      const stat = f.fs.promises.stat("/work/late");
      round.release();
      await refreshing;
      expect((await stat).size).toBe(20);
    } finally {
      await f.close();
    }
  });
});
