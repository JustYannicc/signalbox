// @effect-diagnostics nodeBuiltinImport:off - Web streams enter the guest's Node-compatible personality.
import * as NodeStream from "node:stream";
import type * as NodeStreamWeb from "node:stream/web";
import type { SystemIdentity } from "@t3tools/contracts/systemIdentity";
import { createNodeBridge, NodeBridgeError } from "../../isolate/NodeBridge.ts";
import { createNodeProcessWithIdentity } from "../../isolate/NodeProcessPersonality.ts";
import { createNodeOsWithIdentity } from "../../isolate/NodeOsPersonality.ts";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { createNodeDns } from "../../isolate/NodeDns.ts";
import { createNodeConsole } from "../../isolate/NodeConsole.ts";
import { createNodePath } from "../../isolate/NodePath.ts";
import { createNodeConstants } from "../../isolate/NodeConstants.ts";
import { createNodeReadline } from "../../isolate/NodeReadline.ts";
import { createNodeTty } from "../../isolate/NodeTty.ts";
import { createNodeBunHost } from "../../isolate/NodeBun.ts";
import { createBunShim } from "../../isolate/BunShim.ts";
import { createNodeRuntimeCompatibility } from "../../isolate/NodeRuntimeCompatibility.ts";
import { configureNodeHttpAgents, drainNodeHttpAgents } from "../../isolate/NodeHttpAgent.ts";
import { DEFAULT_NODE_NATIVE_MODULES } from "../NodeNativeModules.ts";
import { createHarnessEnvironment } from "../node/environment.ts";
import type { NodeHarnessRuntimeFactory } from "../node/runtimeTypes.ts";
import type { ClaudeCliInitialization } from "../ClaudeCliKernelPort.ts";
import type { createRemoteChildren } from "./Children.ts";

export function remoteCliRuntime(
  configuration: ClaudeCliInitialization,
  children: Awaited<ReturnType<typeof createRemoteChildren>>,
  identity: SystemIdentity,
  signalProcess: (selector: number, signal: number) => void,
): NodeHarnessRuntimeFactory {
  return (input, signals, onChild, bridge) => {
    const supplied = createNodeBridge(input.nativeModules);
    const native = createNodeBridge({
      ...DEFAULT_NODE_NATIVE_MODULES,
      ...Object.fromEntries(supplied.names.map((name) => [name, supplied.require(name)])),
    });
    const streams = {
      stdin: NodeStream.Readable.fromWeb(
        configuration.io.stdin as NodeStreamWeb.ReadableStream<Uint8Array>,
      ),
      stdout: NodeStream.Writable.fromWeb(
        configuration.io.stdout as NodeStreamWeb.WritableStream<Uint8Array>,
      ),
      stderr: NodeStream.Writable.fromWeb(
        configuration.io.stderr as NodeStreamWeb.WritableStream<Uint8Array>,
      ),
    };
    try {
      const env = { ...input.env };
      const filesystem = input.computer.files;
      const environment = createHarnessEnvironment(input, bridge);
      const context = {
        filesystem,
        env,
        streams,
        identity: input.identity,
        systemIdentity: identity,
        processes: {
          signalPid(_parent: unknown, selector: number, number: number) {
            if (
              !Number.isSafeInteger(selector) ||
              Math.abs(selector) > 0x7fff_ffff ||
              !Number.isSafeInteger(number) ||
              number < 0 ||
              number > 64
            )
              return {
                status: "error" as const,
                error: {
                  code: "INVALID_ARGUMENT" as const,
                  message: "Invalid process selector or signal",
                },
              };
            signalProcess(selector, number);
            return { status: "ok" as const, value: undefined };
          },
        },
        resolveBuiltinModule: (specifier: string) => {
          try {
            return bridge().require(specifier);
          } catch (cause) {
            if (
              cause instanceof NodeBridgeError &&
              ["NODE_BUILTIN_UNKNOWN", "NODE_BUILTIN_UNAVAILABLE"].includes(cause.code)
            )
              return undefined;
            throw cause;
          }
        },
      };
      const process = createNodeProcessWithIdentity(context, identity);
      const fs = createNodeFs(filesystem);
      const console = createNodeConsole(streams.stdout, streams.stderr);
      const dns = createNodeDns({
        fetch: globalThis.fetch.bind(globalThis),
        signal: signals.lifetime,
        readHosts: () => fs.fs.readFileSync("/etc/hosts", "utf8").toString(),
      });
      const childProcess = children(signals.lifetime, onChild);
      const missingBunMembers = new Set<string>();
      const bun = createBunShim(
        createNodeBunHost({
          filesystem: fs,
          process,
          childProcess,
          programHost: {
            resolve(executable) {
              try {
                const stat = filesystem.stat(executable);
                if (
                  stat.type === "file" &&
                  (stat.posix === undefined || (stat.posix.mode & 0o111) !== 0)
                )
                  return { status: "ok", value: undefined };
              } catch (cause) {
                if (
                  !(
                    typeof cause === "object" &&
                    cause !== null &&
                    "code" in cause &&
                    cause.code === "ENOENT"
                  )
                )
                  throw cause;
              }
              return {
                status: "error",
                error: {
                  code: "NOT_FOUND",
                  message: "Executable is absent from the owner's metadata index",
                },
              };
            },
          },
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
        tty: createNodeTty(),
        child_process: childProcess,
        os: createNodeOsWithIdentity(context, identity),
        path,
        "path/posix": path.posix,
        "path/win32": path.win32,
        module: environment.module,
      });
      if (native.names.includes("constants"))
        modules.constants = createNodeConstants(native.require("constants"), fs.fs);
      configureNodeHttpAgents([modules.http!, modules.https!], () =>
        environment.resolvePackage("undici"),
      );
      const compatibility = createNodeRuntimeCompatibility(modules.worker_threads!);
      modules.worker_threads = compatibility.module;
      return {
        process,
        streams,
        modules,
        bun,
        console,
        environment,
        missingBunMembers,
        drainDns: dns.drain,
        drainHttp: () => drainNodeHttpAgents([modules.http!, modules.https!]),
        compatibility,
      };
    } catch (cause) {
      for (const stream of Object.values(streams)) {
        stream.on("error", () => {});
        stream.destroy();
      }
      throw cause;
    }
  };
}
