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
        void exited.catch(() => undefined);
        return { ...child, exited };
      } catch (error) {
        invalidateMetadata(commandEpoch);
        throw error;
      }
    },
  };
  return { overlay, machine };
}
