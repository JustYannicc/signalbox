import * as Schema from "effect/Schema";
import { HarnessThreadSupervisorControlClaim, id, positive } from "../shared.ts";
import {
  AdmissionResolution,
  Checkpoint,
  Cleanup,
  InvocationSettlementEvidence,
  PreparedFacet,
} from "./contracts.ts";
import type { HarnessThreadSupervisorResult } from "./contracts.ts";
import type { HarnessThreadSupervisorDatabase } from "./types.ts";
import type { State } from "./state.ts";
import { fail } from "./errors.ts";
import { reconciliationTable } from "./sqlite.ts";

const Request = Schema.Struct({
  evidenceId: id,
  expectedGeneration: positive,
  outcome: Schema.Literals(["notApplied", "completed", "unknown"]),
  checkpoint: Schema.NullOr(Checkpoint),
  invocationSettlement: Schema.NullOr(InvocationSettlementEvidence),
  preparedFacetCleanup: Schema.NullOr(Cleanup),
});
const Authority = Schema.Struct({
  ownerId: id,
  incarnationId: id,
  epoch: positive,
});
const Source = Schema.Struct({
  lifecycle: Schema.Literals([
    "accepting",
    "draining",
    "settled",
    "stopped",
    "indeterminate",
    "preparing",
    "published",
    "activation-failed",
    "recoverable",
  ]),
  nativeSessionId: id,
  authority: Authority,
  generation: positive,
  facetNonce: id,
  checkpoint: Checkpoint,
  admittedStepId: Schema.NullOr(id),
  settlement: Schema.NullOr(
    Schema.Struct({
      outcome: Schema.Literals(["settled", "stopped", "indeterminate"]),
      invocationRpcJoined: Schema.Boolean,
      fetchJoined: Schema.Boolean,
      callbackPortsJoined: Schema.Boolean,
    }),
  ),
  preparedFacet: Schema.NullOr(PreparedFacet),
});
const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  request: Request,
  authority: Authority,
  source: Schema.NullOr(Source),
  status: Schema.Literals(["pending", "committed"]),
  legacy: Schema.optional(Schema.Boolean),
  admissionResolution: Schema.NullOr(AdmissionResolution),
});

export const HarnessThreadSupervisorReconciliationInput = Schema.Struct({
  runId: id,
  control: HarnessThreadSupervisorControlClaim,
  ...Request.fields,
});
export type HarnessThreadSupervisorReconciliationInput =
  typeof HarnessThreadSupervisorReconciliationInput.Type;
export const HarnessThreadSupervisorReconciliationRequest = Schema.Struct({
  ...HarnessThreadSupervisorReconciliationInput.fields,
  expectedSource: Source,
  reserve: Schema.Boolean,
});
export type HarnessThreadSupervisorReconciliationRequest =
  typeof HarnessThreadSupervisorReconciliationRequest.Type;
export type ReconciliationReceipt = typeof Receipt.Type;
export type ReconciliationSource = typeof Source.Type;

const decodeRequest = Schema.decodeUnknownSync(HarnessThreadSupervisorReconciliationRequest, {
  onExcessProperty: "error",
});
const decodeReceipt = Schema.decodeUnknownSync(Receipt, { onExcessProperty: "error" });
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const first = (rows: Iterable<Record<string, unknown>>) => rows[Symbol.iterator]().next().value;
const clean = (value: ReconciliationReceipt["request"]["preparedFacetCleanup"]) =>
  value !== null &&
  value.stopAcknowledged &&
  value.invocationRpcJoined &&
  value.fetchJoined &&
  value.callbackPortsJoined &&
  value.disposed;

