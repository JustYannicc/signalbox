import { KernelFileSystemUnavailable } from "../kernel/KernelLowerFileSystem.ts";
import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type { KernelCommandForwarder } from "../kernel/KernelCommandForwarder.ts";
import type { MachineProgramInventory } from "./MachineProgramInventory.ts";
import type { MachineFilesPort } from "./MachineFilesPort.ts";
import { createComputerMachineFileSystem } from "./ComputerMachineFileSystem.ts";

/** The existing kernel overlay and machine revision bracket remain one authority. */
export function createComputerMachineProfile(options: {
  readonly filesystem: KernelFileSystem;
  readonly threadId: string;
  readonly machineInventory: MachineProgramInventory;
  readonly transport: KernelCommandForwarder & { readonly files: MachineFilesPort };
  readonly signal: AbortSignal;
  /** Counts and durations only; a machine command can keep the CLI's view re-indexing. */
  readonly trace?: (event: {
    readonly kind: "machine-command";
    readonly phase: "start" | "exit";
    readonly running: number;
    readonly changes: number;
    readonly durationMs?: number;
  }) => void;
}) {
  const signal = options.signal;
  const transport = options.transport;
  const overlay = options.filesystem.installLowerFileSystem(
    createComputerMachineFileSystem({
      inventory: options.machineInventory,
      threadId: options.threadId,
      files: transport.files,
      signal,
    }),
  );
  const metadataRefreshPaths = [
    ...options.machineInventory.entries
      .filter(({ type }) => type === "directory" || type === "symlink")
      .map(({ path }) => path),
    // Excluded roots are live machine state, not represented by the image inventory.
    ...options.machineInventory.excludedRoots,
  ];
  let metadataEpoch = 0;
  // `metadataEpoch` orders refreshes between commands. Readers of machine changes need a counter
  // that also moves once a command's exit refresh lands, and to know when one is still running.
  let changes = 0;
  let running = 0;
  const begin = () => {
    running++;
    changes++;
    const started = performance.now();
    options.trace?.({ kind: "machine-command", phase: "start", running, changes });
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      running--;
      changes++;
      options.trace?.({
        kind: "machine-command",
        phase: "exit",
        running,
        changes,
        durationMs: Math.round(performance.now() - started),
      });
    };
  };
  const invalidateMetadata = (epoch: number) => {
    if (epoch === metadataEpoch) overlay.invalidate();
  };
  const refreshMetadata = async (
    generation: number,
    callerSignal: AbortSignal,
    commandEpoch: number,
  ) => {
    const refreshSignal = AbortSignal.any([signal, callerSignal]);
    try {
      refreshSignal.throwIfAborted();
      if (commandEpoch !== metadataEpoch)
        throw new KernelFileSystemUnavailable("Machine metadata refresh was superseded");
      const current = transport.files.current();
      if (current.generation !== generation || current.pristine)
        throw new KernelFileSystemUnavailable("Machine generation changed before metadata refresh");
      await overlay.refresh(metadataRefreshPaths, refreshSignal);
      refreshSignal.throwIfAborted();
      if (commandEpoch !== metadataEpoch)
        throw new KernelFileSystemUnavailable("Machine metadata refresh was superseded");
      const refreshed = transport.files.current();
      if (refreshed.generation !== generation || refreshed.pristine)
        throw new KernelFileSystemUnavailable("Machine generation changed during metadata refresh");
    } catch (error) {
      invalidateMetadata(commandEpoch);
      throw error;
    }
  };
  const machine: KernelCommandForwarder = {
    async spawn(command, callerSignal) {
      const commandEpoch = ++metadataEpoch;
      const settle = begin();
      overlay.invalidate();
      try {
        const previousGeneration = transport.files.current().generation;
        if (previousGeneration !== null) await transport.files.markExecuted(previousGeneration);
        const child = await transport.spawn(command, callerSignal);
        const generation = child.generation ?? previousGeneration;
        const exited = child.exited.then(
          async (result) => {
            if (generation === null) {
              invalidateMetadata(commandEpoch);
              throw new KernelFileSystemUnavailable(
                "Machine execution has no attested generation for metadata refresh",
              );
            }
            await refreshMetadata(generation, callerSignal, commandEpoch);
            return result;
          },
          (error: unknown) => {
            invalidateMetadata(commandEpoch);
            throw error;
          },
        );
        const settled = exited.finally(settle);
        void settled.catch(() => undefined);
        return { ...child, exited: settled };
      } catch (error) {
        invalidateMetadata(commandEpoch);
        settle();
        throw error;
      }
    },
  };
  return {
    overlay,
    machine,
    metadataEpoch: () => metadataEpoch,
    machineChanges: () => ({ changes, running }),
  };
}
