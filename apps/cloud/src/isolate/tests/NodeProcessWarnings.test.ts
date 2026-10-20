// @effect-diagnostics nodeBuiltinImport:off - Node streams supply the explicit guest host context and capture warning output.
import * as NodeStream from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import { createNodeProcess, type NodeProcessHostContext } from "../NodeProcess.ts";

function guest(pid = 41, execArgv: string[] = []) {
  let stderr = "";
  const context: NodeProcessHostContext = {
    filesystem: { cwd: "/work", chdir() {} },
    env: {},
    identity: {
      version: "v24.18.0",
      versions: { node: "24.18.0" },
      platform: "linux",
      arch: "x64",
      homedir: "/home/guest",
      tmpdir: "/tmp",
      pid,
      ppid: 1,
      execPath: "/usr/bin/node",
      argv0: "node",
      argv: ["node", "/sdk.mjs"],
      execArgv,
    },
    streams: {
      stdin: new NodeStream.PassThrough(),
      stdout: new NodeStream.PassThrough(),
      stderr: new NodeStream.Writable({
        write(chunk, _encoding, done) {
          stderr += String(chunk);
          done();
        },
      }),
    },
  };
  const process = createNodeProcess(context);
  return {
    process,
    context,
    stderr: () => stderr,
    drain: () => new Promise<void>((resolve) => process.nextTick(resolve)),
  };
}

describe("process warnings", () => {
  it("defers warning callbacks and writes type, code and detail to owned stderr", async () => {
    const host = guest();
    const seen: Error[] = [];
    host.process.on("warning", (warning) => seen.push(warning));
    const { emitWarning } = host.process;
    emitWarning("guest diagnostic", { type: "SdkWarning", code: "SDK001", detail: "More detail" });
    expect(seen).toEqual([]);
    expect(host.stderr()).toBe("");
    await host.drain();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      name: "SdkWarning",
      message: "guest diagnostic",
      code: "SDK001",
      detail: "More detail",
    });
    expect(host.stderr()).toBe(
      "(node:41) [SDK001] SdkWarning: guest diagnostic\nMore detail\n(Use `node --trace-warnings ...` to show where the warning was created)\n",
    );
  });

  it("supports positional type/code and preserves supplied Error identity", async () => {
    const host = guest();
    const seen: Error[] = [];
    host.process.on("warning", (warning) => seen.push(warning));
    const supplied = Object.assign(new Error("existing warning"), {
      name: "ExistingWarning",
      code: "EXISTING",
    });
    host.process.emitWarning("old API", "DeprecationWarning", "DEP001");
    host.process.emitWarning(supplied, { type: "IgnoredType", code: "IGNORED" });
    await host.drain();
    expect(seen[0]).toMatchObject({
      name: "DeprecationWarning",
      message: "old API",
      code: "DEP001",
    });
    expect(seen[1]).toBe(supplied);
    expect(host.stderr()).toContain("(node:41) [DEP001] DeprecationWarning: old API");
    expect(host.stderr()).toContain("(node:41) [EXISTING] ExistingWarning: existing warning");
    expect(host.stderr().match(/Use `/g)).toHaveLength(1);
  });

  it("keeps output and callbacks separate across logical processes", async () => {
    const first = guest(51);
    const second = guest(52);
    const seen: Error[] = [];
    first.process.on("warning", (warning) => seen.push(warning));
    second.process.emitWarning("second only");
    await second.drain();
    expect(seen).toEqual([]);
    expect(first.stderr()).toBe("");
    expect(second.stderr()).toContain("(node:52) Warning: second only");
    first.process.emitWarning("first only");
    await first.drain();
    expect(seen).toHaveLength(1);
    expect(first.stderr()).toContain("(node:51) Warning: first only");
    expect(second.stderr()).not.toContain("first only");
  });

  it("honors warning output flags without suppressing event callbacks", async () => {
    const quiet = guest(61, ["--no-warnings"]);
    const seen: Error[] = [];
    quiet.process.on("warning", (warning) => seen.push(warning));
    quiet.process.emitWarning("quiet event");
    await quiet.drain();
    expect(seen).toHaveLength(1);
    expect(quiet.stderr()).toBe("");
    const trace = guest(62, ["--trace-warnings"]);
    function boundary() {
      trace.process.emitWarning("traced", { type: "SdkWarning", ctor: boundary });
    }
    boundary();
    await trace.drain();
    expect(trace.stderr()).toContain("(node:62) SdkWarning: traced\n    at ");
    expect(trace.stderr()).toContain("NodeProcessWarnings.test.ts");
    expect(trace.stderr()).not.toContain("at boundary");
    expect(trace.stderr()).not.toContain("Use `");
  });

  it("validates arguments synchronously without emitting or writing", async () => {
    const host = guest();
    const seen: Error[] = [];
    host.process.on("warning", (warning) => seen.push(warning));
    expect(() => host.process.emitWarning(7 as never)).toThrow(TypeError);
    expect(() => host.process.emitWarning("bad type", 7 as never)).toThrow(TypeError);
    expect(() => host.process.emitWarning("bad code", "Warning", 7 as never)).toThrow(TypeError);
    await host.drain();
    expect(seen).toEqual([]);
    expect(host.stderr()).toBe("");
  });
});
