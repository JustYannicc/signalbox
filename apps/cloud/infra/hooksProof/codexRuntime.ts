import { createComputerCommands } from "../../src/computer/ComputerCommands.ts";
import { withOfficialHookContext } from "./officialHookContext.ts";
import { createNodeGeneratedCodeFetcher } from "../../src/isolate/node/generated/invocation-fetcher.ts";
import type { NodeGeneratedCodeOpenPort } from "../../src/isolate/node/generated/invocation.ts";
import type { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import { ComputerEscalationTable } from "../../src/computer/EscalationTable.ts";
import {
  createCodexHookServiceRegistrations,
  CODEX_HOOK_EXECUTABLE,
  CODEX_HOOK_PROGRAM_FACADE,
  CODEX_HOOK_REGISTRATIONS,
  CODEX_HOOK_REQUIREMENTS_PATH,
  codexHookRequirements,
} from "./codexScenario.ts";
import {
  createNodeGeneratedCode,
  type NodeGeneratedCodeInvokeInput,
} from "../../src/isolate/NodeGeneratedCode.ts";
import {
  createKernelBashProgram,
  KERNEL_BASH_ARTIFACT,
} from "../../src/kernel/KernelBashProgram.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import {
  kernelError,
  kernelOk,
  KernelProgramRegistry,
  type KernelHandle,
} from "../../src/kernel/KernelAbi.ts";
import type { KernelCommand } from "../../src/kernel/KernelCommandForwarder.ts";
import {
  KernelProgramHost,
  type KernelProgramBinding,
} from "../../src/kernel/KernelProgramHost.ts";
import type { KernelExitStatus } from "../../src/kernel/KernelProcessTable.ts";
import type { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createHookService } from "../../src/hooks/HookService.ts";
import { KERNEL_HOOK_EXECUTABLE, registerKernelHookProgram } from "../../src/hooks/HookProgram.ts";
import {
  CODEX_HOOK_MODES,
  verifyCodexHooks,
  type GeneratedCallRecord,
  type HookInvocationRecord,
  type IsolateCallRecord,
  type SignalboxCallRecord,
  type SpawnCallRecord,
} from "./codexVerification.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

type ProofEnv = Readonly<Record<string, unknown>>;
type GeneratedInvokeOptions = Readonly<{ signal?: AbortSignal }>;

interface GeneratedCodeInvokePort {
  invoke(input: NodeGeneratedCodeInvokeInput, options?: GeneratedInvokeOptions): Promise<Response>;
}

export interface CodexHookRuntimeConfiguration {
  readonly filesystem: KernelFileSystem;
  readonly facetStorage: Parameters<typeof createNodeGeneratedCode>[0]["storage"];
  readonly host: KernelProgramHost;
  readonly wakes: KernelWakeRegistry;
  readonly env: ProofEnv;
}

export interface CodexHookRuntimeComposition {
  readonly bootstrap: (input: { readonly overrides: Readonly<Record<string, unknown>> }) => {
    readonly overrides: Readonly<Record<string, unknown>>;
  };
  readonly parent: KernelHandle<"process">;
  readonly signal: AbortSignal;
  readonly spawn: (
    request: Parameters<KernelProgramHost["spawn"]>[1],
  ) => ReturnType<KernelProgramHost["spawn"]>;
  readonly verify: (input: {
    readonly filesystem: KernelFileSystem;
  }) => Promise<Record<string, unknown>>;
  readonly finish: (input: {
    readonly exit: number | undefined;
    readonly failure: string | undefined;
  }) => Promise<void>;
}

