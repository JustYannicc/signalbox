import * as Option from "effect/Option";
import type { FilePersistencePorts, ForkCommit } from "../../kernel/FilePersistencePorts.ts";
import type { BaseLease, DriveRef, RecipeHash } from "../Computer.ts";
import type { Machine, MachineCreateInput, MachineHandle } from "../Machine.ts";
import type { MachineCommandJournal, MachineCommandRecord } from "../MachineCommandJournal.ts";
import type {
  MachineCommandRuntime,
  MachineRuntimeSettlement,
  MachineWorkspace,
  MachineWorkspaceMount,
} from "../MachineWorkspace.ts";
import {
  assertMachineAbsent,
  assertMachineClosed,
  assertMachineOwnership,
  assertMachineWorkspaceOwnership,
} from "./MachineCommandAttestations.ts";

interface MachineCommandRecoveryOptions {
  readonly bases: { readonly release: (lease: BaseLease) => Promise<void> };
  readonly machines: Machine;
  readonly workspace: MachineWorkspace;
  readonly runtime: MachineCommandRuntime;
  readonly ports: FilePersistencePorts;
  readonly journal: MachineCommandJournal;
  readonly recoverySignal: AbortSignal;
}

interface RecoveryResources {
  machine?: MachineHandle;
  runtime?: MachineRuntimeSettlement;
  mount?: MachineWorkspaceMount;
}

/** Reconciles pending journal rows without replaying machine creation or commands. */
export class MachineCommandRecovery {
  readonly #options: MachineCommandRecoveryOptions;
  readonly #resources = new Map<string, RecoveryResources>();
  readonly #recovering = new Map<string, Promise<void>>();

  constructor(options: MachineCommandRecoveryOptions) {
    this.#options = options;
  }

  rememberMachine(operationId: string, machine: MachineHandle) {
    this.#resourcesFor(operationId).machine = machine;
  }

  rememberRuntime(operationId: string, runtime: MachineRuntimeSettlement) {
    this.#resourcesFor(operationId).runtime = runtime;
  }

  rememberMount(operationId: string, mount: MachineWorkspaceMount) {
    this.#resourcesFor(operationId).mount = mount;
  }

