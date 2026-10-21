// @effect-diagnostics-next-line nodeBuiltinImport:off - Node compatibility requires the native stream and process interfaces.
import * as NodeStream from "node:stream";
import { createNodeConsole } from "../../isolate/NodeConsole.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Node compatibility requires the native stream and process interfaces.
import type * as NodeStreamWeb from "node:stream/web";
import { createKernelProcessStreams } from "../../kernel/KernelProcessStreams.ts";
import { createNodeDns } from "../../isolate/NodeDns.ts";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { createNodeProcess } from "../../isolate/NodeProcess.ts";
import { createNodeReadline } from "../../isolate/NodeReadline.ts";
import { createNodeComputerChildProcess } from "../../isolate/NodeComputerProcess.ts";
import type { NodeChildProcess } from "../../isolate/NodeChildProcess.ts";
import { createNodeBridge } from "../../isolate/NodeBridge.ts";
import type { NodeBridge } from "../../isolate/NodeBridge.ts";
import { createNodeBunHost } from "../../isolate/NodeBun.ts";
import { createBunShim } from "../../isolate/BunShim.ts";
import { createNodeConstants } from "../../isolate/NodeConstants.ts";
import { createNodeOs } from "../../isolate/NodeOs.ts";
import { createNodePath } from "../../isolate/NodePath.ts";
import * as NodeTty from "../../isolate/NodeTty.ts";
import { DEFAULT_NODE_NATIVE_MODULES } from "./nativeModules.ts";
import { createHarnessEnvironment } from "./environment.ts";
import type { NodeHarnessProcessInput } from "./types.ts";

export function createHarnessRuntime(
  input: NodeHarnessProcessInput,
  signals: {
    readonly lifetime: AbortSignal;
    readonly stdin: AbortSignal;
    readonly output: AbortSignal;
  },
  onChild: (child: NodeChildProcess) => void,
  bridge: () => NodeBridge,
) {
  input.stdio.assertBound(input.computer.files);
  const supplied = createNodeBridge(input.nativeModules);
  const native = createNodeBridge({
    ...DEFAULT_NODE_NATIVE_MODULES,
    ...Object.fromEntries(supplied.names.map((name) => [name, supplied.require(name)])),
  });
  const current = input.host.processes.info(input.processHandle);
  if (current.status !== "ok") throw new Error("Harness process has no live kernel identity");
  const filesystem = input.computer.files;
  const identity = { ...input.identity, pid: current.value.pid, ppid: current.value.parentPid };
  const environment = createHarnessEnvironment(input, bridge);
  const stdin = createKernelProcessStreams(filesystem, { signal: signals.stdin }).stdin;
  const output = createKernelProcessStreams(filesystem, { signal: signals.output });
  const streams = {
    stdin: NodeStream.Readable.fromWeb(stdin as NodeStreamWeb.ReadableStream<Uint8Array>),
    stdout: NodeStream.Writable.fromWeb(output.stdout as NodeStreamWeb.WritableStream<Uint8Array>),
    stderr: NodeStream.Writable.fromWeb(output.stderr as NodeStreamWeb.WritableStream<Uint8Array>),
  };
  try {
    const console = createNodeConsole(streams.stdout, streams.stderr);
    const env = { ...input.env };
    const cpu = input.host.cpuExecution?.forProcess(current.value.pid);
    const context = {
      filesystem,
      env,
      streams,
      identity,
      processes: input.host.processes,
      ...(input.processHandle === undefined ? {} : { parentProcessHandle: input.processHandle }),
      ...(cpu === undefined ? {} : { cpuAccounting: cpu }),
    };
    const process = createNodeProcess(context);
    const fs = createNodeFs(filesystem);
    // Capture host fetch before the personality replaces it with the model transport.
    const dns = createNodeDns({
      fetch: globalThis.fetch.bind(globalThis),
      signal: signals.lifetime,
      readHosts: () => fs.fs.readFileSync("/etc/hosts", "utf8").toString(),
    });
    const childProcess = createNodeComputerChildProcess(
      input.host,
      {
        filesystem,
        env,
        signal: signals.lifetime,
        ...(input.processHandle === undefined ? {} : { parent: input.processHandle }),
      },
      input.computer,
      onChild,
    );
    const missingBunMembers = new Set<string>();
    const bun = createBunShim(
      createNodeBunHost({
        filesystem: fs,
        process,
        childProcess,
        programHost: input.host,
        ...input.bun,
        onMissing: (member) => {
          missingBunMembers.add(member);
        },
      }),
    ).bun;
    const path = createNodePath(filesystem);
    const modules: Record<string, object> = Object.fromEntries(
      native.names.map((name) => [name, native.require(name)]),
    );
    Object.assign(modules, {
      ...fs,
      dns: dns.dns,
      "dns/promises": dns["dns/promises"],
      console,
      process,
      readline: createNodeReadline(),
      tty: NodeTty,
      child_process: childProcess,
      os: createNodeOs(context),
      path,
      "path/posix": path.posix,
      "path/win32": path.win32,
      module: environment.module,
    });
    if (native.names.includes("constants"))
      modules.constants = createNodeConstants(native.require("constants"), fs.fs);
    return {
      process,
      streams,
      modules,
      bun,
      console,
      environment,
      cpu,
      missingBunMembers,
      drainDns: dns.drain,
    };
  } catch (error) {
    for (const stream of Object.values(streams)) {
      stream.on("error", () => {});
      stream.destroy();
    }
    throw error;
  }
}
