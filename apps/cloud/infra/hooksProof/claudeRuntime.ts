import { withOfficialHookContext } from "./officialHookContext.ts";
import { createClaudeProofCleanup } from "./claudeLifecycle.ts";
// @effect-diagnostics nodeBuiltinImport:off - this runtime is an isolated proof host.
import * as NodeProcess from "node:process";
import type { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import type { ChildWorkerLoaderPort } from "../../src/computer/WorkerLoaderDispatch.ts";
import { createComputerCommands } from "../../src/computer/ComputerCommands.ts";
import { ComputerEscalationTable } from "../../src/computer/EscalationTable.ts";
import {
  createNodeGeneratedCode,
  createNodeGeneratedCodeFetcher,
  type NodeGeneratedCodeOpenPort,
} from "../../src/isolate/NodeGeneratedCode.ts";
import { createBunShim, type BunFileTarget } from "../../src/isolate/BunShim.ts";
import { createNodeBunHost } from "../../src/isolate/NodeBun.ts";
import { createNodeChildProcess } from "../../src/isolate/NodeChildProcess.ts";
import {
  createNodeProcess,
  type NodeProcessEnvironment,
  type NodeProcessStreams,
  type NodeRuntimeIdentity,
} from "../../src/isolate/NodeProcess.ts";
import type { NodeFsModules } from "../../src/isolate/NodeFs.ts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { KernelProgramRegistry } from "../../src/kernel/KernelAbi.ts";
import { KernelCpuAccounting } from "../../src/kernel/KernelCpuAccounting.ts";
import type { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createHookService } from "../../src/hooks/HookService.ts";
import { registerKernelHookProgram, type KernelHookInvoker } from "../../src/hooks/HookProgram.ts";
import { createSeededChildProgramCatalog } from "../childPrograms/runtime.ts";
import type { ChildProgramSources } from "../childPrograms/prepare.ts";
import type { ClaudeHookScenario } from "./claudeScenario.ts";
import type { ClaudeHooksDispatchRecord } from "./claudeEvidence.ts";
import type { StandardProofAdapter } from "./standardProofAdapter.ts";

const monotonicNowNs = NodeProcess.hrtime.bigint.bind(NodeProcess.hrtime);

export interface ClaudeHookRuntimeOptions {
  readonly capacity: ChildWorkerCapacity;
  readonly filesystem: KernelFileSystem;
  readonly fs: NodeFsModules;
  readonly wakes: KernelWakeRegistry;
  readonly storage: FacetStorage;
  readonly programs: ChildProgramSources;
  readonly loader: ChildWorkerLoaderPort;
  readonly env: NodeProcessEnvironment;
  readonly identity: NodeRuntimeIdentity;
  readonly streams: NodeProcessStreams;
  readonly assets: Readonly<Record<string, unknown>>;
  readonly isSeeded: () => boolean;
  readonly onMissing: (member: string) => void;
  readonly codeGeneration: NodeGeneratedCodeOpenPort;
  readonly scenario: ClaudeHookScenario;
  readonly dispatches: ClaudeHooksDispatchRecord[];
  readonly standard: StandardProofAdapter;
}

/** Builds the official child-process path and registers Signalbox's opaque hook executable. */
export function createClaudeHookRuntime(options: ClaudeHookRuntimeOptions) {
  const capacity = options.capacity;
  const cpuAccounting = new KernelCpuAccounting(monotonicNowNs);
  const machineCalls = { count: 0 };
  let dispatch: KernelHookInvoker | undefined;
  const invoke: KernelHookInvoker = (id, payload, invocation) => {
    if (!dispatch) throw new Error("Claude hook service is not ready");
    return dispatch(id, payload, invocation);
  };

  const commandPrograms = createClaudeHookProgramHost({
    filesystem: options.filesystem,
    wakes: options.wakes,
    programs: options.programs,
    loader: options.loader,
    capacity,
    cpuAccounting,
    invoke,
  });
  const kernelHost = commandPrograms.host;
  const execution = kernelHost.cpuExecution;
  if (!execution) throw new Error("Claude hook proof omitted CPU execution accounting");
  const cpuRoot = execution.root;
  const root = kernelHost.processes.info();
  if (root.status !== "ok") throw new Error("Claude hook proof has no root process identity");
  const owner = options.filesystem.posixCredentials;
  if (owner === undefined || options.identity.user === undefined) {
    throw new Error("Claude hook proof needs filesystem and Node user identities");
  }
  const identity = Object.freeze({
    ...options.identity,
    user: { ...options.identity.user, uid: owner.uid, gid: owner.gid },
    pid: root.value.pid,
    ppid: root.value.parentPid,
  });
  const processContext = {
    filesystem: options.filesystem,
    env: options.env,
    identity,
    streams: options.streams,
    processes: kernelHost.processes,
    cpuAccounting: cpuRoot,
  };
  const process = createNodeProcess(processContext);
  const childProcess = createNodeChildProcess(kernelHost, {
    filesystem: options.filesystem,
    env: options.env,
  });
  const bunHost = createNodeBunHost({
    filesystem: options.fs,
    process,
    childProcess,
    programHost: kernelHost,
    main: "/$bunfs/root/cli",
    version: "1.3.11",
    revision: "signalbox-workerd",
    onMissing: options.onMissing,
  });
  const files = bunHost.files;
  if (!files) throw new Error("Claude hook proof omitted its Bun file adapter");
  const bun = createBunShim({
    ...bunHost,
    files: {
      ...files,
      async readFile(target: BunFileTarget) {
        if (
          typeof target === "string" &&
          Object.hasOwn(options.assets, target) &&
          !options.isSeeded()
        ) {
          throw Object.assign(new Error("Diagnostic Claude asset bytes are not seeded"), {
            code: "ERR_DIAGNOSTIC_ASSET_UNSEEDED",
          });
        }
        return files.readFile(target);
      },
    },
  }).bun;

  const generated = createNodeGeneratedCode({
    storage: options.storage,
    scopeId: "claude-hooks-official-proof",
    fetcher: createNodeGeneratedCodeFetcher(options.codeGeneration),
  });
  const machine = {
    async spawn() {
      machineCalls.count += 1;
      throw new Error("Claude hook proof must not call the machine port");
    },
  };
  const computer = createComputerCommands({
    kernel: {
      host: kernelHost,
      filesystem: options.filesystem,
      ...(options.env.HOME === undefined ? {} : { home: options.env.HOME }),
    },
    escalation: new ComputerEscalationTable([
      { id: "proof-bash-would-match-machine-rule", executable: "/bin/bash", argvPrefix: ["-c"] },
    ]),
    machine,
  });
  dispatch = async (id, payload, invocation) => {
    const registration = options.scenario.registrations.get(id);
    if (!registration) throw new Error("Unknown Claude hook registration");
    const record: ClaudeHooksDispatchRecord = {
      id,
      event: registration.event,
      route: registration.kind,
      payload,
      elapsedMs: null,
    };
    options.dispatches.push(record);
    const startedAt = readMonotonicNs();
    try {
      const contextual = withOfficialHookContext(registration, payload);
      const service = createHookService({
        registrations: new Map([[id, contextual]]),
        commands: options.standard.commands(computer.isolate),
        generated,
        capacity,
      });
      const result = await service.invoke(id, payload, invocation);
      record.exit = result.exit;
      record.stdout = new TextDecoder().decode(result.stdout);
      record.stderr = new TextDecoder().decode(result.stderr);
      return result;
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      const endedAt = readMonotonicNs();
      const timing = elapsedMilliseconds(startedAt, endedAt);
      record.elapsedMs = timing.elapsedMs;
      if (timing.reason) record.timingUnavailableReason = timing.reason;
    }
  };

  const cleanup = createClaudeProofCleanup(
    {
      async dispose() {
        try {
          return await kernelHost.processes.dispose();
        } finally {
          await commandPrograms.drain();
        }
      },
    },
    cpuRoot,
  );
  return {
    kernelHost,
    processContext,
    process,
    childProcess,
    bun,
    cpuRoot,
    machineCalls,
    capacity,
    ...cleanup,
    enterUser: () => cpuRoot.enterUser(),
  };
}

function readMonotonicNs(): bigint | null {
  try {
    return monotonicNowNs();
  } catch {
    return null;
  }
}

function elapsedMilliseconds(
  startedAt: bigint | null,
  endedAt: bigint | null,
): { readonly elapsedMs: number | null; readonly reason?: string } {
  if (startedAt === null || endedAt === null) {
    return { elapsedMs: null, reason: "node:process.hrtime.bigint was unavailable" };
  }
  if (endedAt <= startedAt) {
    return {
      elapsedMs: null,
      reason: "the host monotonic clock did not advance during HookService.invoke",
    };
  }
  return { elapsedMs: Number(endedAt - startedAt) / 1_000_000 };
}

function createClaudeHookProgramHost(options: {
  readonly filesystem: KernelFileSystem;
  readonly wakes: KernelWakeRegistry;
  readonly programs: ChildProgramSources;
  readonly loader: ChildWorkerLoaderPort;
  readonly capacity: ChildWorkerCapacity;
  readonly cpuAccounting: KernelCpuAccounting;
  readonly invoke: KernelHookInvoker;
}) {
  const registry = new KernelProgramRegistry();
  const children = createSeededChildProgramCatalog({
    hostname: "signalbox-hooks-proof",
    registry,
    filesystem: options.filesystem,
    programs: options.programs,
    loader: options.loader,
    capacity: options.capacity,
  });
  const bindings = new Map(children.bindings);
  for (const [path, binding] of registerKernelHookProgram(registry, options.invoke)) {
    bindings.set(path, binding);
  }
  return {
    host: new KernelProgramHost({
      registry,
      wakes: options.wakes,
      programs: bindings,
      cpuAccounting: options.cpuAccounting,
    }),
    drain: children.drain,
  };
}
