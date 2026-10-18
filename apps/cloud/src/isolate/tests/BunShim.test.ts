import { describe, expect, it } from "@effect/vitest";

import {
  BunCapabilityUnavailable,
  createBunShim,
  installBunShim,
  type BunShimHost,
} from "../BunShim.ts";

const host = (onMissing: BunShimHost["onMissing"] = () => {}): BunShimHost => ({
  env: {},
  main: "/cli",
  version: "1.4.3",
  onMissing,
});

describe("isolate Bun installation and host boundaries", () => {
  it("accepts Bun's leading-zero versions when comparing and matching ranges", () => {
    const bun = createBunShim(host()).bun;
    expect(bun.semver.order("01.2.3", "1.2.3")).toBe(0);
    expect(bun.semver.order("1.02.4", "1.2.3")).toBe(1);
    expect(bun.semver.satisfies("01.2.3", ">=1.0.0")).toBe(true);
    expect(bun.semver.satisfies("01.2.3", "^2.0.0")).toBe(false);
  });

  it("preserves prototypes and sparse arrays during strict equality", () => {
    class Entry {
      value = 1;
    }
    const bun = createBunShim(host()).bun;
    expect(bun.deepEquals(new Entry(), { value: 1 })).toBe(true);
    expect(bun.deepEquals(new Entry(), { value: 1 }, true)).toBe(false);
    expect(bun.deepEquals(new Entry(), new Entry(), true)).toBe(true);
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(bun.deepEquals(sparse, [undefined], true)).toBe(false);
    expect(bun.deepEquals({ value: undefined }, {}, true)).toBe(false);
  });

  it("preserves process options and lifecycle without native subprocesses", async () => {
    const seen: unknown[] = [];
    let exitCode: number | null = null;
    const child = {
      pid: 9,
      exited: Promise.resolve(3).then((value) => {
        exitCode = value;
        return value;
      }),
      get exitCode() {
        return exitCode;
      },
      kill(signal?: string | number) {
        seen.push([this.pid, signal]);
      },
      ref() {
        seen.push([this.pid, "ref"]);
      },
      unref() {
        seen.push([this.pid, "unref"]);
      },
    };
    const bun = createBunShim({
      ...host(),
      spawn: (command, options) => {
        seen.push([command, options]);
        return child;
      },
    }).bun;
    const options = {
      cmd: ["bash", "hook.sh"],
      cwd: "/work",
      env: { MARKER: "yes" },
      stdio: ["ignore", "pipe", 2],
      argv0: "hook",
    };
    const process = bun.spawn(options);
    expect(seen[0]).toEqual([options.cmd, options]);
    expect(await process.exited).toBe(3);
    expect(process.exitCode).toBe(3);
    process.kill("SIGTERM");
    process.ref();
    process.unref();
    expect(seen.slice(1)).toEqual([
      [9, "SIGTERM"],
      [9, "ref"],
      [9, "unref"],
    ]);
    expect(() => bun.spawn([])).toThrow(TypeError);
  });

  it("reports unknown APIs once per installation and supplies no private ant API", () => {
    const missing: string[] = [];
    const installation = installBunShim(
      host((path) => {
        missing.push(path);
      }),
    );
    try {
      const bun = installation.bun as typeof installation.bun & Record<string, unknown>;
      expect(bun.unreleasedMember).toBeUndefined();
      expect(bun.unreleasedMember).toBeUndefined();
      expect(bun.ant.CellSegmenter).toBeUndefined();
      expect(Reflect.get(bun.hash, "futureHash")).toBeUndefined();
      expect(installation.missingMembers).toEqual([
        "ant.CellSegmenter",
        "hash.futureHash",
        "unreleasedMember",
      ]);
      expect(missing).toEqual(["unreleasedMember", "ant.CellSegmenter", "hash.futureHash"]);
    } finally {
      installation.restore();
    }
    expect(createBunShim(host()).missingMembers).toEqual([]);
  });

  it("fails missing host capabilities explicitly and accepts an isolate-owned compiler", async () => {
    const bun = createBunShim(host()).bun;
    expect(() => bun.spawn(["bash"])).toThrow(BunCapabilityUnavailable);
    expect(() => bun.which("bash")).toThrow(BunCapabilityUnavailable);
    expect(() => bun.sleepSync()).toThrow(BunCapabilityUnavailable);
    await expect(bun.file("/work/x").text()).rejects.toThrow(BunCapabilityUnavailable);
    const build = async () => ({ outputs: ["compiled hook"] });
    const provided = createBunShim({ ...host(), capabilities: { build } }).bun;
    expect(provided.build).toBe(build);
  });
});
