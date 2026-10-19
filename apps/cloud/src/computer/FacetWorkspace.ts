import {
  createKernelRevisionWorkspace,
  KernelRevisionWorkspaceError,
  type KernelRevisionWorkspaceOptions,
} from "../kernel/KernelRevisionWorkspace.ts";
import type { MachineHandle } from "./Machine.ts";
import type { MachineWorkspace } from "./MachineWorkspace.ts";

export { KernelRevisionWorkspaceError as FacetWorkspaceError };

export interface FacetWorkspaceOptions extends KernelRevisionWorkspaceOptions {
  /** Machine mount creation stays with the caller that owns that provider. */
  readonly mount: MachineWorkspace["prepare"];
  /** Reattachment stays with the same owner that creates the machine mount. */
  readonly resume?: MachineWorkspace["resume"];
}

/** Composes kernel revision handling with the machine mount owned by the command runner. */
export function createFacetWorkspace(options: FacetWorkspaceOptions): MachineWorkspace {
  const revisions = createKernelRevisionWorkspace(options);
  return {
    checkpoint: revisions.checkpoint,
    prepare: (machine: MachineHandle, at, hydration, signal) =>
      options.mount(machine, at, hydration, signal),
    ...(options.resume
      ? {
          resume: async (input: Parameters<NonNullable<MachineWorkspace["resume"]>>[0]) => {
            if (
              !input.operationId ||
              !input.machine.id ||
              !Number.isSafeInteger(input.machine.generation) ||
              input.machine.generation < 1
            ) {
              throw new KernelRevisionWorkspaceError(
                "EINVAL",
                "Invalid machine workspace ownership",
              );
            }
            const resumed = await options.resume!(input);
            const { ownership } = resumed;
            if (
              ownership.operationId !== input.operationId ||
              ownership.machineId !== input.machine.id ||
              ownership.generation !== input.machine.generation ||
              ownership.before.repository !== input.before.repository ||
              ownership.before.fork !== input.before.fork ||
              ownership.before.commit !== input.before.commit
            ) {
              throw new KernelRevisionWorkspaceError(
                "ESTALE",
                "The resumed machine workspace belongs to another operation or revision",
              );
            }
            return {
              mount: resumed.mount,
              ownership: Object.freeze({
                operationId: input.operationId,
                machineId: input.machine.id,
                generation: input.machine.generation,
                before: { ...input.before },
              }),
            };
          },
        }
      : {}),
    apply: revisions.apply,
  };
}
