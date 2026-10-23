// @effect-diagnostics nodeBuiltinImport:off - native streams exercise the personality pipe profile.
import * as NodeStream from "node:stream";
import { describe, expect, it } from "@effect/vitest";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";

import { createNodeProcess, type NodeProcessHostContext } from "../../isolate/NodeProcess.ts";
import { markNodeBuiltinCapability } from "../NodeBuiltinCapabilities.ts";
import {
  inspectNodeBuiltinFunctionCapabilities,
  type NodeBuiltinTargetProfile,
} from "../NodeBuiltinInventory.ts";

function processFixture(pid: number, isTTY: boolean, withRawMode = false) {
  const stdin = new NodeStream.PassThrough();
  Object.defineProperty(stdin, "isTTY", { value: isTTY, configurable: true });
  if (withRawMode) {
    Object.defineProperty(stdin, "setRawMode", {
      value: () => stdin,
      configurable: true,
    });
  }
  const context: NodeProcessHostContext = {
    filesystem: { cwd: "/", chdir: () => undefined },
    env: {},
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
      argv: ["node"],
    },
    streams: {
      stdin,
      stdout: new NodeStream.PassThrough(),
      stderr: new NodeStream.PassThrough(),
    },
  };
  const process = createNodeProcess(context);
  const profile: NodeBuiltinTargetProfile = {
    systemIdentity: systemIdentityForThread(`node-inventory-${pid}`),
    processIdentity: context.identity,
    filesystem: { posixPolicy: false, setUmask: false },
    cpu: { execution: false, processAccounting: false },
  };
  return {
    process,
    profile,
    dispose() {
      process.stdin.destroy();
      process.stdout.destroy();
      process.stderr.destroy();
    },
  };
}

describe("Node builtin runtime inventory", () => {
  it("keeps present non-callable values distinct from absent functions", () => {
    const capabilities = inspectNodeBuiltinFunctionCapabilities(
      { process: { report: { getReport: {}, unset: undefined, nullValue: null } } },
      ["getReport", "unset", "nullValue", "missing"].map((member) => ({
        specifier: "process",
        memberPath: ["report", member],
      })),
    );
    expect(capabilities.map(({ status }) => status)).toEqual([
      "unsupported",
      "missing",
      "unsupported",
      "missing",
    ]);
    expect(capabilities[0]?.evidence).toContain("exists but is not callable");
    expect(capabilities[1]?.evidence).toBe("process.report.unset is undefined");
  });

  it("distinguishes declared, unavailable, unannotated and missing calls without invocation", () => {
    let calls = 0;
    const release = markNodeBuiltinCapability(
      () => {
        calls += 1;
        return "6.12.0";
      },
      { status: "supported", evidence: "NodeOs.release reads SystemIdentity.release" },
    );
    const uptime = markNodeBuiltinCapability(
      () => {
        calls += 1;
      },
      { status: "unsupported", evidence: "NodeOs.uptime is an unsupported adapter stub" },
    );
    const hostname = () => {
      calls += 1;
    };
    const modules = { os: { release, uptime, hostname } };

    const result = inspectNodeBuiltinFunctionCapabilities(modules, [
      { specifier: "node:os", memberPath: ["release"] },
      { specifier: "os", memberPath: ["uptime"] },
      { specifier: "os", memberPath: ["hostname"] },
      { specifier: "os", memberPath: ["machine"] },
      { specifier: "node:unknown_builtin", memberPath: ["run"] },
    ]);

    expect(result.map(({ status }) => status)).toEqual([
      "supported",
      "unsupported",
      "unknown",
      "missing",
      "unknown",
    ]);
    expect(result[2]?.evidence).toContain("no explicit capability declaration");
    expect(result[3]?.evidence).toContain("absent from the constructed public Node personality");
    expect(calls).toBe(0);
  });

  it("resolves nested submodule paths and does not invoke accessors", () => {
    const readFile = markNodeBuiltinCapability(() => undefined, {
      status: "supported",
      evidence: "NodeFs.promises.readFile uses KernelFileSystem",
    });
    let getterCalls = 0;
    const os = Object.defineProperty({}, "release", {
      get() {
        getterCalls += 1;
        return () => "6.12.0";
      },
    });

    const result = inspectNodeBuiltinFunctionCapabilities({ fs: { promises: { readFile } }, os }, [
      { specifier: "node:fs", memberPath: ["promises", "readFile"] },
      { specifier: "node:os", memberPath: ["release"] },
    ]);

    expect(result.map(({ status }) => status)).toEqual(["supported", "unknown"]);
    expect(result[1]?.evidence).toContain("accessor that was not invoked");
    expect(getterCalls).toBe(0);
  });

  it("classifies the 12 stdio callables and the selected non-TTY raw-mode absence", () => {
    const fixture = processFixture(301, false);
    try {
      const stdioPaths = [
        ["stderr", "on"],
        ["stderr", "write"],
        ["stdin", "off"],
        ["stdin", "on"],
        ["stdin", "read"],
        ["stdin", "removeListener"],
        ["stdin", "setEncoding"],
        ["stdout", "end"],
        ["stdout", "on"],
        ["stdout", "once"],
        ["stdout", "removeListener"],
        ["stdout", "write"],
      ] as const;
      const requests = [
        ...stdioPaths.map((memberPath) => ({ specifier: "process", memberPath })),
        { specifier: "process", memberPath: ["stdin", "ref"] },
        { specifier: "process", memberPath: ["stdin", "unref"] },
        { specifier: "process", memberPath: ["getBuiltinModule"] },
        { specifier: "process", memberPath: ["reallyExit"] },
        { specifier: "process", memberPath: ["execve"] },
        { specifier: "process", memberPath: ["stdin", "setRawMode"] },
      ];
      const result = inspectNodeBuiltinFunctionCapabilities(
        { process: fixture.process },
        requests,
        fixture.profile,
      );

      expect(result.slice(0, 16).map(({ status }) => status)).toEqual(
        Array.from({ length: 16 }, () => "supported"),
      );
      expect(result[16]?.status).toBe("platform-pruned");
      expect(result[17]).toMatchObject({ status: "platform-pruned" });
      expect(result[17]?.evidence).toContain("stdin.isTTY=false");
    } finally {
      fixture.dispose();
    }
  });

  it("does not prune a callable setRawMode for a TTY profile", () => {
    const fixture = processFixture(302, true, true);
    try {
      const [result] = inspectNodeBuiltinFunctionCapabilities(
        { process: fixture.process },
        [{ specifier: "process", memberPath: ["stdin", "setRawMode"] }],
        fixture.profile,
      );

      expect(result?.status).toBe("unknown");
      expect(result?.evidence).toContain("no explicit capability declaration");
    } finally {
      fixture.dispose();
    }
  });
});
