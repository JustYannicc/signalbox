import * as Option from "effect/Option";
import type { FilePersistencePorts } from "../kernel/FilePersistencePorts.ts";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandForwarder,
} from "../kernel/KernelCommandForwarder.ts";
import type { BaseLease, DriveRef, RecipeHash } from "./Computer.ts";
import type { Machine, MachineCreateInput } from "./Machine.ts";
import type { MachineCommandJournal, MachineCommandRecord } from "./MachineCommandJournal.ts";
import type { MachineCommandRuntime, MachineWorkspace } from "./MachineWorkspace.ts";
import { MachineCommandAdmission } from "./commands/MachineCommandAdmission.ts";
import { assertMachineOwnership } from "./commands/MachineCommandAttestations.ts";
import { MachineCommandRecovery } from "./commands/MachineCommandRecovery.ts";

export { MachineRevisionError } from "./commands/MachineCommandRecovery.ts";

export interface MachineCommandsOptions {
  readonly drive: DriveRef;
  readonly recipeHash: RecipeHash;
  readonly bases: {
    readonly acquire: () => Promise<Option.Option<BaseLease>>;
    /** Must be idempotent by lease id; recovery can retry after an ambiguous acknowledgement. */
    readonly release: (lease: BaseLease) => Promise<void>;
  };
  readonly machines: Machine;
  readonly workspace: MachineWorkspace;
  readonly runtime: MachineCommandRuntime;
  readonly ports: FilePersistencePorts;
  readonly journal: MachineCommandJournal;
  readonly nextOperationId: () => string;
  readonly coldExpiresAt: () => number;
  /** Cleanup and result commits outlive the caller cancelling its command. */
  readonly recoverySignal: AbortSignal;
}

/** Brackets one VM command and recovers only from its durable journal record. */
export class MachineCommands implements KernelCommandForwarder {
  readonly #options: MachineCommandsOptions;
  readonly #recovery: MachineCommandRecovery;
  readonly #admission = new MachineCommandAdmission();

  constructor(options: MachineCommandsOptions) {
    this.#options = options;
    this.#recovery = new MachineCommandRecovery(options);
  }

  readonly spawn = async (
    command: KernelCommand,
    signal: AbortSignal,
  ): Promise<KernelCommandChild> => {
    signal.throwIfAborted();
    const admittedCommand = captureCommand(command);
    const releaseAdmission = await this.#admission.acquire(signal);
    let handoffAdmission = false;
    let operationId: string | undefined;

    try {
      signal.throwIfAborted();
      await this.#recoverPendingLocked({ allowUnresolvedSafeRows: true });
      signal.throwIfAborted();

      const options = this.#options;
      operationId = options.nextOperationId();
      if (!operationId || options.journal.read(operationId))
        throw new Error("Duplicate machine command identity");

      let record: MachineCommandRecord = { operationId, phase: "checkpoint" };
      const write = async (next: MachineCommandRecord) => {
        await options.journal.write(next);
        record = next;
      };

      await options.journal.write(record);
      try {
        const before = await options.workspace.checkpoint(`${operationId}:before`, signal);
        record = { ...record, before };
        await write(record);
        const base = await options.bases.acquire();
        if (Option.isSome(base)) record = { ...record, base: base.value };
        await write(record);
        if (Option.isSome(base) && base.value.retention !== "until-release") {
          throw new Error("Base lease is not retained until explicit release");
        }

        const createInput: MachineCreateInput = {
          operationId,
          drive: options.drive,
          recipeHash: options.recipeHash,
          base,
          expiresAt: Option.isSome(base) ? base.value.expiresAt : options.coldExpiresAt(),
        };
        record = {
          ...record,
          phase: "create",
          createInput: {
            operationId,
            drive: options.drive,
            recipeHash: options.recipeHash,
            base: Option.isSome(base) ? base.value : null,
            expiresAt: createInput.expiresAt,
          },
        };
        await write(record);

        const machine = await options.machines.create(createInput, signal);
        this.#recovery.rememberMachine(operationId, machine);
        record = {
          ...record,
          phase: "prepare",
          machine: { id: machine.id, generation: machine.generation },
        };
        await write(record);

        const mount = await options.workspace.prepare(
          machine,
          before,
          options.ports.hydration,
          signal,
        );
        this.#recovery.rememberMount(operationId, mount);
        const runtime = await options.runtime.attach({
          operationId,
          machine,
          workspace: mount,
          policy: {
            authorize: async (candidate) => {
              if (!sameCommand(admittedCommand, candidate))
                throw new Error("Command changed after Computer admission");
            },
          },
          signal,
        });
        this.#recovery.rememberRuntime(operationId, runtime);
        assertMachineOwnership(
          { operationId, id: machine.id, generation: machine.generation },
          runtime.owner,
        );
        record = { ...record, phase: "execute" };
        await write(record);

        const child = await runtime.spawn(admittedCommand, signal);
        let settlement: Promise<void> | undefined;
        const settle = () => {
          if (!settlement) {
            settlement = (async () => {
              try {
                await child.dispose();
              } catch (disposeError) {
                try {
                  await this.#recovery.recover(operationId!);
                } catch (recoveryError) {
                  throw recoveryFailure(disposeError, recoveryError);
                }
                throw disposeError;
              }
              await this.#recovery.recover(operationId!);
            })();
          }
          return settlement;
        };
        const exited = child.exited
          .then(
            async (exit) => {
              await settle();
              return exit;
            },
            async (error: unknown) => {
              try {
                await settle();
              } catch (recoveryError) {
                throw recoveryFailure(error, recoveryError);
              }
              throw error;
            },
          )
          .finally(releaseAdmission);
        void exited.catch(() => undefined);
        handoffAdmission = true;
        return {
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          exited,
          signal: child.signal,
          dispose: async () => {
            try {
              await settle();
            } finally {
              releaseAdmission();
            }
          },
        };
      } catch (error) {
        try {
          await this.#recovery.recover(operationId);
        } catch (recoveryError) {
          throw recoveryFailure(error, recoveryError);
        }
        throw error;
      }
    } finally {
      if (!handoffAdmission) releaseAdmission();
    }
  };

