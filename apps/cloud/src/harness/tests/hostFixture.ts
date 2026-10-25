import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import type { Computer } from "../../computer/Computer.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { kernelFileByteViewStorage } from "../../kernel/KernelLowerFileSystemStorage.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { createMemoryFilePersistencePorts } from "../../kernel/MemoryFilePersistencePorts.ts";
import {
  createHarnessSessionHost,
  type HarnessHostOptions,
  type NativeMcpConfiguration,
  type NativeThreadLoad,
  type TurnAccess,
  type ExecutorMcpPort,
} from "../HarnessSessionHost.ts";
import type { HarnessProcessStartup } from "../HarnessProcessLifetime.ts";
import { HarnessError, type HarnessOpenInput } from "../Harness.ts";
import { fixture } from "../adapter/tests/fixture.ts";
import { claudeFixture, codexFixture } from "../releaseLoader/tests/artifactFixtures.ts";
import { hostSqlite } from "./hostSqlite.ts";

const bytes = new TextEncoder().encode("executable-fixture");
const metadata = { mode: 0o755, uid: 1000, gid: 1000 };
const credentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000 };
const posix = { credentials, umask: 0o022 };
type Grant = { readonly secret: string };

export const hostFixture = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(Effect.sync(hostSqlite), (value) =>
    Effect.sync(() => value.dispose()),
  );
  const artifact = yield* Effect.promise(() => claudeFixture());
  const hashBuffer = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  const sha256 = Array.from(new Uint8Array(hashBuffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  let handle = database.open();
  const configurations: NativeMcpConfiguration[] = [];
  const configurationLoads: NativeThreadLoad[] = [];
  const configurationSignals: AbortSignal[] = [];
  const acquisitions: HarnessOpenInput[] = [];
  const computers: Computer["files"][] = [];
  const persistenceBindings: boolean[] = [];
  const forwards: Parameters<ExecutorMcpPort<Grant>["forward"]>[0][] = [];
  const transportRequests: Request[] = [];
  const configured = yield* Queue.unbounded<NativeMcpConfiguration>();
  let configureGate = Effect.void;
  let programReadGate = async () => {};
  let configurationFailure: HarnessError | undefined;
  let processStartup: HarnessProcessStartup | undefined;
  let acquisitionFailure = false;
  let missingConfigure = false;
  let subscription = false;
  let cleanup: Effect.Effect<void> = Effect.void;
  let forward: ExecutorMcpPort<Grant>["forward"] = async () => new Response("executor");
  let runtimeInput: Parameters<HarnessHostOptions<Grant>["buildRuntime"]>[0] | undefined;
  let loaderReads = 0;
  const make = (overrides: Partial<HarnessHostOptions<Grant>> = {}, closeOwner = Effect.void) =>
    Effect.gen(function* () {
      const adapter = yield* fixture;
      const lifetime = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(lifetime, Exit.void));
      const options: HarnessHostOptions<Grant> = {
        threadId: adapter.input.session.threadId,
        files: {
          identity: "canonical-host-files",
          database: handle.storage,
          nowNs: () => 0n,
          wakes: new KernelWakeRegistry(),
          persistencePorts: createMemoryFilePersistencePorts(),
          rootMetadata: metadata,
          posix,
          assetMode: 0o644,
          cwd: "/workspace",
        },
        release: {
          ...artifact.options,
          source: {
            read: async (ref, path) => {
              loaderReads++;
              return artifact.options.source.read(ref, path);
            },
          },
        },
        programs: {
          sourceIdentity: "test-program-catalog",
          files: {
            "/bin/bash": { ...metadata, bytes: bytes.length, sha256 },
            "/bin/cat": { ...metadata, bytes: bytes.length, sha256 },
          },
          read: async () => {
            await programReadGate();
            return bytes;
          },
        },
        modelTransport: async (request) => {
          transportRequests.push(request);
          return new Response("model");
        },
        executor: {
          forward: (input) => {
            forwards.push(input);
            return forward(input);
          },
        },
        bindComputer: ({ files, persistence, signal }) =>
          Effect.gen(function* () {
            computers.push(files);
            const root = files.resolve("/");
            persistenceBindings.push(
              kernelFileByteViewStorage(root.mount.storage, root.inode) === persistence.storage,
            );
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                if (!signal.aborted) throw new Error("Computer closed before owner cancellation");
              }),
            );
            return {
              exec: adapter.input.computer.exec,
              port: adapter.input.computer.port,
              save: adapter.input.computer.save,
            };
          }),
        buildRuntime: (input) =>
          Effect.gen(function* () {
            runtimeInput = input;
            yield* Effect.addFinalizer(() => Effect.suspend(() => cleanup));
            const binding = {
              startup: () => processStartup,
              factory: {
                open: (supplied: HarnessOpenInput) =>
                  Effect.suspend(() => {
                    acquisitions.push(supplied);
                    return acquisitionFailure
                      ? Effect.fail(
                          new HarnessError({
                            operation: "open",
                            message: "recording open failed",
                          }),
                        )
                      : Effect.succeed(
                          subscription
                            ? {
                                ...adapter.runtime,
                                subscribeEvents: Effect.succeed({
                                  events: adapter.runtime.events,
                                  close: Effect.void,
                                }),
                              }
                            : adapter.runtime,
                        );
                  }),
              },
              configureMcp: (
                config: NativeMcpConfiguration,
                signal: AbortSignal,
                load: NativeThreadLoad,
              ) =>
                Effect.gen(function* () {
                  configurations.push(config);
                  configurationLoads.push(load);
                  configurationSignals.push(signal);
                  yield* Queue.offer(configured, config);
                  yield* configureGate;
                  if (configurationFailure !== undefined)
                    return yield* Effect.fail(configurationFailure);
                }),
            };
            if (missingConfigure) Reflect.deleteProperty(binding, "configureMcp");
            return binding;
          }),
        ...overrides,
      };
      const host = yield* createHarnessSessionHost(options, closeOwner).pipe(
        Scope.provide(lifetime),
      );
      return {
        host,
        adapter,
        options,
        lifetime,
        open: (id = "boot-1") => host.open({ session: adapter.input.session, bootAttemptId: id }),
        checkpoint: () => ({
          release: host.release,
          providerSession: adapter.runtime.providerSession,
          snapshot: {
            providerThread: {
              ...adapter.turn.providerThread,
              nativeThreadRef: {
                driver: adapter.runtime.driver,
                nativeId: "native-thread",
                strength: "strong" as const,
              },
            },
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          },
          revision: { commit: "checkpoint-revision" },
        }),
      };
    });
  const access = (secret: string, controller = new AbortController()): TurnAccess<Grant> => ({
    grant: { secret },
    signal: controller.signal,
    connections: {
      servers: [
        { id: "normal-server-id", name: "normal-server", directTools: ["direct_tool"] },
        { id: "search-only-id", name: "search-only", directTools: [] },
      ],
    },
  });
  return {
    make,
    access,
    configurations,
    configurationLoads,
    configurationSignals,
    acquisitions,
    computers,
    persistenceBindings,
    forwards,
    transportRequests,
    artifact,
    get handle() {
      return handle;
    },
    get loaderReads() {
      return loaderReads;
    },
    get runtimeInput() {
      if (runtimeInput === undefined) throw new Error("No recording runtime");
      return runtimeInput;
    },
    get mcp() {
      if (runtimeInput === undefined) throw new Error("No recording runtime");
      return runtimeInput.mcp;
    },
    reopen() {
      handle.close();
      handle = database.open();
    },
    setCleanup: (effect: Effect.Effect<void>) => {
      cleanup = effect;
    },
    failAcquisition: (value: boolean) => {
      acquisitionFailure = value;
    },
    failConfiguration: (
      failure = new HarnessError({ operation: "turn", message: "Native configuration failed." }),
    ) => {
      configurationFailure = failure;
    },
    setStartup: (startup: HarnessProcessStartup) => {
      processStartup = startup;
    },
    omitConfigurationPort: () => {
      missingConfigure = true;
    },
    useSubscription: () => {
      subscription = true;
    },
    setConfigureGate: (effect: Effect.Effect<void>) => {
      configureGate = effect;
    },
    setProgramReadGate: (gate: () => Promise<void>) => {
      programReadGate = gate;
    },
    setForward: (value: ExecutorMcpPort<Grant>["forward"]) => {
      forward = value;
    },
    nextConfiguration: Queue.take(configured),
    mutateFiles(fn: (files: KernelFileSystem) => void) {
      const storage = createFacetSqliteStorage(handle.storage, () => 0n);
      const files = new KernelFileSystem({ mounts: [{ path: "/", storage }], cwd: "/", posix });
      try {
        fn(files);
      } finally {
        files.dispose();
      }
    },
    async codexRelease() {
      return (await codexFixture()).options;
    },
  };
});

export function writeFixtureFile(files: KernelFileSystem, path: string, value: string) {
  const fd = files.open(
    path,
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
    0o644,
  );
  try {
    files.write(fd, new TextEncoder().encode(value), null);
  } finally {
    files.close(fd);
  }
}
