// @effect-diagnostics nodeBuiltinImport:off - PassThrough streams model the explicit process pipe.
import * as NodeStream from "node:stream";
import { describe, expect, it } from "@effect/vitest";

import { NodeBridgeError, createNodeBridge } from "../NodeBridge.ts";
import { getNodeBuiltinCapability } from "../NodeBuiltinCapabilities.ts";
import {
  createNodeProcess,
  NodeProcessExitError,
  NodeSystemError,
  type NodeProcessHostContext,
} from "../NodeProcess.ts";

function host(pid: number): NodeProcessHostContext {
  let cwd = "/work";
  return {
    filesystem: {
      get cwd() {
        return cwd;
      },
      chdir(path) {
        cwd = path;
      },
    },
    env: { HOME: "/home/test" },
    identity: {
      version: "v22.15.0",
      versions: { node: "22.15.0" },
      platform: "linux",
      arch: "x64",
      homedir: "/home/test",
      tmpdir: "/tmp",
      pid,
      ppid: 1,
      execPath: "/usr/bin/node",
      argv0: "node",
      argv: ["node", "/work/main.js"],
    },
    streams: {
      stdin: new NodeStream.PassThrough(),
      stdout: new NodeStream.PassThrough(),
      stderr: new NodeStream.PassThrough(),
    },
  };
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function destroyStreams(process: ReturnType<typeof createNodeProcess>): void {
  process.stdin.destroy();
  process.stdout.destroy();
  process.stderr.destroy();
}

describe("Node process compatibility functions", () => {
  it("returns modules from the active personality and undefined for unavailable ids", () => {
    const fs = { owner: "personality" };
    const bridge = createNodeBridge({ fs });
    const context = host(201);
    const process = createNodeProcess({
      ...context,
      resolveBuiltinModule(specifier) {
        try {
          return bridge.require(specifier);
        } catch (error) {
          if (
            error instanceof NodeBridgeError &&
            (error.code === "NODE_BUILTIN_UNKNOWN" || error.code === "NODE_BUILTIN_UNAVAILABLE")
          ) {
            return undefined;
          }
          throw error;
        }
      },
    });

    try {
      const { getBuiltinModule } = process;
      expect(getBuiltinModule("node:fs")).toBe(fs);
      expect(getBuiltinModule("not-a-builtin")).toBeUndefined();
    } finally {
      destroyStreams(process);
    }
  });

  it("routes reallyExit through the process-owned terminal path", () => {
    const process = createNodeProcess(host(202));
    const exits: number[] = [];
    process.on("exit", (code: number) => exits.push(code));

    try {
      const error = thrownBy(() => process.reallyExit(17));
      expect(error).toBeInstanceOf(NodeProcessExitError);
      if (!(error instanceof NodeProcessExitError)) throw error;
      expect(error.code).toBe(17);
      expect(process.state).toBe("exited");
      expect(exits).toEqual([17]);
    } finally {
      destroyStreams(process);
    }
  });

  it("reports ENOSYS for execve without claiming an image replacement", () => {
    const process = createNodeProcess(host(203));

    try {
      const error = thrownBy(() =>
        process.execve("/usr/bin/tool", ["tool", "--flag"], { MODE: "test" }),
      );
      if (!(error instanceof NodeSystemError)) throw error;
      expect(error).toMatchObject({
        code: "ENOSYS",
        syscall: "execve",
        path: "/usr/bin/tool",
      });
      expect(error.message).toContain("function not implemented");
      expect(process.state).toBe("running");
      expect(getNodeBuiltinCapability(process.execve)).toMatchObject({
        status: "platform-pruned",
        evidence: expect.stringContaining("ENOSYS"),
      });
      expect(() => process.execve("/usr/bin/tool\0", ["tool"], {})).toThrow(TypeError);
      expect(() => process.execve("/usr/bin/tool", ["tool\0"], {})).toThrow(TypeError);
      expect(() => process.execve("/usr/bin/tool", ["tool"], { MODE: "bad\0value" })).toThrow(
        TypeError,
      );
    } finally {
      destroyStreams(process);
    }
  });

  it("keeps stdin as a non-TTY pipe with no raw mode and per-instance ref methods", () => {
    const context = host(204);
    const nativeWrite: unknown = Reflect.get(NodeStream.Writable.prototype, "write");
    const process = createNodeProcess(context);

    try {
      expect(process.stdin).toBe(context.streams.stdin);
      expect(process.stdin.isTTY).toBe(false);
      expect(Reflect.has(process.stdin, "setRawMode")).toBe(false);
      expect(process.stdin.ref()).toBe(process.stdin);
      expect(process.stdin.unref()).toBe(process.stdin);
      expect(process.stdout.write).not.toBe(nativeWrite);
      expect(getNodeBuiltinCapability(process.stdout.write)).toMatchObject({ status: "supported" });
      if (typeof nativeWrite === "function") {
        expect(getNodeBuiltinCapability(nativeWrite)).toBeUndefined();
      }
    } finally {
      destroyStreams(process);
    }
  });
});
