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
import { assertMachineOwnership } from "./commands/MachineCommandAttestations.ts";
import { MachineCommandRecovery } from "./commands/MachineCommandRecovery.ts";

export { MachineRevisionError } from "./commands/MachineCommandRecovery.ts";

export interface MachineCommandsOptions {
  readonly drive: DriveRef;
  readonly recipeHash: RecipeHash;
  readonly bases: {
    readonly acquire: () => Promise<Option.Option<BaseLease>>;
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

  constructor(options: MachineCommandsOptions) {
    this.#options = options;
    this.#recovery = new MachineCommandRecovery(options);
  }

  readonly spawn = async (
    command: KernelCommand,
    signal: AbortSignal,
  ): Promise<KernelCommandChild> => {
    const options = this.#options;
    signal.throwIfAborted();
    const admittedCommand = captureCommand(command);
    const operationId = options.nextOperationId();
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
      const settle = async () => {
        try {
          await child.dispose();
        } catch (disposeError) {
          try {
            await this.recover(operationId);
          } catch (recoveryError) {
            throw recoveryFailure(disposeError, recoveryError);
          }
          throw disposeError;
        }
        await this.recover(operationId);
      };
      const exited = child.exited.then(async (exit) => {
        await settle();
        return exit;
      });
      void exited.catch(() => undefined);
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        exited,
        signal: child.signal,
        dispose: settle,
      };
    } catch (error) {
      try {
        await this.recover(operationId);
      } catch (recoveryError) {
        throw recoveryFailure(error, recoveryError);
      }
      throw error;
    }
  };

  /** Reconcile one pending row. This path never spawns a command or creates a machine. */
  recover(operationId: string): Promise<void> {
    return this.#recovery.recover(operationId);
  }
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
