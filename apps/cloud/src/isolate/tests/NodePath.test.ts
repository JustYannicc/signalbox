// @effect-diagnostics nodeBuiltinImport:off - PassThrough supplies streams for the explicit host context in these tests.
import * as NodeStream from "node:stream";
import { describe, expect, it } from "@effect/vitest";

import { createNodeProcess, type NodeProcessHostContext } from "../NodeProcess.ts";
import { createNodePath } from "../NodePath.ts";

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
    expect(path.win32.resolve("D:relative.txt")).toBe("D:\\relative.txt");
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
});