/** Registers the interim Bash and host-owned hook dispatcher in the session kernel. */
export function createCodexHookRuntime(
  bashModule: WebAssembly.Module,
  wakes: KernelWakeRegistry,
  capacity: ChildWorkerCapacity,
) {
  const invocations: HookInvocationRecord[] = [];
  const isolateCalls: IsolateCallRecord[] = [];
  const generatedCalls: GeneratedCallRecord[] = [];
  const signalboxCalls: SignalboxCallRecord[] = [];
  const spawnCalls: SpawnCallRecord[] = [];
  const machineAttempts: { readonly executable: string; readonly argv: readonly string[] }[] = [];
  let hookService: ReturnType<typeof createHookService> | undefined;
  let engineProcess: ReturnType<typeof admitEngineProcess> | undefined;

  const registry = new KernelProgramRegistry();
  const bashManifest = {
    name: "gnu-bash",
    version: KERNEL_BASH_ARTIFACT.revision,
    abiVersion: 1,
    requiredCapabilities: ["process.spawn", "process.wait", "process.signal"],
    entrypoint: "/bin/bash",
  } as const;
  register(registry, bashManifest);

  const bashBinding: KernelProgramBinding = {
    manifest: bashManifest,
    // The parent replaces this interim in-facet binding with its shared child Worker adapter.
    implementation: createKernelBashProgram({
      module: bashModule,
      credentials: {
        uid: 1000,
        gid: 1000,
        euid: 1000,
        egid: 1000,
        umask: 0o022,
        hostname: "codex-hooks-proof",
      },
    }),
  };

  const hookPrograms = registerKernelHookProgram(registry, async (id, payload, invocation) => {
    const registration = CODEX_HOOK_REGISTRATIONS.find((candidate) => candidate.id === id);
    if (!registration || !hookService) throw new Error("Codex hook runtime was not configured");
    const record: HookInvocationRecord = {
      id,
      event: registration.event,
      kind: CODEX_HOOK_MODES[registration.event],
      input: structuredClone(payload),
      startedAtMs: readClock(),
      elapsedMs: null,
    };
    try {
      const result = await hookService.invoke(id, payload, {
        signal: invocation.signal,
        cwd: invocation.cwd,
        env: invocation.env,
      });
      finishTiming(record);
      record.stdout = decoder.decode(result.stdout);
      record.stderr = decoder.decode(result.stderr);
      record.exit = result.exit;
      invocations.push(record);
      return result;
    } catch (error) {
      finishTiming(record);
      record.error = String(error);
      invocations.push(record);
      throw error;
    }
  });

  const programs = new Map<string, KernelProgramBinding>([["/bin/bash", bashBinding]]);
  for (const [path, binding] of hookPrograms) programs.set(path, binding);
  const host = new KernelProgramHost({ registry, wakes, programs });

  return {
    host,
    configure(configuration: CodexHookRuntimeConfiguration): CodexHookRuntimeComposition {
      if (configuration.host !== host) throw new Error("Codex proof host changed during setup");
      if (KERNEL_HOOK_EXECUTABLE !== CODEX_HOOK_EXECUTABLE)
        throw new Error("Codex hook facade path differs from its kernel registration");

      seedCodexSettings(configuration.filesystem);
      getBinding(configuration.env, "CHILD_WORKERS");
      const codeGeneration = createNodeGeneratedCodeFetcher(
        asOpenPort(getBinding(configuration.env, "CODE_GENERATION")),
      );

      const generatedService = createNodeGeneratedCode({
        storage: configuration.facetStorage,
        scopeId: "codex-hook-proof",
        fetcher: codeGeneration,
      });
      const generated = instrumentGeneratedCode(generatedService, generatedCalls);
      const registrations = createCodexHookServiceRegistrations((request) => {
        signalboxCalls.push({ request: structuredClone(request) });
      });
      engineProcess = admitEngineProcess(host);
      try {
        const computer = createComputerCommands({
          kernel: {
            host,
            filesystem: configuration.filesystem,
            parent: engineProcess.parent,
            home: "/home/codex",
          },
          escalation: new ComputerEscalationTable([
            { id: "would-escalate-hook-bash", executable: "/bin/bash" },
          ]),
          machine: {
            async spawn(command: KernelCommand) {
              machineAttempts.push({ executable: command.executable, argv: [...command.argv] });
              throw new Error("Codex hook proof must not execute on the machine");
            },
          },
        });

        const commands = {
          exec: (command: KernelCommand, signal: AbortSignal) => {
            const call: IsolateCallRecord = {
              executable: command.executable,
              argv: [...command.argv],
              cwd: command.cwd,
              startedAtMs: readClock(),
              elapsedMs: null,
            };
            isolateCalls.push(call);
            return computer.isolate.exec(command, signal).then(
              (child) => ({
                stdin: child.stdin,
                stdout: child.stdout,
                stderr: child.stderr,
                exited: child.exited.then(
                  (exit) => {
                    finishTiming(call);
                    call.exit = exit;
                    return exit;
                  },
                  (error: unknown) => {
                    finishTiming(call);
                    call.error = String(error);
                    throw error;
                  },
                ),
                signal: child.signal,
                dispose: child.dispose,
              }),
              (error: unknown) => {
                finishTiming(call);
                call.error = String(error);
                throw error;
              },
            );
          },
        };
        hookService = {
          invoke(id, payload, invocation) {
            const registration = registrations.get(id);
            if (!registration) throw new Error("Unknown Codex hook registration");
            return createHookService({
              registrations: new Map([[id, withOfficialHookContext(registration, payload)]]),
              commands,
              generated,
              capacity,
            }).invoke(id, payload, invocation);
          },
        };

        return {
          bootstrap: (input) => ({
            ...input,
            overrides: { ...input.overrides, "features.hooks": true },
          }),
          parent: engineProcess.parent,
          signal: engineProcess.signal,
          async spawn(request) {
            const call: SpawnCallRecord = {
              executable: request.execPath,
              argv: [...request.argv],
              cwd: request.cwd,
              startedAtMs: readClock(),
              elapsedMs: null,
            };
            spawnCalls.push(call);
            const result = await host.spawn(
              {
                filesystem: configuration.filesystem,
                parent: engineProcess!.parent,
                signal: engineProcess!.signal,
                home: "/home/codex",
              },
              request,
            );
            finishTiming(call);
            call.result = result.status;
            return result;
          },
          verify: ({ filesystem }) =>
            verifyCodexHooks({
              filesystem,
              host,
              parent: engineProcess!.parent,
              invocations,
              isolateCalls,
              generatedCalls,
              signalboxCalls,
              spawnCalls,
              machineAttempts,
            }),
          finish: ({ exit, failure }) =>
            engineProcess?.finish({ exit, failure }) ?? Promise.resolve(),
        };
      } catch (error) {
        void engineProcess
          .finish({ exit: undefined, failure: String(error) })
          .catch(() => undefined);
        throw error;
      }
    },
  };
}