  recover(operationId: string): Promise<void> {
    const existing = this.#recovering.get(operationId);
    if (existing) return existing;
    const recovery = Promise.resolve().then(() => this.#recoverRecord(operationId));
    this.#recovering.set(operationId, recovery);
    return recovery.finally(() => {
      if (this.#recovering.get(operationId) === recovery) this.#recovering.delete(operationId);
    });
  }

  async #recoverRecord(operationId: string): Promise<void> {
    const options = this.#options;
    let record = options.journal.read(operationId);
    if (!record) throw new Error("Unknown pending machine command");
    if (record.phase === "complete") return;

    const write = async (next: MachineCommandRecord) => {
      await options.journal.write(next);
      record = next;
    };
    if (record.phase === "checkpoint") {
      if (record.base) await options.bases.release(record.base);
      await write({ ...record, phase: "complete" });
      this.#resources.delete(operationId);
      return;
    }
    if (!record.createInput)
      throw new Error("Pending machine command has no persisted create input");

    const createInput = restoreCreateInput(record.createInput);
    const reconciled = await options.machines.reconcile(createInput, options.recoverySignal);
    const resources = this.#resourcesFor(operationId);

    if (reconciled.status === "unknown")
      throw new Error("Machine ownership is still unknown; keeping its journal and Base lease");

    if (reconciled.status === "absent") {
      assertMachineAbsent(operationId, reconciled.absence);
      if (record.phase === "execute" || record.phase === "commit" || record.phase === "apply") {
        throw new Error("Machine disappeared before its command workspace was applied");
      }
      if (record.phase !== "delete") await write({ ...record, phase: "delete" });
      await reconciled.releaseReservation();
      await disposeRuntime(resources);
      await this.#releaseBase(record);
      await write({ ...record, phase: "complete" });
      this.#resources.delete(operationId);
      return;
    }

    const machine = reconciled.handle;
    assertMachineOwnership(
      { operationId, id: machine.id, generation: machine.generation },
      reconciled.ownership,
    );
    if (
      record.machine &&
      (record.machine.id !== machine.id || record.machine.generation !== machine.generation)
    ) {
      throw new Error("Reconciled machine does not match the journaled provider identity");
    }
    resources.machine = machine;
    if (!record.machine)
      await write({ ...record, machine: { id: machine.id, generation: machine.generation } });

    if (record.phase === "delete") {
      await machine.release();
      await disposeRuntime(resources);
      await this.#releaseBase(record);
      await write({ ...record, phase: "complete" });
      this.#resources.delete(operationId);
      return;
    }

    if (record.phase === "create" || record.phase === "prepare") {
      await write({ ...record, phase: "delete" });
      await disposeRuntime(resources);
      await machine.release();
      await this.#releaseBase(record);
      await write({ ...record, phase: "complete" });
      this.#resources.delete(operationId);
      return;
    }

    if (record.phase !== "execute" && record.phase !== "commit" && record.phase !== "apply")
      throw new Error(`Unsupported machine recovery phase: ${record.phase}`);

    const runtime =
      resources.runtime ??
      (await options.runtime.rebind?.({
        operationId,
        machine,
        signal: options.recoverySignal,
      }));
    if (!runtime) throw new Error("Machine runtime cannot rebind to attest command closure");
    resources.runtime = runtime;
    assertMachineOwnership(
      { operationId, id: machine.id, generation: machine.generation },
      runtime.owner,
    );
    const closure = await runtime.quiesce(options.recoverySignal);
    assertMachineClosed({ operationId, id: machine.id, generation: machine.generation }, closure);

    const settledPhase = record.phase === "apply" ? "apply" : "commit";
    await write({ ...record, phase: settledPhase, settled: closure });
    await runtime.dispose();
    delete resources.runtime;

    let mount = resources.mount;
    if (!mount) {
      if (!options.workspace.resume)
        throw new Error("Machine workspace cannot resume after facet restart");
      const resumed = await options.workspace.resume({
        operationId,
        machine,
        before: requireBefore(record),
        signal: options.recoverySignal,
      });
      assertMachineWorkspaceOwnership(
        {
          operationId,
          id: machine.id,
          generation: machine.generation,
          before: requireBefore(record),
        },
        resumed.ownership,
      );
      mount = resumed.mount;
      resources.mount = mount;
    }

    const before = requireBefore(record);
    let after = record.after;
    if (!after && record.phase === "apply")
      throw new Error("Applying a machine revision requires its committed Drive revision");
    const changedInodes = await mount.changes(options.recoverySignal);
    if (!after) {
      const result = await options.ports.commits.commit({
        at: before,
        turnId: `${operationId}:after`,
        changedInodes,
        signal: options.recoverySignal,
      });
      if (result.status === "error") throw new MachineRevisionError(result.error.code);
      after = { ...before, commit: result.value.commit };
      await write({ ...record, phase: "commit", after, settled: closure });
    }

    if (record.phase !== "apply")
      await write({ ...record, phase: "apply", after, settled: closure });
    else if (record.settled !== closure)
      await write({ ...record, phase: "apply", after, settled: closure });
    await options.workspace.apply({
      before,
      after,
      changedInodes,
      hydration: options.ports.hydration,
      signal: options.recoverySignal,
    });

    await write({ ...record, phase: "delete", after, settled: closure });
    await machine.release();
    await disposeRuntime(resources);
    await this.#releaseBase(record);
    await write({ ...record, phase: "complete" });
    this.#resources.delete(operationId);
  }

  #resourcesFor(operationId: string) {
    let resources = this.#resources.get(operationId);
    if (!resources) {
      resources = {};
      this.#resources.set(operationId, resources);
    }
    return resources;
  }

  async #releaseBase(record: MachineCommandRecord) {
    const base = record.createInput?.base;
    if (base) await this.#options.bases.release(base);
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

function requireBefore(record: MachineCommandRecord): ForkCommit {
  if (!record.before) throw new Error("Pending machine command has no checkpoint revision");
  return record.before;
}

function restoreCreateInput(
  input: NonNullable<MachineCommandRecord["createInput"]>,
): MachineCreateInput {
  return {
    operationId: input.operationId,
    drive: input.drive as DriveRef,
    recipeHash: input.recipeHash as RecipeHash,
    base: input.base ? Option.some(input.base) : Option.none(),
    expiresAt: input.expiresAt,
  };
}

async function disposeRuntime(resources: RecoveryResources) {
  if (!resources.runtime) return;
  await resources.runtime.dispose();
  delete resources.runtime;
}
