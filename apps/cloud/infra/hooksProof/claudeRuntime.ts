// @effect-diagnostics nodeBuiltinImport:off - this runtime is an isolated proof host.
import * as NodeProcess from "node:process";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import { createComputerCommands } from "../../src/computer/ComputerCommands.ts";
import { ComputerEscalationTable } from "../../src/computer/EscalationTable.ts";
import {
  createNodeGeneratedCode,
  type NodeGeneratedCodeFetcher,
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
import { ABI_VERSION, KernelProgramRegistry } from "../../src/kernel/KernelAbi.ts";
import { KernelCpuAccounting } from "../../src/kernel/KernelCpuAccounting.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import {
  KERNEL_BASH_ARTIFACT,
  createKernelBashProgram,
} from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { registerKernelBusyboxCat } from "../../src/kernel/KernelBusyboxPrograms.ts";
import {
  KernelProgramHost,
  type KernelProgramBinding,
} from "../../src/kernel/KernelProgramHost.ts";
import {
  createKernelRipgrepProgram,
  KERNEL_RIPGREP_PROGRAM_MANIFEST,
} from "../../src/kernel/KernelRipgrepProgram.ts";
import type { KernelCommandExit } from "../../src/kernel/KernelCommandForwarder.ts";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createHookService, type HookRegistration } from "../../src/hooks/HookService.ts";
import { registerKernelHookProgram, type KernelHookInvoker } from "../../src/hooks/HookProgram.ts";
import type { HarnessHookEvent, HarnessHookJson } from "../../src/hooks/HarnessHooks.ts";
import type { ProofProgramModules } from "../claudeTurnProof/proofPrograms.ts";
import type { ClaudeHookRoute, ClaudeHookScenario } from "./claudeScenario.ts";

const monotonicNowNs = NodeProcess.hrtime.bigint.bind(NodeProcess.hrtime);

