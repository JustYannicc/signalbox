import { AgentOsDescriptorHost } from "../kernel/AgentOsDescriptorHost.ts";
import { AgentOsFileSystemHost } from "../kernel/AgentOsFileSystemHost.ts";
import { AgentOsProcessHost } from "../kernel/AgentOsProcessHost.ts";
import type { KernelHandle, KernelResult } from "../kernel/KernelAbi.ts";
import { KernelHttpNetworkHost } from "../kernel/KernelHttpNetworkHost.ts";
import { KernelWebSocketHost } from "../kernel/KernelWebSocketHost.ts";
import { createKernelWebSocketFetchRoute } from "../kernel/KernelWebSocketFetchRoute.ts";
import type { KernelAsyncWasi } from "../kernel/KernelWasi.ts";
import { acceptCodexExecWebSocket } from "../kernel/CodexExecWebSocket.ts";
import type { CodexExecSessions } from "../kernel/CodexExecSessions.ts";
import type { CodexHarnessProcessOptions } from "./codex/types.ts";

export async function createCodexImports(input: {
  readonly options: CodexHarnessProcessOptions;
  readonly binding: KernelAsyncWasi;
  readonly parent: KernelHandle<"process">;
  readonly sessions: CodexExecSessions;
  readonly memory: () => WebAssembly.Memory;
  readonly signal: AbortSignal;
}) {
  const { options, binding, parent, sessions, memory, signal } = input;
  const { files } = options.computer;
  const pending = new Set<Promise<KernelResult<KernelHandle<"process">>>>();
  const children = new Set<KernelHandle<"process">>();
  const fs = new AgentOsFileSystemHost({ memory, fileSystem: files, agentOsPreopens: true });
  const descriptors = new AgentOsDescriptorHost({
    memory,
    descriptors: files.descriptors,
    wakes: options.host.wakes,
    asyncMode: true,
  });
  const processes = new AgentOsProcessHost({
    memory,
    processes: options.host.processes,
    wakes: options.host.wakes,
    parent,
    signal,
    spawn: (request) => {
      const spawning = options.host.spawn({ filesystem: files, parent, signal }, request);
      pending.add(spawning);
      void spawning.then(
        (result) => {
          pending.delete(spawning);
          if (result.status === "ok") children.add(result.value);
        },
        () => pending.delete(spawning),
      );
      return spawning;
    },
  });
  const ws = new KernelWebSocketHost({
    memory,
    descriptors: binding.descriptors,
    route(input) {
      const { request } = input;
      if (request.url !== options.environment.CODEX_EXEC_SERVER_URL)
        return createKernelWebSocketFetchRoute(options.fetch)(input);
      const response = acceptCodexExecWebSocket(request, sessions, options.lifetime);
      response.webSocket?.accept();
      return { response, headers: [] };
    },
  });
  const http = new KernelHttpNetworkHost({
    memory,
    descriptors: binding.descriptors,
    fetch: options.fetch,
    signal,
  });
  let disposal: Promise<void> | undefined;
  const dispose = () =>
    (disposal ??= (async () => {
      const errors: unknown[] = [];
      const network = http.dispose().catch((error: unknown) => {
        errors.push(error);
      });
      while (pending.size > 0) await Promise.allSettled(pending);
      for (const child of children) {
        const existing = options.host.processes.info(child);
        if (existing.status === "error" && existing.error.code === "INVALID_HANDLE") continue;
        try {
          const result = await options.host.processes.terminateAndReap(child);
          if (
            result.status !== "ok" &&
            !(signal.aborted && result.status === "error" && result.error.code === "CANCELLED")
          )
            throw new Error("Codex child cleanup failed", { cause: result });
        } catch (error) {
          errors.push(error);
        }
      }
      await network;
      if (errors.length > 0) throw new AggregateError(errors, "Codex import cleanup failed");
    })());
  try {
    const imports = {
      ...binding.wasi.getImportObject(),
      ...fs.getImportObject(),
      ...ws.getImportObject(),
      host_process: {
        ...descriptors.getImportObject().host_process,
        ...processes.getImportObject().host_process,
      },
      host_user: { isatty: () => 0 },
      ...http.getImportObject(),
    };
    const exact: WebAssembly.Imports = {};
    for (const entry of WebAssembly.Module.imports(options.engine)) {
      const namespace: unknown = Reflect.get(imports, entry.module);
      const value: unknown =
        namespace !== null && (typeof namespace === "object" || typeof namespace === "function")
          ? Reflect.get(namespace, entry.name)
          : undefined;
      if (!isImportValue(value))
        throw new Error(`Unsupported Codex import ${entry.module}.${entry.name}`);
      (exact[entry.module] ??= {})[entry.name] = value;
    }

    return { imports: exact, dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Codex import setup failed", { cause: cleanup });
    }
    throw error;
  }
}

function isImportValue(value: unknown): value is WebAssembly.ImportValue {
  if (typeof value === "function" || typeof value === "number" || typeof value === "bigint")
    return true;
  if (
    value instanceof WebAssembly.Memory ||
    value instanceof WebAssembly.Table ||
    value instanceof WebAssembly.Global
  )
    return true;
  const suspending: unknown = Reflect.get(WebAssembly, "Suspending");
  return typeof suspending === "function" && value instanceof suspending;
}
