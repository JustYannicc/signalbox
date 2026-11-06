// @effect-diagnostics globalTimers:off - The test measures how late a real timer fires.
import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

// The scale of the replayed session's read view: 19,092 entries, 1,544 files and 55 MB of bytes.
const FILES = 1_544;
const EMPTY = 17_500;
const BYTES = 55 * 1024 * 1024;

describe("CLI filesystem event loop", () => {
  it(
    "keeps timers firing while a fallback index runs at real scale",
    { timeout: 180_000 },
    async () => {
      const size = Math.floor(BYTES / FILES);
      const paths = Array.from({ length: FILES }, (_, index) => `/d${index % 40}/f${index}`);
      const f = await fixture(64 * 1024 * 1024, paths, false, {
        metadataLimit: 32_768,
        changeFeed: false,
        seed(fs) {
          const bytes = new Uint8Array(size).fill(97);
          for (let directory = 0; directory < 40; directory++) fs.mkdirSync(`/d${directory}`);
          for (const path of paths) fs.writeFileSync(path, bytes);
          for (let index = 0; index < EMPTY; index++)
            fs.writeFileSync(`/d${index % 40}/e${index}`, "");
        },
      });
      let longest = 0;
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
      }, 10);
      try {
        const refreshes = f.refreshes;
        // A child changed one file and Computer can't list changes, so the view re-indexes.
        await f.files.beforeRemote();
        f.canonical.writeFileSync(paths[0]!, "changed");
        last = performance.now();
        longest = 0;
        await f.files.afterRemote();
        expect(f.refreshes - refreshes).toBe(1);
        expect(f.fs.readFileSync(paths[0]!, "utf8")).toBe("changed");
        expect(longest, `longest timer gap ${longest.toFixed(0)} ms`).toBeLessThan(250);
      } finally {
        clearInterval(timer);
        await f.close();
      }
    },
  );
});
