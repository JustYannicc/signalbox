import { systemIdentityForThread, type SystemIdentity } from "@t3tools/contracts/systemIdentity";
import { createKernelSessionStdio } from "../kernel/KernelSessionStdio.ts";
import { KernelWakeRegistry } from "../kernel/KernelWakeRegistry.ts";
import { KernelProcessTable } from "../kernel/KernelProcessTable.ts";
import { createHostStorage } from "../kernel/KernelHarnessStorage.ts";
import { createBootState } from "../kernel/KernelHarnessBoot.ts";
import { createKernelComputerHost } from "../kernel/KernelComputerHost.ts";
import { createKernelExecutableNamespace } from "../kernel/KernelExecutableNamespace.ts";
import { createComputerMachineProfile } from "../computer/ComputerMachineProfile.ts";
import { prepareHydratedRepository } from "../computer/ComputerRepositoryReadiness.ts";
import type { KernelCommandForwarder } from "../kernel/KernelCommandForwarder.ts";
import type { MachineFilesPort } from "../computer/MachineFilesPort.ts";
import type { HarnessHostFilesOptions } from "./host/contracts.ts";
import type { NodeHarnessProcessInput } from "./NodeHarnessProcess.ts";
import type { Computer } from "../computer/Computer.ts";
import type { ClaudeKernelInitialize, ClaudeKernelSessionPort } from "./ClaudeKernelSessionPort.ts";
import { remoteKernelSeedCatalog } from "./ClaudeKernelSeed.ts";
import type { LoadedHarnessRelease } from "./HarnessReleaseLoader.ts";
import type { HarnessFilesStoreResult } from "./HarnessFilesStore.ts";

export interface ClaudeKernelLocalOptions {
  readonly files: Omit<
    HarnessHostFilesOptions,
    "wakes" | "stdio" | "identity" | "rootMetadata" | "posix" | "cwd" | "assetMode"
  >;
  readonly native?: (
    loaded: LoadedHarnessRelease,
  ) => Pick<NodeHarnessProcessInput, "nativeModules" | "loadPackages" | "loadRelease"> &
    Partial<
      Pick<
        NodeHarnessProcessInput,
        | "prepared"
        | "resolvePrepared"
        | "addons"
        | "onChildProcess"
        | "drainChildProcessObservation"
      >
    >;
  readonly machine: (
    identity: SystemIdentity,
  ) => KernelCommandForwarder & { readonly files: MachineFilesPort };
  readonly hydrate?: (input: {
    readonly files: Computer["files"];
    readonly signal: AbortSignal;
    readonly restored: HarnessFilesStoreResult["files"] | undefined;
    readonly loaded: LoadedHarnessRelease;
    readonly threadId: string;
    readonly persistence: ReturnType<typeof createHostStorage>["persistence"];
  }) => Promise<void>;
  readonly observeOutput?: (fd: number, bytes: Uint8Array) => void;
  readonly observeInput?: (bytes: Uint8Array) => void;
  readonly save: (input: {
    readonly threadId: string;
    readonly files: Computer["files"];
    readonly persistence: ReturnType<typeof createHostStorage>["persistence"];
    readonly signal: AbortSignal;
  }) => ReturnType<Computer["save"]>;
  readonly port: Computer["port"];
}

type Configure = Parameters<ClaudeKernelSessionPort["configure"]>[0];

