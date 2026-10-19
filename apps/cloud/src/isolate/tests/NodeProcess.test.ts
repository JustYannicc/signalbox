// @effect-diagnostics nodeBuiltinImport:off - PassThrough supplies streams for the explicit host context in these tests.
import * as NodeStream from "node:stream";
import { describe, expect, it } from "@effect/vitest";

import { kernelError, kernelOk } from "../../kernel/KernelAbi.ts";
import { KernelCpuAccounting } from "../../kernel/KernelCpuAccounting.ts";
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

function monotonicClock(startNs: bigint) {
  let nowNs = startNs;
  return {
    now: () => nowNs,
    advanceBy: (durationNs: bigint) => {
      nowNs += durationNs;
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
    expect(Object.hasOwn(first, "execArgv")).toBe(true);
    expect(first.execArgv).toEqual([]);
    expect(second.execArgv).toEqual([]);
    first.execArgv.push("--first-only");
    expect(second.execArgv).toEqual([]);
  });

  it("copies explicit guest execArgv without inheriting host runtime flags", () => {
    const callerArgs = ["--enable-source-maps", "--trace-warnings"];
    const base = host(43);
    const context: NodeProcessHostContext = {
      ...base,
      identity: { ...base.identity, execArgv: callerArgs },
    };
    const process = createNodeProcess(context);

    callerArgs.push("--host-only-flag");
    process.execArgv.push("--guest-mutable-flag");

    expect(process.execArgv).toEqual([
      "--enable-source-maps",
      "--trace-warnings",
      "--guest-mutable-flag",
    ]);
    expect(callerArgs).toEqual(["--enable-source-maps", "--trace-warnings", "--host-only-flag"]);
    expect(() =>
      createNodeProcess({
        ...base,
        identity: { ...base.identity, execArgv: ["--valid", 7] as unknown as readonly string[] },
      }),
    ).toThrow("execArgv must be a string array");
  });

  it("exports own bound methods that remain callable after destructuring", async () => {
    const clock = monotonicClock(9_000_000_000_000_000_000n);
    let killCall: { parentProcessHandle: unknown; selector: number; signal: number } | undefined;
    const context: NodeProcessHostContext = {
      ...host(45),
      monotonicNowNs: clock.now,
      processes: {
        signalPid: (parentProcessHandle, selector, signal) => {
          killCall = { parentProcessHandle, selector, signal };
          return kernelOk(undefined);
        },
      },
    };
    const process = createNodeProcess(context);
    const { cwd, chdir, nextTick, kill, uptime } = process;

    expect(Object.hasOwn(process, "cwd")).toBe(true);
    expect(Object.hasOwn(process, "chdir")).toBe(true);
    expect(Object.hasOwn(process, "nextTick")).toBe(true);
    expect(Object.hasOwn(process, "kill")).toBe(true);
    expect(Object.hasOwn(process, "on")).toBe(true);
    expect(Object.hasOwn(process, "exit")).toBe(true);
    expect(Object.hasOwn(process, "exitCode")).toBe(true);
    expect(Object.hasOwn(process, "hrtime")).toBe(true);
    expect(Object.hasOwn(process, "uptime")).toBe(true);
    expect(Object.keys(process)).toContain("cwd");
    expect(Object.keys(process)).toContain("exitCode");
    expect(Object.keys(process)).toContain("uptime");
    expect(cwd()).toBe("/work/one");
    chdir("/work/destructured");
    expect(cwd()).toBe("/work/destructured");
    expect(kill(45)).toBe(true);
    expect(killCall).toEqual({ parentProcessHandle: undefined, selector: 45, signal: 15 });
    clock.advanceBy(1_234_567_890n);
    expect(uptime()).toBe(1.23456789);
    await new Promise<void>((resolve) => nextTick(() => resolve()));
  });

  it("measures each logical process lifetime from its own captured monotonic start", () => {
    const clock = monotonicClock(9_000_000_000_000_000_000n);
    const first = createNodeProcess({ ...host(47), monotonicNowNs: clock.now });
    clock.advanceBy(4_000_000_000n);
    const second = createNodeProcess({ ...host(48), monotonicNowNs: clock.now });

    clock.advanceBy(1_234_567_890n);

    expect(first.uptime()).toBe(5.23456789);
    expect(second.uptime()).toBe(1.23456789);
    first.hrtime.bigint = () => 0n;
    expect(first.uptime()).toBe(5.23456789);
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

  it("reports logical kernel CPU time in microseconds and supports previous differences", () => {
    let nowNs = 0n;
    const core = new KernelCpuAccounting(() => nowNs);
    const accounting = core.forProcess(71);
    const process = createNodeProcess({ ...host(71), cpuAccounting: accounting });
    const initial = process.cpuUsage();
    expect(initial).toEqual({ user: 0, system: 0 });

    const leaveUser = accounting.enterUser();
    nowNs = 15_500n;
    const beforeSyscall = process.cpuUsage();
    expect(beforeSyscall).toEqual({ user: 15, system: 0 });
    const leaveSystem = accounting.enterSystem();
    nowNs += 2_500n;
    expect(process.cpuUsage(beforeSyscall)).toEqual({ user: 0, system: 2 });
    leaveSystem();
    nowNs += 3_000n;
    leaveUser();
    const beforeWait = process.cpuUsage();
    nowNs += 1_000_000n;
    expect(process.cpuUsage()).toEqual(beforeWait);
    expect(process.cpuUsage(initial)).toEqual({ user: 18, system: 2 });
    expect(initial).toEqual({ user: 0, system: 0 });

    nowNs = 0n;
    const leaveRegressed = accounting.enterUser();
    expect(process.cpuUsage()).toEqual(beforeWait);
    leaveRegressed();
    accounting.dispose();
  });

  it("keeps logical CPU counters separate and validates previous values", () => {
    let nowNs = 0n;
    const core = new KernelCpuAccounting(() => nowNs);
    const firstCpu = core.forProcess(72);
    const secondCpu = core.forProcess(73);
    const first = createNodeProcess({ ...host(72), cpuAccounting: firstCpu });
    const second = createNodeProcess({ ...host(73), cpuAccounting: secondCpu });
    firstCpu.runUser(() => {
      nowNs += 4_000n;
      secondCpu.runSystem(() => {
        nowNs += 7_000n;
      });
      nowNs += 2_000n;
    });
    expect(first.cpuUsage()).toEqual({ user: 6, system: 0 });
    expect(second.cpuUsage()).toEqual({ user: 0, system: 7 });

    for (const previous of [undefined, null, 0, false, "", Number.NaN]) {
      expect(Reflect.apply(first.cpuUsage, first, [previous])).toEqual({ user: 6, system: 0 });
    }
    const callablePrevious = Object.assign(() => {}, { user: 1, system: 0 });
    expect(first.cpuUsage(callablePrevious)).toEqual({ user: 5, system: 0 });
    expect(first.cpuUsage({ user: 7.5, system: 0.25 })).toEqual({ user: -1.5, system: -0.25 });

    for (const previous of [1, {}, { user: "0", system: 0 }, { user: 0, system: null }]) {
      expect(thrownBy(() => Reflect.apply(first.cpuUsage, first, [previous]))).toMatchObject({
        code: "ERR_INVALID_ARG_TYPE",
      });
    }
    for (const previous of [
      { user: -1, system: 0 },
      { user: 0, system: Number.NaN },
      { user: Number.POSITIVE_INFINITY, system: 0 },
      { user: Number.MAX_SAFE_INTEGER + 1, system: 0 },
      { user: 0, system: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(thrownBy(() => Reflect.apply(first.cpuUsage, first, [previous]))).toMatchObject({
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
    let reads = 0;
    const previous = {
      get user() {
        reads++;
        return 1;
      },
      get system() {
        reads++;
        return 0;
      },
    };
    expect(first.cpuUsage(previous)).toEqual({ user: 5, system: 0 });
    expect(reads).toBe(2);
    firstCpu.dispose();
    secondCpu.dispose();
  });

  it("requires kernel CPU accounting while other host telemetry remains unsupported", () => {
    const process = createNodeProcess(host(71));
    expect(thrownBy(() => process.memoryUsage())).toMatchObject({ code: "ENOTSUP" });
    expect(thrownBy(() => process.memoryUsage.rss())).toMatchObject({ code: "ENOTSUP" });
    expect(thrownBy(() => process.cpuUsage())).toMatchObject({ code: "ENOTSUP" });
    expect(thrownBy(() => process.resourceUsage())).toMatchObject({ code: "ENOTSUP" });
  });
});