function validReceipt(receipt: ReconciliationReceipt) {
  const { request, source, admissionResolution } = receipt;
  if (receipt.legacy) {
    if (receipt.status !== "committed" || source !== null) return false;
    if (request.outcome === "unknown") return admissionResolution === null;
    return (
      admissionResolution !== null &&
      admissionResolution.evidenceId === request.evidenceId &&
      admissionResolution.outcome === request.outcome &&
      (request.outcome === "completed"
        ? same(request.checkpoint, admissionResolution.checkpoint)
        : request.checkpoint === null &&
          same(admissionResolution.expectedCheckpoint, admissionResolution.checkpoint))
    );
  }
  if (source === null) return false;
  if (
    (source.lifecycle !== "indeterminate" && source.lifecycle !== "recoverable") ||
    !same(receipt.authority, source.authority) ||
    request.expectedGeneration !== source.generation ||
    (request.outcome === "completed") !== (request.checkpoint !== null) ||
    (request.outcome !== "unknown" &&
      (request.invocationSettlement === null ||
        !request.invocationSettlement.invocationRpcJoined ||
        !request.invocationSettlement.fetchJoined ||
        !request.invocationSettlement.callbackPortsJoined)) ||
    (source.preparedFacet === null
      ? request.preparedFacetCleanup !== null
      : source.preparedFacet.generation !== source.generation + 1 ||
        !same(source.preparedFacet.checkpoint, source.checkpoint) ||
        !clean(request.preparedFacetCleanup))
  )
    return false;
  if (receipt.status === "pending") return admissionResolution === null;
  if (request.outcome === "unknown") return admissionResolution === null;
  return (
    admissionResolution !== null &&
    admissionResolution.evidenceId === request.evidenceId &&
    admissionResolution.stepId === source.admittedStepId &&
    admissionResolution.outcome === request.outcome &&
    same(admissionResolution.expectedCheckpoint, source.checkpoint) &&
    same(
      admissionResolution.checkpoint,
      request.outcome === "completed" ? request.checkpoint : source.checkpoint,
    )
  );
}

export function requestOf(input: HarnessThreadSupervisorReconciliationInput) {
  return {
    evidenceId: input.evidenceId,
    expectedGeneration: input.expectedGeneration,
    outcome: input.outcome,
    checkpoint: input.checkpoint,
    invocationSettlement: input.invocationSettlement,
    preparedFacetCleanup: input.preparedFacetCleanup,
  };
}

export function authorityOf(control: State["control"]) {
  return {
    ownerId: control.ownerId,
    incarnationId: control.incarnationId,
    epoch: control.epoch,
  };
}

export function sourceOf(state: State) {
  return {
    lifecycle: state.lifecycle,
    nativeSessionId: state.nativeSessionId,
    authority: authorityOf(state.control),
    generation: state.publisher.generation,
    facetNonce: state.publisher.facetNonce,
    checkpoint: state.checkpoint,
    admittedStepId: state.admittedStepId,
    settlement: state.settlement,
    preparedFacet: state.prepared
      ? {
          operationId: state.prepared.operationId,
          generation: state.prepared.publisher.generation,
          facetNonce: state.prepared.publisher.facetNonce,
          checkpoint: state.prepared.checkpoint,
        }
      : null,
  };
}

export function sourceFromSnapshot(
  snapshot: HarnessThreadSupervisorResult["snapshot"],
): ReconciliationSource {
  return {
    lifecycle: snapshot.lifecycle,
    nativeSessionId: snapshot.nativeSessionId,
    authority: {
      ownerId: snapshot.ownerId,
      incarnationId: snapshot.controlIncarnationId,
      epoch: snapshot.controlEpoch,
    },
    generation: snapshot.generation,
    facetNonce: snapshot.facetNonce,
    checkpoint: snapshot.checkpoint,
    admittedStepId: snapshot.admittedStepId,
    settlement: snapshot.settlement,
    preparedFacet: snapshot.preparedFacet,
  };
}

export function createPendingReceipt(
  state: State,
  input: HarnessThreadSupervisorReconciliationRequest,
): ReconciliationReceipt {
  return {
    version: 1,
    request: requestOf(input),
    authority: authorityOf(input.control),
    source: sourceOf(state),
    status: "pending",
    legacy: false,
    admissionResolution: null,
  };
}