/** Only this local resource owner creates the canonical filesystem and process table. */
export function createClaudeKernelResources(
  input: ClaudeKernelInitialize,
  options: ClaudeKernelLocalOptions,
  signal: AbortSignal,
) {
  const wakes = new KernelWakeRegistry();
  const callbacks: { current: Configure["callbacks"] | undefined } = { current: undefined };
  const stdio = createKernelSessionStdio(
    wakes,
    signal,
    (fd, bytes) => {
      options.observeOutput?.(fd, bytes);
      return callbacks.current?.output(fd, bytes);
    },
    (bytes) => {
      options.observeInput?.(bytes);
      return callbacks.current?.input(bytes);
    },
  );
  let storage: ReturnType<typeof createHostStorage>;
  try {
    storage = createHostStorage(
      { ...options.files, ...input.files, wakes, stdio: stdio.stdio },
      input.threadId,
    );
  } catch (error) {
    wakes.dispose();
    void stdio.dispose();
    throw error;
  }
  const processes = new KernelProcessTable({ wakes });
  const systemIdentity = systemIdentityForThread(input.threadId, input.process.systemIdentity);
  let profile: ReturnType<typeof createComputerMachineProfile> | undefined;
  let commands: Awaited<ReturnType<typeof createKernelComputerHost>> | undefined;
  let loaded: LoadedHarnessRelease | undefined;
  let boot: ReturnType<typeof createBootState> | undefined;
  let prepared = false;
  return {
    storage,
    // The lower view has no global change clock. Its owner brackets machine changes with this
    // epoch; canonical filesystem changes still count even when KernelFileSystem cannot attest all mounts.
    fileRevision: () => ({
      files: storage.persistence.storage.changeGeneration(),
      machine: profile?.metadataEpoch() ?? 0,
    }),
    fileChanges: (since: number) => storage.persistence.storage.changedInodes?.(since),
    stdio,
    processes,
    systemIdentity,
    async configure(config: Configure) {
      if (boot !== undefined || config.threadId !== input.threadId)
        throw new Error("Kernel resources were already configured or changed thread");
      // Restore canonical checkpoint entries before attaching the machine's async lower layer.
      const machine = createComputerMachineProfile({
        filesystem: storage.files,
        threadId: input.threadId,
        machineInventory: input.machineInventory,
        transport: options.machine(systemIdentity),
        signal,
      });
      profile = machine;
      callbacks.current = config.callbacks;
      loaded = { plan: config.loaded.plan, payloads: new Map() };
      const catalog = remoteKernelSeedCatalog(config.catalog, config.source);
      boot = createBootState(storage, catalog, input.threadId);
      commands = await createKernelComputerHost({
        owner: config.owner,
        filesystem: storage.files,
        processes,
        wakes,
        machine: machine.machine,
        hostname: systemIdentity.hostname,
        namespace: (request) =>
          createKernelExecutableNamespace({
            filesystem: request.filesystem,
            signal: request.signal,
            overlay: machine.overlay,
          }),
        home: input.process.identity.homedir,
      });
      return await config.owner.registrations();
    },
    boot() {
      if (boot === undefined) throw new Error("Kernel seed owner is not configured");
      return boot;
    },
    commands() {
      if (commands === undefined) throw new Error("Kernel command owner is not configured");
      return commands;
    },
    loaded() {
      if (loaded === undefined) throw new Error("Kernel release is not configured");
      return loaded;
    },
    async prepare(
      restored: HarnessFilesStoreResult["files"] | undefined,
      callerSignal: AbortSignal,
    ) {
      const preparationSignal = AbortSignal.any([signal, callerSignal]);
      if (prepared) throw new Error("Kernel files were already prepared");
      if (commands === undefined) throw new Error("Kernel command owner is not configured");
      preparationSignal.throwIfAborted();
      if (loaded === undefined) throw new Error("Kernel release is not configured");
      await options.hydrate?.({
        files: storage.files,
        persistence: storage.persistence,
        threadId: input.threadId,
        signal: preparationSignal,
        restored,
        loaded,
      });
      await prepareHydratedRepository({
        files: storage.files,
        commands: commands.isolate,
        signal: preparationSignal,
      });
      preparationSignal.throwIfAborted();
      prepared = true;
    },
    async close() {
      const results = await Promise.allSettled([commands?.close(), processes.dispose()]);
      const stdioClosed = await Promise.allSettled([stdio.dispose()]);
      callbacks.current = undefined;
      try {
        profile?.overlay.dispose();
      } finally {
        try {
          storage.dispose();
        } finally {
          wakes.dispose();
        }
      }
      const failures = [...results, ...stdioClosed].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      const disposed = results[1];
      if (disposed?.status === "fulfilled" && disposed.value?.status !== "ok")
        failures.push(disposed.value);
      if (failures.length > 0)
        throw new AggregateError(failures, "Claude kernel resources could not close");
    },
    save: (signal: AbortSignal) =>
      options.save({
        files: storage.files,
        persistence: storage.persistence,
        threadId: input.threadId,
        signal,
      }),
    port: options.port,
  };
}