  /** Reports unresolved startup rows; spawn only blocks on rows that may still change live files. */
  readonly recoverPending = async (): Promise<void> => {
    const releaseAdmission = await this.#admission.acquire();
    try {
      await this.#recoverPendingLocked();
    } finally {
      releaseAdmission();
    }
  };

  /** Reconcile one pending row. This path never spawns a command or creates a machine. */
  readonly recover = async (operationId: string): Promise<void> => {
    const releaseAdmission = await this.#admission.acquire();
    try {
      await this.#recovery.recover(operationId);
    } finally {
      releaseAdmission();
    }
  };

  async #recoverPendingLocked(options: { readonly allowUnresolvedSafeRows?: boolean } = {}) {
    const unresolved: Array<{ readonly operationId: string; readonly error: unknown }> = [];
    for (const record of this.#options.journal.pending()) {
      try {
        await this.#recovery.recover(record.operationId);
      } catch (error) {
        if (options.allowUnresolvedSafeRows && canLeavePending(record.phase)) continue;
        unresolved.push({ operationId: record.operationId, error });
      }
    }
    if (unresolved.length === 1) throw unresolved[0]!.error;
    if (unresolved.length > 1) {
      throw new AggregateError(
        unresolved.map(({ error }) => error),
        `Pending machine commands remain unresolved: ${unresolved.map(({ operationId }) => operationId).join(", ")}`,
      );
    }
  }
}

function canLeavePending(phase: MachineCommandRecord["phase"]) {
  return phase === "checkpoint" || phase === "create" || phase === "prepare" || phase === "delete";
}

function sameCommand(left: KernelCommand, right: KernelCommand) {
  const entries = (env: KernelCommand["env"]) =>
    Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  return (
    left.executable === right.executable &&
    left.cwd === right.cwd &&
    JSON.stringify(left.argv) === JSON.stringify(right.argv) &&
    JSON.stringify(entries(left.env)) === JSON.stringify(entries(right.env))
  );
}

function captureCommand(command: KernelCommand): KernelCommand {
  return Object.freeze({
    executable: command.executable,
    argv: Object.freeze(command.argv.slice()),
    cwd: command.cwd,
    env: Object.freeze({ ...command.env }),
  });
}

function recoveryFailure(primary: unknown, recovery: unknown) {
  return new AggregateError(
    [primary, recovery],
    "Command failed and its workspace requires recovery",
    { cause: primary },
  );
}
