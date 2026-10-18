// @effect-diagnostics nodeBuiltinImport:off - PassThrough supplies streams for the explicit host context in these tests.
import * as NodeStream from "node:stream";
import { describe, expect, it } from "@effect/vitest";

import { kernelError, kernelOk } from "../../kernel/KernelAbi.ts";
import { createNodePath } from "../NodePath.ts";
import {
  createNodeProcess,
  NodeProcessExitError,
  NodeSystemError,
  type NodeProcessHostContext,
} from "../NodeProcess.ts";

function host(pid: number, initialCwd = "/work/one"): NodeProcessHostContext {
  let cwd = initialCwd;
  return {
    filesystem: {
      get cwd() {
        return cwd;
      },
      chdir(path) {
        cwd = path.startsWith("/") ? path : `${cwd}/${path}`;
      },
    },
    env: { HOME: `/home/${pid}`, TMPDIR: `/tmp/${pid}` },
    identity: {
      version: "v22.12.0",
      versions: { node: "22.12.0", v8: "12.4.254.21-node.21" },
      platform: "linux",
      arch: "x64",
      homedir: `/home/${pid}`,
      tmpdir: `/tmp/${pid}`,
      pid,
      ppid: 7,
      execPath: "/usr/bin/node",
      argv0: "node",
      argv: ["node", `/work/${pid}.js`],
      main: { filename: `/work/${pid}.js` },
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

describe("Node process facet", () => {
  it("keeps identity, environment, cwd and streams scoped to each host", () => {
    const firstHost = host(41);
    const secondHost = host(42, "/work/two");
    const first = createNodeProcess(firstHost);
    const second = createNodeProcess(secondHost);

    first.env.MARKER = "first";
    first.chdir("/work/changed");
    first.argv.push("--debug");

    expect(first.cwd()).toBe("/work/changed");
    expect(first.version).toBe("v22.12.0");
    expect(first.versions.node).toBe("22.12.0");
    expect(first.pid).toBe(41);
    expect(first.ppid).toBe(7);
    expect(first.execPath).toBe("/usr/bin/node");
    expect(first.argv0).toBe("node");
    expect(first.main).toEqual({ filename: "/work/41.js" });
    expect(first.stdin).toBe(firstHost.streams.stdin);
    expect(second.cwd()).toBe("/work/two");
    expect(second.env.MARKER).toBeUndefined();
    expect(second.argv).toEqual(["node", "/work/42.js"]);
  });

  it("exports own bound methods that remain callable after destructuring", async () => {
    let killCall: { parentProcessHandle: unknown; selector: number; signal: number } | undefined;
    const context: NodeProcessHostContext = {
      ...host(45),
      processes: {
        signalPid: (parentProcessHandle, selector, signal) => {
          killCall = { parentProcessHandle, selector, signal };
          return kernelOk(undefined);
        },
      },
    };
    const process = createNodeProcess(context);
    const { cwd, chdir, nextTick, kill } = process;

    expect(Object.hasOwn(process, "cwd")).toBe(true);
    expect(Object.hasOwn(process, "chdir")).toBe(true);
    expect(Object.hasOwn(process, "nextTick")).toBe(true);
    expect(Object.hasOwn(process, "kill")).toBe(true);
    expect(Object.hasOwn(process, "on")).toBe(true);
    expect(Object.hasOwn(process, "exit")).toBe(true);
    expect(Object.hasOwn(process, "exitCode")).toBe(true);
    expect(Object.hasOwn(process, "hrtime")).toBe(true);
    expect(Object.keys(process)).toContain("cwd");
    expect(Object.keys(process)).toContain("exitCode");
    expect(cwd()).toBe("/work/one");
    chdir("/work/destructured");
    expect(cwd()).toBe("/work/destructured");
    expect(kill(45)).toBe(true);
    expect(killCall).toEqual({ parentProcessHandle: undefined, selector: 45, signal: 15 });
    await new Promise<void>((resolve) => nextTick(() => resolve()));
  });

  it("reads cwd from the host resolver each time and preserves fail-closed ESTALE", () => {
    const baseHost = host(46);
    const staleError = Object.assign(new Error("cwd ancestry changed"), { code: "ESTALE" });
    let stale = false;
    const filesystem: NodeProcessHostContext["filesystem"] = {
      get cwd() {
        if (stale) throw staleError;
        return baseHost.filesystem.cwd;
      },
      chdir(path) {
        if (stale) throw staleError;
        baseHost.filesystem.chdir(path);
      },
    };
    const context = { ...baseHost, filesystem };
    const process = createNodeProcess(context);
    const path = createNodePath(filesystem);
    stale = true;

    expect(thrownBy(() => process.cwd())).toBe(staleError);
    expect(thrownBy(() => process.chdir("/work/next"))).toBe(staleError);
    expect(thrownBy(() => path.resolve("src"))).toBe(staleError);
  });

  it("emits exit once and throws a process-owned terminal exception", () => {
    const process = createNodeProcess(host(51));
    const exitCodes: number[] = [];
    process.on("exit", (code: number) => exitCodes.push(code));
    process.exitCode = 12;

    expect(() => process.exit()).toThrow(NodeProcessExitError);
    expect(process.state).toBe("exited");
    expect(process.exitCode).toBe(12);
    expect(exitCodes).toEqual([12]);
    expect(() => process.exit(4)).toThrow(NodeProcessExitError);
    expect(exitCodes).toEqual([12]);
  });

  it("validates exit codes before entering the terminal state", () => {
    const process = createNodeProcess(host(52));
    expect(() => {
      process.exitCode = 256;
    }).toThrow(RangeError);
    expect(() => process.exit(-1)).toThrow(RangeError);
    expect(process.state).toBe("running");
  });

  it("routes pid and group selectors plus arbitrary supported signals through the process table", () => {
    const calls: Array<{ parentProcessHandle: unknown; selector: number; signal: number }> = [];
    const baseHost = host(61);
    const firstHost: NodeProcessHostContext = {
      ...baseHost,
      processes: {
        signalPid: (parentProcessHandle, selector, signal) => {
          calls.push({ parentProcessHandle, selector, signal });
          return kernelOk(undefined);
        },
      },
    };
    const process = createNodeProcess(firstHost);

    expect(process.kill(61, "SIGTERM")).toBe(true);
    expect(process.kill(-3, "SIGINT")).toBe(true);
    expect(process.kill(0, 64)).toBe(true);
    expect(process.kill(2, 0)).toBe(true);
    expect(process.kill(4)).toBe(true);
    expect(calls).toEqual([
      { parentProcessHandle: undefined, selector: 61, signal: 15 },
      { parentProcessHandle: undefined, selector: -3, signal: 2 },
      { parentProcessHandle: undefined, selector: 0, signal: 64 },
      { parentProcessHandle: undefined, selector: 2, signal: 0 },
      { parentProcessHandle: undefined, selector: 4, signal: 15 },
    ]);

    const notFound = createNodeProcess({
      ...baseHost,
      processes: { signalPid: () => kernelError("NOT_FOUND", "No matching process") },
    });
    const missingProcessError = thrownBy(() => notFound.kill(999));
    expect(missingProcessError).toBeInstanceOf(NodeSystemError);
    expect(missingProcessError).toMatchObject({ code: "ESRCH", syscall: "kill" });
    const unknownSignalError = thrownBy(() => process.kill(61, "SIG_NOT_REAL"));
    expect(unknownSignalError).toBeInstanceOf(NodeSystemError);
    expect(unknownSignalError).toMatchObject({ code: "EINVAL", syscall: "kill" });
    expect(() => process.kill(1.5)).toThrow(TypeError);

    let missingKillError: unknown;
    try {
      createNodeProcess(host(62)).kill(62);
    } catch (error) {
      missingKillError = error;
    }
    expect(missingKillError).toMatchObject({ code: "ENOTSUP" });
  });

  it("reports process telemetry as unsupported instead of returning fake host measurements", () => {
    const process = createNodeProcess(host(71));
    expect(thrownBy(() => process.memoryUsage())).toMatchObject({ code: "ENOTSUP" });
    expect(thrownBy(() => process.memoryUsage.rss())).toMatchObject({ code: "ENOTSUP" });
    expect(thrownBy(() => process.cpuUsage())).toMatchObject({ code: "ENOTSUP" });
    expect(thrownBy(() => process.resourceUsage())).toMatchObject({ code: "ENOTSUP" });
  });
});