export interface ClaudeHooksDispatchRecord {
  readonly id: string;
  readonly event: HarnessHookEvent;
  readonly route: ClaudeHookRoute;
  readonly payload: HarnessHookJson;
  elapsedMs: number | null;
  timingUnavailableReason?: string;
  exit?: KernelCommandExit;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface ClaudeHookRuntimeOptions {
  readonly filesystem: KernelFileSystem;
  readonly fs: NodeFsModules;
  readonly wakes: KernelWakeRegistry;
  readonly storage: FacetStorage;
  readonly programs: ProofProgramModules;
  readonly env: NodeProcessEnvironment;
  readonly identity: NodeRuntimeIdentity;
  readonly streams: NodeProcessStreams;
  readonly assets: Readonly<Record<string, unknown>>;
  readonly isSeeded: () => boolean;
  readonly onMissing: (member: string) => void;
  readonly codeGeneration: NodeGeneratedCodeFetcher;
  readonly scenario: ClaudeHookScenario;
  readonly dispatches: ClaudeHooksDispatchRecord[];
}

/** Builds the official child-process path and registers Signalbox's opaque hook executable. */
export function createClaudeHookRuntime(options: ClaudeHookRuntimeOptions) {
  const capacity = new ChildWorkerCapacity();
  const cpuAccounting = new KernelCpuAccounting(monotonicNowNs);
  const machineCalls = { count: 0 };
  let dispatch: KernelHookInvoker | undefined;
  const invoke: KernelHookInvoker = (id, payload, invocation) => {
    if (!dispatch) throw new Error("Claude hook service is not ready");
    return dispatch(id, payload, invocation);
  };

  const kernelHost = createClaudeHookProgramHost({
    filesystem: options.filesystem,
    wakes: options.wakes,
    programs: options.programs,
    cpuAccounting,
    invoke,
  });
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
    fetcher: options.codeGeneration,
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
      const contextual = withOfficialSession(registration, payload);
      const service = createHookService({
        registrations: new Map([[id, contextual]]),
        commands: computer.isolate,
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

  return {
    kernelHost,
    processContext,
    process,
    childProcess,
    bun,
    cpuRoot,
    machineCalls,
    close: () => cpuRoot.stop(),
    enterUser: () => cpuRoot.enterUser(),
  };
}

function withOfficialSession(
  registration: HookRegistration,
  payload: HarnessHookJson,
): HookRegistration {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return registration;
  }
  const sessionId = Reflect.get(payload, "session_id");
  if (typeof sessionId !== "string" || sessionId.length === 0) return registration;
  const toolCallId = Reflect.get(payload, "tool_use_id");
  return {
    ...registration,
    sessionId,
    ...(typeof toolCallId === "string" ? { toolCallId } : {}),
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
  readonly programs: ProofProgramModules;
  readonly cpuAccounting: KernelCpuAccounting;
  readonly invoke: KernelHookInvoker;
}): KernelProgramHost {
  assertPinnedBusyboxCat(options.filesystem, options.programs.busyboxCatBase64);
  const registry = new KernelProgramRegistry();
  const bindings = new Map(registerKernelBusyboxCat(registry, options.programs.busybox));
  const bashManifest = Object.freeze({
    name: "@nimbus/bash",
    version: KERNEL_BASH_ARTIFACT.version,
    abiVersion: ABI_VERSION,
    requiredCapabilities: Object.freeze([
      "process.spawn" as const,
      "process.wait" as const,
      "process.signal" as const,
    ]),
    entrypoint: "nimbus-bash:" + KERNEL_BASH_ARTIFACT.sha256,
  });
  register(registry, bashManifest.name, bashManifest);
  // Node child_process.exec defaults to /bin/sh. The host allows one executable
  // mapping per manifest identity, so give that alias its own manifest name.
  const shManifest = Object.freeze({ ...bashManifest, name: "@nimbus/sh" });
  register(registry, shManifest.name, shManifest);
  const posix = options.filesystem.posixPolicy;
  if (!posix) throw new Error("Claude hook Bash requires the filesystem POSIX policy");
  const credentials = posix.credentials;
  const bash = createKernelBashProgram({
    module: options.programs.bash,
    credentials: {
      uid: credentials.uid,
      gid: credentials.gid,
      euid: credentials.euid,
      egid: credentials.egid,
      umask: posix.umask,
      hostname: "signalbox-claude-proof",
    },
  });
  bindings.set("/bin/bash", { manifest: bashManifest, implementation: bash });
  bindings.set("/bin/sh", { manifest: shManifest, implementation: bash });
  register(registry, KERNEL_RIPGREP_PROGRAM_MANIFEST.name, KERNEL_RIPGREP_PROGRAM_MANIFEST);
  bindings.set("/bin/rg", {
    manifest: KERNEL_RIPGREP_PROGRAM_MANIFEST,
    implementation: createKernelRipgrepProgram({ module: options.programs.ripgrep }),
  });
  for (const [path, binding] of registerKernelHookProgram(registry, options.invoke)) {
    bindings.set(path, binding);
  }
  return new KernelProgramHost({
    registry,
    wakes: options.wakes,
    programs: bindings,
    cpuAccounting: options.cpuAccounting,
  });
}

function register(
  registry: KernelProgramRegistry,
  name: string,
  manifest: KernelProgramBinding["manifest"],
): void {
  const result = registry.register(manifest);
  if (result.status !== "ok") {
    const detail = result.status === "error" ? result.error.message : "registration blocked";
    throw new Error("Could not register " + name + ": " + detail);
  }
}

function assertPinnedBusyboxCat(filesystem: KernelFileSystem, base64: string): void {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error("Pinned BusyBox cat bytes are not valid base64");
  }
  const decoded = atob(base64);
  const expected = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const descriptor = filesystem.open("/bin/cat", KernelOpenFlags.O_RDONLY);
  let actual: Uint8Array;
  try {
    const size = Number(filesystem.fstat(descriptor).size);
    actual = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const count = filesystem.read(descriptor, actual.subarray(offset), null);
      if (count === 0) break;
      offset += count;
    }
    actual = actual.subarray(0, offset);
  } finally {
    filesystem.close(descriptor);
  }
  if (!equalBytes(actual, expected) || expected.byteLength !== KERNEL_BUSYBOX_ARTIFACT.bytes) {
    throw new Error("Seeded /bin/cat is not the pinned BusyBox artifact");
  }
  const metadata = filesystem.getPosixMetadata("/bin/cat");
  const owner = filesystem.posixCredentials;
  if (
    (metadata.mode & 0o777) !== 0o755 ||
    owner === undefined ||
    metadata.uid !== owner.euid ||
    metadata.gid !== owner.egid
  ) {
    throw new Error("Seeded /bin/cat does not have the proof filesystem executable identity");
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
