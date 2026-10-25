// @effect-diagnostics nodeBuiltinImport:off - Builtin injection is isolated to this test subprocess.
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

interface ChokidarProbeResult {
  ready: boolean;
  events: Array<{ event: string; path: string }>;
  watchFilePaths: string[];
  firstWatchFileError?: { code?: string; syscall?: string; path?: string };
  closed: boolean;
}

describe("Chokidar over the kernel-backed Node fs", () => {
  it("watches an in-memory tree through ready, file changes and close", () => {
    const probePath = NodeURL.fileURLToPath(
      new URL("./testing/chokidarKernelProbe.ts", import.meta.url),
    );
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      ["--experimental-strip-types", probePath],
      {
        env: { ...process.env, CHOKIDAR_USEPOLLING: "1" },
        encoding: "utf8",
        timeout: 5_000,
      },
    );

    const resultLine = child.stdout.trim().split("\n").at(-1);
    expect(child.error).toBeUndefined();
    const output = `${child.stderr}\n${child.stdout}`;
    expect(child.status, output).toBe(0);
    expect(resultLine, output).toBeDefined();
    const result = JSON.parse(resultLine!) as ChokidarProbeResult;

    expect(result.firstWatchFileError).toBeUndefined();
    expect(result.ready).toBe(true);
    expect([...result.watchFilePaths].sort()).toEqual(
      ["/skills", "/skills/one.md", "/skills/two.md"].sort(),
    );
    expect(result.events).toEqual([
      { event: "add", path: "/skills/one.md" },
      { event: "change", path: "/skills/one.md" },
      { event: "add", path: "/skills/two.md" },
      { event: "unlink", path: "/skills/one.md" },
    ]);
    expect(result.closed).toBe(true);
  });
});
