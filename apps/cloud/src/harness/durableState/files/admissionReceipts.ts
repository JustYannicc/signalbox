import * as Schema from "effect/Schema";
import { digest, id, positive } from "../shared.ts";
import type { HarnessFilesStoreCommand } from "./contracts.ts";
import type { HarnessFilesDatabase } from "./types.ts";
import type { State } from "./state.ts";
import { fail } from "./errors.ts";
import { admissionReceiptTable } from "./sqlite.ts";

type AdmissionCommand = Extract<HarnessFilesStoreCommand, { readonly type: "reconcileAdmission" }>;

const Checkpoint = Schema.Struct({ checkpointId: id, manifestSha256: digest });
const Authority = Schema.Struct({ ownerId: id, incarnationId: id, epoch: positive });
const Publisher = Schema.Struct({ generation: positive, facetNonce: id });
const Request = Schema.Struct({
  runId: id,
  authority: Authority,
  publisher: Publisher,
  expectedGeneration: positive,
  evidenceId: id,
  stepId: Schema.NullOr(id),
  outcome: Schema.Literals(["notApplied", "completed"]),
  expectedCheckpoint: Checkpoint,
  checkpoint: Schema.NullOr(Checkpoint),
});
const Source = Schema.Struct({
  authority: Authority,
  publisher: Publisher,
  lifecycle: Schema.Literals([
    "accepting",
    "draining",
    "publishing",
    "published",
    "activation-failed",
  ]),
  checkpoint: Checkpoint,
  activeStepId: Schema.NullOr(id),
  lastCommittedStepId: Schema.NullOr(id),
  lastCommittedFromCheckpoint: Schema.NullOr(Checkpoint),
});
const Resolution = Schema.Struct({
  evidenceId: id,
  stepId: Schema.NullOr(id),
  outcome: Schema.Literals(["notApplied", "completed"]),
  expectedCheckpoint: Checkpoint,
  checkpoint: Checkpoint,
});
const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  request: Request,
  source: Source,
  resolution: Resolution,
});
export type AdmissionReceipt = typeof Receipt.Type;

const decodeReceipt = Schema.decodeUnknownSync(Receipt, { onExcessProperty: "error" });
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const first = (rows: Iterable<Record<string, unknown>>) => rows[Symbol.iterator]().next().value;

function authorityOf(control: AdmissionCommand["control"]) {
  return { ownerId: control.ownerId, incarnationId: control.incarnationId, epoch: control.epoch };
}

function publisherOf(publisher: AdmissionCommand["publisher"]) {
  return { generation: publisher.generation, facetNonce: publisher.facetNonce };
}

function requestOf(runId: string, command: AdmissionCommand) {
  return {
    runId,
    authority: authorityOf(command.control),
    publisher: publisherOf(command.publisher),
    expectedGeneration: command.expectedGeneration,
    evidenceId: command.evidenceId,
    stepId: command.stepId,
    outcome: command.outcome,
    expectedCheckpoint: command.expectedCheckpoint,
    checkpoint: command.checkpoint,
  };
}

export function readAdmissionReceipt(
  database: HarnessFilesDatabase,
  evidenceId: string,
): AdmissionReceipt | null {
  const row = first(
    database.sql.exec(
      `SELECT receipt_json FROM ${admissionReceiptTable} WHERE evidence_id = ?`,
      evidenceId,
    ),
  );
  if (!row) return null;
  try {
    if (typeof row.receipt_json !== "string") throw new Error("Malformed admission receipt.");
    const receipt = decodeReceipt(JSON.parse(row.receipt_json));
    if (
      receipt.request.evidenceId !== evidenceId ||
      receipt.request.expectedGeneration !== receipt.source.publisher.generation ||
      receipt.request.expectedGeneration !== receipt.request.publisher.generation ||
      receipt.request.stepId !== receipt.source.activeStepId ||
      !same(receipt.request.authority, receipt.source.authority) ||
      !same(receipt.request.publisher, receipt.source.publisher) ||
      !same(receipt.request.expectedCheckpoint, receipt.source.checkpoint) ||
      receipt.resolution.evidenceId !== evidenceId ||
      receipt.resolution.stepId !== receipt.request.stepId ||
      receipt.resolution.outcome !== receipt.request.outcome ||
      !same(receipt.resolution.expectedCheckpoint, receipt.request.expectedCheckpoint) ||
      (receipt.request.outcome === "completed"
        ? !same(receipt.resolution.checkpoint, receipt.request.checkpoint)
        : receipt.request.checkpoint !== null ||
          !same(receipt.resolution.checkpoint, receipt.request.expectedCheckpoint))
    )
      throw new Error("Admission receipt identity mismatch.");
    return receipt;
  } catch {
    return fail("CORRUPT");
  }
}

export function admissionReceiptMatches(
  receipt: AdmissionReceipt,
  runId: string,
  command: AdmissionCommand,
) {
  return same(receipt.request, requestOf(runId, command));
}

export function createAdmissionReceipt(
  state: State,
  runId: string,
  command: AdmissionCommand,
  resolution: AdmissionReceipt["resolution"],
): AdmissionReceipt {
  return {
    version: 1,
    request: requestOf(runId, command),
    source: {
      authority: authorityOf(state.control),
      publisher: publisherOf(state.publisher),
      lifecycle: state.lifecycle,
      checkpoint: state.checkpoint,
      activeStepId: state.activeStepId,
      lastCommittedStepId: state.lastCommittedStepId,
      lastCommittedFromCheckpoint: state.lastCommittedFromCheckpoint,
    },
    resolution,
  };
}

export function insertAdmissionReceipt(database: HarnessFilesDatabase, receipt: AdmissionReceipt) {
  database.sql.exec(
    `INSERT INTO ${admissionReceiptTable} (evidence_id, receipt_json) VALUES (?, ?)`,
    receipt.request.evidenceId,
    JSON.stringify(receipt),
  );
}

export function resultWithAdmissionReceipt<T extends { readonly admissionResolution: unknown }>(
  result: T,
  receipt: AdmissionReceipt,
) {
  return { ...result, admissionResolution: receipt.resolution };
}