export function seedLegacyReconciliationReceipt(
  database: HarnessThreadSupervisorDatabase,
  state: State,
) {
  if (state.reconciliationEvidenceId === null) return;
  const control = state.reconciliationControl;
  if (
    control === null ||
    state.reconciliationExpectedGeneration === null ||
    state.reconciliationOutcome === null
  )
    return fail("CORRUPT");
  const receipt: ReconciliationReceipt = {
    version: 1,
    request: {
      evidenceId: state.reconciliationEvidenceId,
      expectedGeneration: state.reconciliationExpectedGeneration,
      outcome: state.reconciliationOutcome,
      checkpoint: state.reconciliationCheckpoint,
      invocationSettlement: state.reconciliationInvocationSettlement,
      preparedFacetCleanup: state.reconciliationPreparedFacetCleanup,
    },
    authority: authorityOf(control),
    source: null,
    status: "committed",
    legacy: true,
    admissionResolution: state.reconciliationAdmissionResolution,
  };
  if (!validReceipt(receipt)) return fail("CORRUPT");
  insertReconciliationReceipt(database, receipt);
}

export function readReconciliationReceipt(
  database: HarnessThreadSupervisorDatabase,
  evidenceId: string,
): ReconciliationReceipt | null {
  const row = first(
    database.sql.exec(
      `SELECT status, receipt_json FROM ${reconciliationTable} WHERE evidence_id = ?`,
      evidenceId,
    ),
  );
  if (!row) return null;
  try {
    if (typeof row.status !== "string" || typeof row.receipt_json !== "string")
      throw new Error("Malformed receipt row.");
    const receipt = decodeReceipt(JSON.parse(row.receipt_json));
    if (
      receipt.request.evidenceId !== evidenceId ||
      receipt.status !== row.status ||
      !validReceipt(receipt)
    )
      throw new Error("Receipt identity mismatch.");
    return receipt;
  } catch {
    return fail("CORRUPT");
  }
}

export function pendingReconciliationReceipt(
  database: HarnessThreadSupervisorDatabase,
): ReconciliationReceipt | null {
  const row = first(
    database.sql.exec(
      `SELECT status, receipt_json FROM ${reconciliationTable} WHERE status = 'pending' LIMIT 1`,
    ),
  );
  if (!row) return null;
  try {
    if (typeof row.status !== "string" || typeof row.receipt_json !== "string")
      throw new Error("Malformed receipt row.");
    const receipt = decodeReceipt(JSON.parse(row.receipt_json));
    if (receipt.status !== row.status || !validReceipt(receipt))
      throw new Error("Receipt status mismatch.");
    return receipt;
  } catch {
    return fail("CORRUPT");
  }
}

export function receiptMatchesRequest(
  receipt: ReconciliationReceipt,
  input: HarnessThreadSupervisorReconciliationInput,
) {
  return (
    same(receipt.request, requestOf(input)) && same(receipt.authority, authorityOf(input.control))
  );
}

export function receiptMatchesSource(receipt: ReconciliationReceipt, state: State) {
  return same(receipt.source, sourceOf(state));
}

export function insertReconciliationReceipt(
  database: HarnessThreadSupervisorDatabase,
  receipt: ReconciliationReceipt,
) {
  database.sql.exec(
    `INSERT INTO ${reconciliationTable} (evidence_id, status, receipt_json) VALUES (?, ?, ?)`,
    receipt.request.evidenceId,
    receipt.status,
    JSON.stringify(receipt),
  );
}

export function commitPendingReceipt(
  database: HarnessThreadSupervisorDatabase,
  receipt: ReconciliationReceipt,
  admissionResolution: ReconciliationReceipt["admissionResolution"],
) {
  const committed = { ...receipt, status: "committed" as const, admissionResolution };
  const updated = first(
    database.sql.exec(
      `UPDATE ${reconciliationTable} SET status = ?, receipt_json = ? WHERE evidence_id = ? AND status = 'pending' RETURNING evidence_id`,
      committed.status,
      JSON.stringify(committed),
      committed.request.evidenceId,
    ),
  );
  if (!updated) return fail("STORAGE");
}

export function parseReconciliationRequest(input: unknown) {
  try {
    return decodeRequest(input);
  } catch {
    return fail("INVALID");
  }
}
