import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const WATCHERS = 10;

afterEach(() => {
  vi.useRealTimers();
});

describe("CLI filesystem watchFile", () => {
  it("polls each watcher at Node's interval with no errors, while a child runs and a round reads", async () => {
    const f = await fixture(1024, ["/sync"], false, {
      seed(fs) {
        for (let index = 0; index < WATCHERS; index++) fs.writeFileSync(`/w${index}`, "x");
      },
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stat = vi.spyOn(f.files.backend, "stat");
    const errors: unknown[] = [];
    const changes: { path: string; size: number; previous: number }[] = [];
    const watchers: ReturnType<typeof f.fs.watchFile>[] = [];
    try {
      // A child that lives as long as the session, like an MCP server.
      await f.files.beforeRemote();
      for (const path of [
        ...Array.from({ length: WATCHERS }, (_, index) => `/w${index}`),
        "/gone",
      ]) {
        const watcher = f.fs.watchFile(path, (current, previous) =>
          changes.push({ path, size: current.size, previous: previous.mtimeMs }),
        );
        watcher.on("error", (error) => errors.push(error));
        watchers.push(watcher);
      }
      let round: ReturnType<typeof f.holdNext> | undefined;
      let refreshing: Promise<void> | undefined;
      for (let second = 0; second < 30; second++) {
        if (second === 10) {
          f.canonical.writeFileSync("/w1", "the child wrote this");
          await f.files.afterRemote();
        }
        if (second === 15) {
          f.canonical.writeFileSync("/w0", "changed");
          round = f.holdNext("lookup");
          refreshing = f.files.refresh();
          await round.entered;
        }
        if (second === 20) {
          round!.release();
          await refreshing;
        }
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(errors).toEqual([]);
      const polls = stat.mock.calls.filter(([path]) => /^\/(?:w\d+|gone)$/.test(String(path)));
      // One first stat each, then one every 5,007 ms: five in 30 s.
      expect(polls).toHaveLength((WATCHERS + 1) * 6);
      expect(changes.filter((change) => change.path === "/w1")).toEqual([
        { path: "/w1", size: 20, previous: expect.any(Number) },
      ]);
      expect(changes.filter((change) => change.path === "/w0")).toEqual([
        { path: "/w0", size: 7, previous: expect.any(Number) },
      ]);
      // A missing file reports Node's zeroed Stats, once.
      expect(changes.filter((change) => change.path === "/gone")).toEqual([
        { path: "/gone", size: 0, previous: 0 },
      ]);
    } finally {
      for (const watcher of watchers) watcher.stop();
      vi.useRealTimers();
      await f.close();
    }
  });
});