function instrumentGeneratedCode(
  generated: GeneratedCodeInvokePort,
  calls: GeneratedCallRecord[],
): GeneratedCodeInvokePort {
  return {
    async invoke(input, options) {
      const call: GeneratedCallRecord = {
        id: input.id,
        input: structuredClone(input.input),
        startedAtMs: readClock(),
        elapsedMs: null,
      };
      calls.push(call);
      try {
        const response = await generated.invoke(input, options);
        call.status = response.status;
        finishTiming(call);
        return response;
      } catch (error) {
        finishTiming(call);
        call.error = String(error);
        throw error;
      }
    },
  };
}

function admitEngineProcess(host: KernelProgramHost) {
  const controller = new AbortController();
  let resolveCompletion!: (status: KernelExitStatus) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<KernelExitStatus>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);

  const admitted = host.processes.spawn(
    undefined,
    () => ({
      completion,
      signal(signal: number) {
        if (signal !== 9 && signal !== 15)
          return kernelError("UNSUPPORTED", "Only terminate and kill are supported");
        controller.abort(new Error("Codex engine process was cancelled"));
        return kernelOk(undefined);
      },
    }),
    async () => {},
  );
  if (admitted.status !== "ok")
    throw new Error(`Could not admit Codex engine process: ${admitted.status}`);

  let finished = false;
  return {
    parent: admitted.value.handle,
    signal: controller.signal,
    async finish(input: {
      readonly exit: number | undefined;
      readonly failure: string | undefined;
    }) {
      if (finished) return;
      finished = true;
      if (input.failure !== undefined || input.exit === undefined) {
        controller.abort(new Error(input.failure ?? "Codex engine returned no exit status"));
        rejectCompletion(new Error(input.failure ?? "Codex engine returned no exit status"));
      } else {
        resolveCompletion({ exitCode: input.exit, signal: 0, coreDumped: false });
      }
      await host.exitStatus(admitted.value.handle);
    },
  };
}

function seedCodexSettings(filesystem: KernelFileSystem): void {
  for (const path of ["/etc", "/etc/codex", "/usr", "/usr/bin", "/workspace/codex-hook-inputs"])
    ensureDirectory(filesystem, path);
  writeFile(
    filesystem,
    CODEX_HOOK_REQUIREMENTS_PATH,
    encoder.encode(codexHookRequirements()),
    0o644,
  );
  writeFile(filesystem, CODEX_HOOK_EXECUTABLE, encoder.encode(CODEX_HOOK_PROGRAM_FACADE), 0o755);
}

function ensureDirectory(filesystem: KernelFileSystem, path: string): void {
  try {
    filesystem.mkdir(path, 0o755);
  } catch (error) {
    if (
      (error as { code?: string }).code !== "EEXIST" ||
      filesystem.stat(path).type !== "directory"
    )
      throw error;
  }
}

function writeFile(
  filesystem: KernelFileSystem,
  path: string,
  bytes: Uint8Array,
  mode: number,
): void {
  const fd = filesystem.open(
    path,
    KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_CREAT | KernelOpenFlags.O_TRUNC,
    mode,
  );
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = filesystem.write(fd, bytes.subarray(offset), null);
      if (written <= 0) throw new Error(`No write progress for ${path}`);
      offset += written;
    }
  } finally {
    filesystem.close(fd);
  }
  filesystem.chmod(path, mode);
}

function getBinding(env: ProofEnv, name: string): unknown {
  const value = env[name];
  if (value === undefined || value === null) throw new Error(`Codex hook proof requires ${name}`);
  return value;
}

function asOpenPort(value: unknown): NodeGeneratedCodeOpenPort {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { open?: unknown }).open !== "function"
  ) {
    throw new Error("CODE_GENERATION is not a managed invocation binding");
  }
  return value as NodeGeneratedCodeOpenPort;
}

function register(
  registry: KernelProgramRegistry,
  manifest: Parameters<KernelProgramRegistry["register"]>[0],
): void {
  const result = registry.register(manifest);
  if (result.status !== "ok")
    throw new Error(`Could not register ${manifest.name}: ${result.status}`);
}

function readClock(): number | null {
  try {
    const value = globalThis.performance?.now();
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function finishTiming(record: {
  readonly startedAtMs: number | null;
  elapsedMs: number | null;
  timingUnavailableReason?: string;
}): void {
  const endedAtMs = readClock();
  if (record.startedAtMs === null || endedAtMs === null) {
    record.elapsedMs = null;
    record.timingUnavailableReason = "performance.now() was unavailable";
    return;
  }
  if (endedAtMs <= record.startedAtMs) {
    record.elapsedMs = null;
    record.timingUnavailableReason = "performance.now() did not advance during the call";
    return;
  }
  record.elapsedMs = endedAtMs - record.startedAtMs;
}
