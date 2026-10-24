import * as Schema from "effect/Schema";
import { digest, HarnessDurableStateAdmissionBinding, id, positive } from "../shared.ts";
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
const Resolution = Schema.Struct({
  evidenceId: id,
  stepId: Schema.NullOr(id),
  outcome: Schema.Literals(["notApplied", "completed"]),
  expectedCheckpoint: Checkpoint,
  checkpoint: Checkpoint,
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
  kind: Schema.optional(Schema.Literal("legacyResolution")),
  legacyBinding: Schema.optional(HarnessDurableStateAdmissionBinding),
  legacyResolution: Schema.optional(Resolution),
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

function sourceOf(state: State): AdmissionReceipt["source"] {
  return {
    authority: authorityOf(state.control),
    publisher: publisherOf(state.publisher),
    lifecycle: state.lifecycle,
    checkpoint: state.checkpoint,
    activeStepId: state.activeStepId,
    lastCommittedStepId: state.lastCommittedStepId,
    lastCommittedFromCheckpoint: state.lastCommittedFromCheckpoint,
  };
}

function bindingMatchesRequest(
  binding: HarnessDurableStateAdmissionBinding,
  request: AdmissionReceipt["request"],
) {
  return (
    binding.runId === request.runId &&
    binding.evidenceId === request.evidenceId &&
    same(binding.authority, request.authority) &&
    binding.expectedGeneration === request.expectedGeneration &&
    binding.outcome === request.outcome &&
    same(binding.checkpoint, request.checkpoint) &&
    same(binding.source.authority, binding.authority) &&
    binding.source.generation === request.publisher.generation &&
    binding.source.facetNonce === request.publisher.facetNonce &&
    binding.source.generation === request.expectedGeneration &&
    same(binding.source.checkpoint, request.expectedCheckpoint) &&
    binding.source.admittedStepId === request.stepId
  );
}

function resultMatchesRequest(
  request: AdmissionReceipt["request"],
  resolution: AdmissionReceipt["resolution"],
) {
  return (
    resolution.evidenceId === request.evidenceId &&
    resolution.stepId === request.stepId &&
    resolution.outcome === request.outcome &&
    same(resolution.expectedCheckpoint, request.expectedCheckpoint) &&
    (request.outcome === "completed"
      ? request.checkpoint !== null && same(resolution.checkpoint, request.checkpoint)
      : request.checkpoint === null && same(resolution.checkpoint, request.expectedCheckpoint))
  );
}

function currentSourceMatchesRequest(
  source: AdmissionReceipt["source"],
  request: AdmissionReceipt["request"],
) {
  if (
    source.kind !== undefined ||
    source.legacyBinding !== undefined ||
    source.legacyResolution !== undefined ||
    !same(request.authority, source.authority) ||
    !same(request.publisher, source.publisher) ||
    request.expectedGeneration !== source.publisher.generation
  )
    return false;

  if (request.outcome === "notApplied")
    return (
      request.checkpoint === null &&
      same(source.checkpoint, request.expectedCheckpoint) &&
      (source.activeStepId === request.stepId ||
        (source.activeStepId === null &&
          (request.stepId === null || source.lastCommittedStepId !== request.stepId)))
    );

  if (request.checkpoint === null || !same(source.checkpoint, request.checkpoint)) return false;
  if (source.activeStepId !== null) return false;
  if (request.stepId === null) return same(request.expectedCheckpoint, request.checkpoint);
  return (
    source.lastCommittedStepId === request.stepId &&
    same(source.lastCommittedFromCheckpoint, request.expectedCheckpoint) &&
    source.checkpoint.checkpointId !== request.expectedCheckpoint.checkpointId
  );
}

function legacySourceMatchesRequest(receipt: AdmissionReceipt) {
  const { request, source, resolution } = receipt;
  const binding = source.legacyBinding;
  if (
    source.kind !== "legacyResolution" ||
    !binding ||
    !source.legacyResolution ||
    !same(source.legacyResolution, resolution) ||
    !bindingMatchesRequest(binding, request) ||
    !same(source.authority, request.authority) ||
    !same(source.publisher, request.publisher) ||
    source.activeStepId !== null
  )
    return false;

  if (request.outcome === "notApplied")
    return (
      request.checkpoint === null &&
      same(source.checkpoint, request.expectedCheckpoint) &&
      same(resolution.checkpoint, request.expectedCheckpoint)
    );

  if (request.checkpoint === null || !same(source.checkpoint, request.checkpoint)) return false;
  if (request.stepId === null) return same(request.expectedCheckpoint, request.checkpoint);
  return (
    source.lastCommittedStepId === request.stepId &&
    same(source.lastCommittedFromCheckpoint, request.expectedCheckpoint) &&
    source.checkpoint.checkpointId !== request.expectedCheckpoint.checkpointId
  );
}

export function legacyAdmissionReceipt(
  state: State,
  runId: string,
  command: AdmissionCommand,
  binding: HarnessDurableStateAdmissionBinding | null | undefined,
  resolution: AdmissionReceipt["resolution"],
): AdmissionReceipt {
  if (!binding) return fail("CONFLICT");
  const source = {
    ...sourceOf(state),
    kind: "legacyResolution" as const,
    legacyBinding: binding,
    legacyResolution: resolution,
  };
  const receipt: AdmissionReceipt = {
    version: 1,
    request: requestOf(runId, command),
    source,
    resolution,
  };
  if (
    !resultMatchesRequest(receipt.request, receipt.resolution) ||
    !legacySourceMatchesRequest(receipt)
  )
    return fail("CONFLICT");
  return receipt;
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
      !resultMatchesRequest(receipt.request, receipt.resolution) ||
      (receipt.source.kind === "legacyResolution"
        ? !legacySourceMatchesRequest(receipt)
        : !currentSourceMatchesRequest(receipt.source, receipt.request))
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
    source: sourceOf(state),
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
