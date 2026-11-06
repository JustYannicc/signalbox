// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off - Controlled CLI modules and isolate observations.
import * as NodeBuffer from "node:buffer";
import * as NodeConstants from "node:constants";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeEvents from "node:events";
import * as Yaml from "yaml";
import type { createNodeProcess } from "../../../isolate/NodeProcess.ts";
import { createClaudeCliFacetClass } from "../../ClaudeCliSession.ts";
import { createNodeFsSyscallClient } from "../../../isolate/NodeFsSyscallClient.ts";
import { KernelOpenFlags } from "../../../kernel/KernelOpenFlags.ts";
import { nativeFixture } from "./native.ts";
import type { OrdinaryOwnerEnvironment } from "./ordinaryOwnerObservation.fixture.ts";
let nonce: string | undefined;
const realm = () => (nonce ??= crypto.randomUUID());
export const ClaudeCliFacet = createClaudeCliFacetClass<OrdinaryOwnerEnvironment>(
  async (_ctx, env, configuration) => {
    const nativeId = configuration.nativeSessionId ?? "12345678-1234-4234-8234-123456789abc";
    let sessionId = nativeId;
    const native = nativeFixture(
      nativeId,
      configuration.systemIdentity,
      undefined,
      () => sessionId,
      "claude-opus-5-5",
    );
    const calibration = createNodeFsSyscallClient({
      syscalls: configuration.kernel,
      rootDescriptor: configuration.rootDescriptor,
      posix: configuration.posix !== undefined,
      signal: new AbortController().signal,
    });
    const descriptor = await calibration.open(
      "/",
      KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
    );
    const beforeCall = performance.now();
    const position = await configuration.kernel.call({
      name: "fd_tell",
      args: [descriptor, 0],
      memorySize: 8,
      regions: [{ pointer: 0, direction: "out", length: 8, bytes: new Uint8Array(0) }],
    });
    if (position.kind !== "return" || position.value !== 0)
      throw new Error("CLI-to-kernel RPC calibration could not read the opened descriptor offset");
    await env.OBSERVE.record({
      kind: "kernel-rpc-latency",
      realm: realm(),
      detail: JSON.stringify({
        operation: "fd_tell",
        calls: 1,
        elapsedMs: performance.now() - beforeCall,
        outputBytes: position.regions.reduce((count, region) => count + region.bytes.byteLength, 0),
      }),
    });
    await calibration.close(descriptor);
    const reports = new Set<Promise<void>>();
    const record = (kind: string, cause: unknown) => {
      const pending = env.OBSERVE.record({
        kind,
        realm: realm(),
        detail: NodeUtil.inspect(cause, { depth: 15 }),
      });
      reports.add(pending);
      void pending.then(
        () => reports.delete(pending),
        () => reports.delete(pending),
      );
    };
    return {
      onChildProcess(child, spawn) {
        child.once("close", (code, signal) =>
          record(`cli-child-close:${spawn.spawnfile}`, { code, signal }),
        );
        child.on(NodeEvents.errorMonitor, (cause) =>
          record(`cli-child-error:${spawn.spawnfile}`, cause),
        );
      },
      async drainChildProcessObservation() {
        while (reports.size > 0) await Promise.all(reports);
      },
      reportCliStartupFailure: (cause) => record("cli-owner-failure", cause),
      nativeModules: {
        buffer: NodeBuffer,
        constants: NodeConstants,
        fs: NodeFS,
        child_process: NodeChildProcess,
      },
      loadPackages: async () => ({ yaml: Yaml }),
      loadRelease: async (bridge, signal) => {
        const process = bridge.require("node:process") as ReturnType<typeof createNodeProcess>;
        const index = process.argv.indexOf("--session-id");
        const requestedId = process.argv[index + 1];
        if (index < 0 || requestedId === undefined)
          throw new Error("SDK did not pass its native session ID");
        sessionId = requestedId;
        const release = await native.loadRelease(bridge, signal);
        return {
          launch: async () => {
            await env.OBSERVE.record({ kind: "cli-launch", realm: realm() });
            try {
              return await release.launch();
            } catch (error) {
              await env.OBSERVE.record({
                kind: "cli-failure",
                realm: realm(),
                detail: NodeUtil.inspect(error, { depth: 15 }),
              });
              throw error;
            }
          },
        };
      },
    };
  },
);
