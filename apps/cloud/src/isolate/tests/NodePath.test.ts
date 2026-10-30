// @effect-diagnostics nodeBuiltinImport:off - PassThrough supplies streams for the explicit host context in these tests.
import * as NodeStream from "node:stream";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { createNodeProcess, type NodeProcessHostContext } from "../NodeProcess.ts";
import { createNodePath } from "../NodePath.ts";
import { getNodeBuiltinCapability } from "../NodeBuiltinCapabilities.ts";

function host(initialCwd: string): NodeProcessHostContext {
  let cwd = initialCwd;
  return {
    filesystem: {
      get cwd() {
        return cwd;
      },
      chdir(path) {
        cwd = path;
      },
    },
    env: {},
    identity: {
      version: "v22.12.0",
      versions: { node: "22.12.0" },
      platform: "linux",
      arch: "x64",
      homedir: "/home/host",
      tmpdir: "/tmp/host",
      pid: 81,
      ppid: 1,
      execPath: "/usr/bin/node",
      argv0: "node",
      argv: ["node"],
    },
    streams: {
      stdin: new NodeStream.PassThrough(),
      stdout: new NodeStream.PassThrough(),
      stderr: new NodeStream.PassThrough(),
    },
  };
}

describe("Node path facet", () => {
  it("resolves relative paths from the host cwd and observes process.chdir", () => {
    const context = host("/work/one");
    const path = createNodePath(context.filesystem);
    const process = createNodeProcess(context);

    expect(path.resolve("src", "entry.js")).toBe("/work/one/src/entry.js");
    expect(path.posix.resolve("src")).toBe("/work/one/src");
    process.chdir("/work/two");
    expect(path.resolve("src")).toBe("/work/two/src");
  });

  it("keeps path resolution isolated between session filesystems", () => {
    const first = createNodePath(host("/first").filesystem);
    const second = createNodePath(host("/second").filesystem);

    expect(first.resolve("file.txt")).toBe("/first/file.txt");
    expect(second.resolve("file.txt")).toBe("/second/file.txt");
  });

  it("resolves Windows paths without consulting native process cwd", () => {
    const path = createNodePath(host("/posix/session").filesystem);

    expect(path.win32.resolve("folder", "file.txt")).toBe("\\posix\\session\\folder\\file.txt");
    expect(() => path.win32.resolve("D:relative.txt")).toThrow(
      expect.objectContaining({ code: "ENOTSUP" }),
    );
    expect(path.win32.join("C:\\work", "folder")).toBe("C:\\work\\folder");
  });

  it("keeps nested platform aliases on the session-aware path objects", () => {
    let stale = false;
    const path = createNodePath({
      get cwd() {
        if (stale) throw Object.assign(new Error("cwd is stale"), { code: "ESTALE" });
        return "/session";
      },
      chdir() {},
    });

    expect(path.posix.posix).toBe(path.posix);
    expect(path.posix.win32).toBe(path.win32);
    expect(path.win32.posix).toBe(path.posix);
    expect(path.win32.win32).toBe(path.win32);

    stale = true;
    let failure: unknown;
    try {
      path.posix.posix.resolve("file");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "ESTALE" });
  });

  it("binds pure path declarations to native POSIX and Windows behavior without sharing metadata", () => {
    const path = createNodePath(host("/session").filesystem);
    for (const flavor of ["posix", "win32"] as const) {
      const module = path[flavor];
      const native = NodePath[flavor];
      const sample =
        flavor === "posix" ? "/one/../two/archive.tar.gz" : "C:\\one\\..\\two\\archive.tar.gz";
      expect(module.basename(sample, ".gz")).toBe(native.basename(sample, ".gz"));
      expect(module.dirname(sample)).toBe(native.dirname(sample));
      expect(module.extname(sample)).toBe(".gz");
      expect(module.isAbsolute(sample)).toBe(true);
      expect(module.isAbsolute("relative")).toBe(false);
      expect(module.join("one", "..", "two")).toBe(native.join("one", "..", "two"));
      expect(module.normalize(sample)).toBe(native.normalize(sample));
      expect(module.parse(sample)).toEqual(native.parse(sample));
      for (const name of [
        "basename",
        "dirname",
        "extname",
        "isAbsolute",
        "join",
        "normalize",
        "parse",
      ] as const) {
        expect(getNodeBuiltinCapability(module[name])?.status).toBe("supported");
        expect(module[name]).not.toBe(native[name]);
        expect(getNodeBuiltinCapability(native[name])).toBeUndefined();
      }
    }
    for (const name of ["resolve", "relative", "toNamespacedPath"] as const) {
      expect(getNodeBuiltinCapability(path.win32[name])?.status).toBe("conditional");
    }
    expect(path.win32.relative("D:\\one", "D:\\two")).toBe("..\\two");
    expect(path.win32.toNamespacedPath("D:\\one")).toBe("\\\\?\\D:\\one");
    for (const resolve of [
      () => path.win32.resolve("D:one"),
      () => path.win32.relative("D:one", "D:two"),
      () => path.win32.toNamespacedPath("D:one"),
    ]) {
      expect(resolve).toThrow(expect.objectContaining({ code: "ENOTSUP" }));
    }
  });
});
