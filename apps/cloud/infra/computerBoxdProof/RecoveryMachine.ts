import {
  MachineCommands,
  type MachineCommandsOptions,
} from "../../src/computer/MachineCommands.ts";
import type { Machine } from "../../src/computer/Machine.ts";
import type {
  MachineCommandRuntime,
  MachineWorkspace,
} from "../../src/computer/MachineWorkspace.ts";

type RecoveryMachineOptions = Pick<
  MachineCommandsOptions,
  "drive" | "recipeHash" | "journal" | "recoverySignal"
> & {
  readonly bases: Pick<MachineCommandsOptions["bases"], "release">;
  readonly machines: Pick<Machine, "reconcile">;
  readonly workspace: Pick<MachineWorkspace, "resume" | "apply">;
  readonly runtime: Pick<MachineCommandRuntime, "rebind">;
  readonly hydration: MachineCommandsOptions["ports"]["hydration"];
};

/** Recovery gets only reconciliation and settlement ports; command admission stays closed. */
export function createRecoveryMachine(options: RecoveryMachineOptions) {
  return new MachineCommands(createRecoveryMachineOptions(options));
}

/** Kept private to the proof module so the deny boundary can be exercised directly. */
export function createRecoveryMachineOptions(
  options: RecoveryMachineOptions,
): MachineCommandsOptions {
  return {
    drive: options.drive,
    recipeHash: options.recipeHash,
    bases: {
      acquire: async () => {
        throw new Error("Recovery cannot acquire a Base");
      },
      release: options.bases.release,
    },
    machines: {
      create: async () => {
        throw new Error("Recovery cannot create a machine");
      },
      reconcile: (input, signal) => options.machines.reconcile(input, signal),
    },
    workspace: {
      checkpoint: async () => {
        throw new Error("Recovery cannot checkpoint a command");
      },
      prepare: async () => {
        throw new Error("Recovery cannot prepare another workspace");
      },
      ...(options.workspace.resume ? { resume: options.workspace.resume } : {}),
      apply: options.workspace.apply,
    },
    runtime: {
      attach: async () => {
        throw new Error("Recovery cannot attach a command runtime");
      },
      rebind: (owner) => {
        if (!options.runtime.rebind) throw new Error("Recovery runtime cannot attest ownership");
        return options.runtime.rebind(owner);
      },
    },
    ports: {
      hydration: options.hydration,
      commits: {
        commit: async () => {
          throw new Error("Apply recovery cannot recommit the command");
        },
      },
    },
    journal: options.journal,
    nextOperationId: () => {
      throw new Error("Recovery cannot allocate a command identity");
    },
    coldExpiresAt: () => {
      throw new Error("Recovery cannot allocate a cold machine");
    },
    recoverySignal: options.recoverySignal,
  };
}
