// @effect-diagnostics globalDate:off - owned proof alarms and provider deadlines use wall time.
import * as Brand from "effect/Brand";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { SignalboxDriveId } from "@t3tools/contracts/signalboxDrives";
import type { RecipeHash } from "../../src/computer/Computer.ts";
import { makeBoxdMachines, type boxdMachineClient } from "../../src/computer/BoxdMachines.ts";
import { SqliteBoxdReservations } from "../../src/computer/SqliteBoxdReservations.ts";
import { SqliteMachineCommandJournal } from "../../src/computer/SqliteMachineCommandJournal.ts";
import type { MachineCreateInput } from "../../src/computer/Machine.ts";

const outcome = Schema.Literals(["pending", "passed", "failed", "skipped"]);
const state = Schema.Struct({
  status: Schema.Literals(["pending", "running", "passed", "failed"]),
  vmNames: Schema.Array(Schema.String),
  checks: Schema.Record(Schema.String, outcome),
  cleanupConfirmed: Schema.Boolean,
  sourceExpiresAt: Schema.optionalKey(Schema.Number),
  sourceCommit: Schema.optionalKey(Schema.String),
  runnerSha256: Schema.optionalKey(Schema.String),
});
export type ProofState = typeof state.Type;
export const decodeProofState = Schema.decodeUnknownSync(state);

/** Resource accounting for this disposable proof. It is not a production Bases lifecycle. */
export class ProofOwnership {
  readonly storage: DurableObjectStorage;
  readonly owner: string;
  readonly client: ReturnType<typeof boxdMachineClient>;
  readonly drive;
  readonly recipeHash = Brand.nominal<RecipeHash>()("proof-only-recipe-v1");
  readonly sourceOperation;
  readonly commandOperation;
  readonly journal;
  readonly source;
  readonly commands;

  constructor(
    storage: DurableObjectStorage,
    owner: string,
    client: ReturnType<typeof boxdMachineClient>,
  ) {
    this.storage = storage;
    this.owner = owner;
    this.client = client;
    this.drive = SignalboxDriveId.make(owner);
    this.sourceOperation = `${owner}-source`;
    this.commandOperation = `${owner}-command-1`;
    this.journal = new SqliteMachineCommandJournal(storage);
    const config = { org: "", image: "", vcpu: 1, memory: "4G" };
    this.source = makeBoxdMachines(
      client,
      new SqliteBoxdReservations(storage, () => this.sourceOperation),
      config,
    );
    this.commands = makeBoxdMachines(
      client,
      new SqliteBoxdReservations(storage, () => this.commandOperation),
      config,
    );
  }

  initial(): ProofState {
    return {
      status: "pending",
      vmNames: [`computer-${this.sourceOperation}`, `computer-${this.commandOperation}`],
      checks: {},
      cleanupConfirmed: false,
    };
  }

  async read(): Promise<ProofState> {
    const saved = await this.storage.get("proof-state");
    return saved === undefined ? this.initial() : decodeProofState(saved);
  }

  async save(value: ProofState) {
    await this.storage.put("proof-state", decodeProofState(value));
  }

  async check(name: string, value: typeof outcome.Type) {
    const current = await this.read();
    await this.save({ ...current, checks: { ...current.checks, [name]: value } });
  }

  sourceInput(expiresAt: number): MachineCreateInput {
    return {
      operationId: this.sourceOperation,
      drive: this.drive,
      recipeHash: this.recipeHash,
      base: Option.none(),
      expiresAt,
    };
  }

  async prepareSourceInput() {
    const current = await this.read();
    if (current.sourceExpiresAt !== undefined)
      throw new Error("The proof source was already dispatched");
    const expiresAt = Date.now() + 600_000;
    // Arm recovery and persist its exact allocation input before provider dispatch.
    await this.storage.setAlarm(Date.now() + 600_000);
    await this.save({ ...current, sourceExpiresAt: expiresAt });
    return this.sourceInput(expiresAt);
  }

  async verifySource(id: string) {
    const machine = await this.client.machines.get(`computer-${this.sourceOperation}`);
    if (
      machine.id !== id ||
      machine.name !== `computer-${this.sourceOperation}` ||
      machine.status !== "running" ||
      machine.shared ||
      !machine.networking.isolated ||
      machine.networking.networks.length !== 0 ||
      machine.deleteAt !== null ||
      machine.idle.destroyAfter !== 0
    ) {
      throw new Error("The proof Base source is no longer held by its owner");
    }
  }

  /** A failed proof may discard its test workspace. It never replays a command during cleanup. */
  async cleanup(signal: AbortSignal) {
    let confirmed = true;
    const record = this.journal.read(this.commandOperation);
    if (record?.createInput) {
      const input = record.createInput;
      const result = await this.commands.reconcile(
        {
          operationId: input.operationId,
          drive: this.drive,
          recipeHash: this.recipeHash,
          base: input.base === null ? Option.none() : Option.some(input.base),
          expiresAt: input.expiresAt,
        },
        signal,
      );
      if (result.status === "owned") await result.handle.release();
      else if (result.status === "absent") await result.releaseReservation();
      else confirmed = false;
    }
    // A source outlives every fork lease, including an ambiguous fork dispatch.
    if (confirmed) {
      const current = await this.read();
      if (current.sourceExpiresAt !== undefined) {
        const result = await this.source.reconcile(
          this.sourceInput(current.sourceExpiresAt),
          signal,
        );
        if (result.status === "owned") await result.handle.release();
        else if (result.status === "absent") await result.releaseReservation();
        else confirmed = false;
      }
    }
    const current = await this.read();
    await this.save({
      ...current,
      cleanupConfirmed: confirmed,
      checks: { ...current.checks, providerCleanup: confirmed ? "passed" : "failed" },
    });
    if (confirmed) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(Date.now() + 30_000);
    return confirmed;
  }
}
