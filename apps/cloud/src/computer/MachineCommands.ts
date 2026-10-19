import * as Option from "effect/Option";
import type { FilePersistencePorts, ForkCommit } from "../kernel/FilePersistencePorts.ts";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandForwarder,
} from "../kernel/KernelCommandForwarder.ts";
import type { BaseLease, DriveRef, RecipeHash } from "./Computer.ts";
import { MachineCreationError, type Machine } from "./Machine.ts";
import type { MachineCommandJournal, MachineCommandRecord } from "./MachineCommandJournal.ts";
import type { MachineCommandRuntime, MachineWorkspace } from "./MachineWorkspace.ts";

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

/** Owns one VM bracket per selected command, retaining failed cleanup for explicit recovery. */
export class MachineCommands implements KernelCommandForwarder {
  readonly #options: MachineCommandsOptions;
  readonly #pending = new Map<string, () => Promise<void>>();

  constructor(options: MachineCommandsOptions) {
    this.#options = options;
  }

  readonly spawn = async (
    command: KernelCommand,
    signal: AbortSignal,
  ): Promise<KernelCommandChild> => {
    const options = this.#options;
    signal.throwIfAborted();
    const admittedCommand = captureCommand(command);
    const operationId = options.nextOperationId();
    if (!operationId || this.#pending.has(operationId))
      throw new Error("Duplicate machine command identity");
    let record: MachineCommandRecord = { operationId, phase: "checkpoint" };
    const write = async (phase: MachineCommandRecord["phase"]) => {
      record = { ...record, phase };
      await options.journal.write(record);
    };
    await write("checkpoint");
    const before = await options.workspace.checkpoint(`${operationId}:before`, signal);
    record = { ...record, before };
    const base = await options.bases.acquire();
    if (Option.isSome(base)) record = { ...record, base: base.value };
    let machine: Awaited<ReturnType<Machine["create"]>> | undefined;
    let runtime: Awaited<ReturnType<MachineCommandRuntime["attach"]>> | undefined;
    let mount: Awaited<ReturnType<MachineWorkspace["prepare"]>> | undefined;
    let after: ForkCommit | undefined;
    let committedChanges: Awaited<ReturnType<NonNullable<typeof mount>["changes"]>> | undefined;
    let applied = false;
    let deleted = false;
    let completed = false;
    let baseReleased = false;
    let creationFailure: { readonly error: unknown } | undefined;
    let creationInput: Parameters<Machine["create"]>[0] | undefined;
    let cleanup: Promise<void> | undefined;
    const finish = (): Promise<void> => {
      cleanup ??= (async () => {
        if (completed) return;
        if (creationFailure) {
          const error = creationFailure.error;
          if (!(error instanceof MachineCreationError) || error.disposition !== "not_created") {
            if (!creationInput) throw error;
            machine = await options.machines.create(creationInput, options.recoverySignal);
            record = { ...record, machine: { id: machine.id, generation: machine.generation } };
          }
          creationFailure = undefined;
        }
        if (runtime) await runtime.dispose();
        if (mount && !applied) {
          if (!after) {
            await write("commit");
            committedChanges ??= await mount.changes(options.recoverySignal);
            const result = await options.ports.commits.commit({
              at: before,
              turnId: `${operationId}:after`,
              changedInodes: committedChanges,
              signal: options.recoverySignal,
            });
            if (result.status === "error") throw new MachineRevisionError(result.error.code);
            after = { ...before, commit: result.value.commit };
            record = { ...record, after };
          }
          await write("apply");
          await options.workspace.apply({
            before,
            after,
            changedInodes: committedChanges ?? [],
            hydration: options.ports.hydration,
            signal: options.recoverySignal,
          });
          applied = true;
        }
        await write("delete");
        if (machine && !deleted) {
          await machine.release();
          deleted = true;
        }
        if (Option.isSome(base) && !baseReleased) {
          await options.bases.release(base.value);
          baseReleased = true;
        }
        await write("complete");
        completed = true;
        this.#pending.delete(operationId);
      })().catch((error: unknown) => {
        cleanup = undefined;
        throw error;
      });
      return cleanup;
    };
    this.#pending.set(operationId, finish);
    try {
      await write("create");
      signal.throwIfAborted();
      creationInput = {
        operationId,
        drive: options.drive,
        recipeHash: options.recipeHash,
        base,
        expiresAt: Option.isSome(base) ? base.value.expiresAt : options.coldExpiresAt(),
      };
      try {
        machine = await options.machines.create(creationInput, signal);
      } catch (error) {
        creationFailure = { error };
        throw error;
      }
      record = { ...record, machine: { id: machine.id, generation: machine.generation } };
      await write("prepare");
      mount = await options.workspace.prepare(machine, before, options.ports.hydration, signal);
      runtime = await options.runtime.attach({
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
      await write("execute");
      const child = await runtime.spawn(admittedCommand, signal);
      const exited = child.exited.then(async (exit) => {
        await child.dispose();
        await finish();
        return exit;
      });
      void exited.catch(() => undefined);
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        exited,
        signal: child.signal,
        dispose: async () => {
          await child.dispose();
          await finish();
        },
      };
    } catch (error) {
      try {
        await finish();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Command failed and its workspace requires recovery",
        );
      }
      throw error;
    }
  };

  async recover(operationId: string): Promise<void> {
    const finish = this.#pending.get(operationId);
    if (!finish) throw new Error("Unknown pending machine command");
    await finish();
  }
}

export class MachineRevisionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("Command workspace revision could not be committed");
    this.name = "MachineRevisionError";
    this.code = code;
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
