import { createComputerCommands } from "../../src/computer/ComputerCommands.ts";
import { withOfficialHookContext } from "./officialHookContext.ts";
import type { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import { ComputerEscalationTable } from "../../src/computer/EscalationTable.ts";
import {
  createCodexHookServiceRegistrations,
  CODEX_ALL_HOOK_REGISTRATIONS,
  CODEX_HOOK_EXECUTABLE,
  CODEX_HOOK_PROGRAM_FACADE,
  CODEX_HOOK_REQUIREMENTS_PATH,
  PRE_TOOL_USE_CAPTURE_PATH,
  codexHookRequirements,
} from "./codexScenario.ts";
import {
  createNodeGeneratedCode,
  createNodeGeneratedCodeFetcher,
  type NodeGeneratedCodeInvokeInput,
  type NodeGeneratedCodeOpenPort,
} from "../../src/isolate/NodeGeneratedCode.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { canonicalFileByteSelection } from "../../src/kernel/KernelFileBytes.ts";
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
import type { Storage } from "../../src/kernel/storage.ts";
import { createHookService } from "../../src/hooks/HookService.ts";
import { KERNEL_HOOK_EXECUTABLE, registerKernelHookProgram } from "../../src/hooks/HookProgram.ts";
import { createStandardProofAdapter, type StandardProofAdapter } from "./standardProofAdapter.ts";
import { createProofCommandFilesystem } from "./proofCommandFilesystem.ts";
import type { CodexHookBashExpectation } from "./codexPayloads.ts";
import {
  captureStandardProofSessions,
  inspectStandardProofSessions,
} from "./standardProofRecords.ts";
import {
  verifyCodexHooks,
  type GeneratedCallRecord,
  type HookInvocationRecord,
  type IsolateCallRecord,
  type SignalboxCallRecord,
  type SpawnCallRecord,
} from "./codexVerification.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const SESSION_ROOT = "/home/codex/sessions";

type ProofEnv = Readonly<Record<string, unknown>>;
type GeneratedInvokeOptions = Readonly<{ signal?: AbortSignal }>;

interface GeneratedCodeInvokePort {
  invoke(input: NodeGeneratedCodeInvokeInput, options?: GeneratedInvokeOptions): Promise<Response>;
}

export interface CodexHookRuntimeConfiguration {
  readonly filesystem: KernelFileSystem;
  readonly storage: Storage;
  readonly facetStorage: Parameters<typeof createNodeGeneratedCode>[0]["storage"];
  readonly host: KernelProgramHost;
  readonly wakes: KernelWakeRegistry;
  readonly env: ProofEnv;
  readonly modelForward?: (request: Request) => Promise<Response>;
  readonly bashExpectation?: CodexHookBashExpectation;
}

export interface CodexHookRuntimeComposition {
  readonly prepare: () => Promise<void>;
  readonly modelHttp: (request: Request) => Promise<Response>;
  readonly commands: StandardProofAdapter["commands"];
  readonly commandFilesystem: KernelFileSystem;
  readonly proofContent: (filesystem: KernelFileSystem) => string;
  readonly scrubRecord: (record: unknown) => unknown;
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

/** Registers the owning facet's command bindings and its opaque hook dispatcher. */
export function createCodexHookRuntime(
  createPrograms: (registry: KernelProgramRegistry) => {
    readonly bindings: ReadonlyMap<string, KernelProgramBinding>;
    readonly drain: () => Promise<void>;
  },
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

  const registry = new KernelProgramRegistry();
  const commandPrograms = createPrograms(registry);
  const programs = new Map(commandPrograms.bindings);

  const hookPrograms = registerKernelHookProgram(registry, async (id, payload, invocation) => {
    const registration = CODEX_ALL_HOOK_REGISTRATIONS.find((candidate) => candidate.id === id);
    if (!registration || !hookService) throw new Error("Codex hook runtime was not configured");
    const record: HookInvocationRecord = {
      id,
      event: registration.event,
      kind: registration.kind,
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

  for (const [path, binding] of hookPrograms) programs.set(path, binding);
  let filePolicy: StandardProofAdapter["selectFileBytes"] | undefined;
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs,
    selectFileBytes: (input) => {
      if (!filePolicy) throw new Error("Codex proof file policy is not configured");
      return filePolicy(input);
    },
  });

  return {
    host,
    configure(configuration: CodexHookRuntimeConfiguration): CodexHookRuntimeComposition {
      if (configuration.host !== host) throw new Error("Codex proof host changed during setup");
      if (KERNEL_HOOK_EXECUTABLE !== CODEX_HOOK_EXECUTABLE)
        throw new Error("Codex hook facade path differs from its kernel registration");

      const sessionBaseline = captureStandardProofSessions(configuration.filesystem, SESSION_ROOT);
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
      let standard: StandardProofAdapter | undefined;
      let engineProcess: ReturnType<typeof admitEngineProcess> | undefined;
      let commandFilesystem: ReturnType<typeof createProofCommandFilesystem> | undefined;
      try {
        standard = createStandardProofAdapter(
          configuration.facetStorage,
          "codex-standard-hooks",
          configuration.modelForward,
          configuration.storage,
        );
        const activeStandard = standard;
        filePolicy = activeStandard.selectFileBytes;
        const registrations = createCodexHookServiceRegistrations((request) => {
          signalboxCalls.push({ request: structuredClone(request) });
        }, activeStandard.callback);
        commandFilesystem = createProofCommandFilesystem(configuration.filesystem);
        const activeCommandFilesystem = commandFilesystem;
        engineProcess = admitEngineProcess(host);
        const activeEngine = engineProcess;
        const computer = createComputerCommands({
          kernel: {
            host,
            filesystem: configuration.filesystem,
            fileBytes: canonicalFileByteSelection,
            parent: activeEngine.parent,
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
        const isolateCommands = activeStandard.commands(computer.isolate);

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
            return isolateCommands.exec(command, signal).then(
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
          prepare: activeStandard.prepare,
          modelHttp: (request) => activeStandard.serve(request, "openai"),
          commands: activeStandard.commands,
          commandFilesystem: activeCommandFilesystem.filesystem,
          proofContent: (filesystem) => {
            const fd = filesystem.open("/workspace/proof.txt", KernelOpenFlags.O_RDONLY);
            try {
              const bytes = new Uint8Array(Number(filesystem.fstat(fd).size));
              const count = filesystem.read(fd, bytes, 0n);
              if (count !== bytes.byteLength) throw new Error("Native patch read ended early");
              return decoder.decode(bytes);
            } finally {
              filesystem.close(fd);
            }
          },
          scrubRecord: activeStandard.scrubRecord,
          bootstrap: (input) => ({
            ...input,
            overrides: { ...input.overrides, "features.hooks": true },
          }),
          parent: activeEngine.parent,
          signal: activeEngine.signal,
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
                parent: activeEngine.parent,
                signal: activeEngine.signal,
                home: "/home/codex",
              },
              request,
            );
            finishTiming(call);
            call.result = result.status;
            return result;
          },
          verify: async ({ filesystem }) => {
            await commandPrograms.drain();
            const standardResult = activeStandard.inspect();
            const sessionMirror = inspectStandardProofSessions(
              filesystem,
              SESSION_ROOT,
              sessionBaseline,
            );
            const result = await verifyCodexHooks({
              filesystem,
              host,
              parent: activeEngine.parent,
              invocations,
              isolateCalls,
              generatedCalls,
              signalboxCalls,
              spawnCalls,
              machineAttempts,
              ...(configuration.bashExpectation === undefined
                ? {}
                : { bashExpectation: configuration.bashExpectation }),
              standard: standardResult,
              nativeFileRead: activeStandard.output.takeFileRead("/workspace/proof.txt"),
            });
            return {
              ...result,
              standard: standardResult,
              sessionMirror,
              capacity: { active: capacity.active, limit: capacity.limit },
              ok: result.ok && standardResult.ok && sessionMirror.ok && capacity.active === 0,
            };
          },
          async finish({ exit, failure }) {
            try {
              await activeEngine.finish({ exit, failure });
            } finally {
              try {
                await commandPrograms.drain();
              } finally {
                try {
                  activeCommandFilesystem.close();
                } finally {
                  activeStandard.close();
                }
              }
            }
          },
        };
      } catch (error) {
        if (engineProcess) {
          void engineProcess
            .finish({ exit: undefined, failure: String(error) })
            .catch(() => undefined)
            .finally(() => {
              try {
                commandFilesystem?.close();
              } finally {
                standard?.close();
              }
            });
        } else {
          try {
            commandFilesystem?.close();
          } finally {
            standard?.close();
          }
        }
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
  writeFile(filesystem, PRE_TOOL_USE_CAPTURE_PATH, new Uint8Array(), 0o644);
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
