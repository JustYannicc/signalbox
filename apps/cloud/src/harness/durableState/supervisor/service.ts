import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HarnessThreadSupervisorCommand } from "./contracts.ts";
import { HarnessThreadSupervisorError, fail } from "./errors.ts";
import { requireOwnSchema, formatTable, stateTable } from "./sqlite.ts";
import { decodeState, encodeState } from "./state.ts";
import type { HarnessThreadSupervisor, HarnessThreadSupervisorDatabase } from "./types.ts";
import type { State } from "./state.ts";
import type {
  HarnessThreadSupervisorCommand as HarnessThreadSupervisorCommandType,
  HarnessThreadSupervisorResult,
} from "./contracts.ts";
import { result, transition, validateReconciliationRequest } from "./transition.ts";
import {
  commitPendingReceipt,
  createPendingReceipt,
  insertReconciliationReceipt,
  parseReconciliationRequest,
  pendingReconciliationReceipt,
  readReconciliationReceipt,
  receiptMatchesRequest,
  receiptMatchesSource,
  seedLegacyReconciliationReceipt,
  sourceOf,
} from "./reconciliationReceipts.ts";
import type { HarnessThreadSupervisorReconciliationInput } from "./reconciliationReceipts.ts";

const first = (rows: Iterable<Record<string, unknown>>) => rows[Symbol.iterator]().next().value;
const decodeCommand = Schema.decodeUnknownSync(HarnessThreadSupervisorCommand, {
  onExcessProperty: "error",
});
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function readCurrent(
  database: HarnessThreadSupervisorDatabase,
  runId: string,
  initialize: boolean,
) {
  const schema = requireOwnSchema(database, initialize);
  const row = first(
    database.sql.exec(`SELECT revision, state_json FROM ${stateTable} WHERE slot = 1`),
  );
  const format = first(database.sql.exec(`SELECT version FROM ${formatTable} WHERE slot = 1`));
  if ((!schema.pristine && (!row || !format)) || (format && format.version !== 2))
    return fail("CORRUPT");
  if (
    row &&
    (typeof row.revision !== "number" ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      row.revision >= Number.MAX_SAFE_INTEGER)
  )
    return fail("CORRUPT");
  let current: State | null = null;
  if (row) {
    try {
      current = decodeState(row.state_json, runId);
    } catch (error) {
      if (error instanceof HarnessThreadSupervisorError) throw error;
      throw new HarnessThreadSupervisorError("CORRUPT", { cause: error });
    }
  }
  if (schema.migrated && current) seedLegacyReconciliationReceipt(database, current);
  return { ...schema, row, current };
}

function persistState(
  database: HarnessThreadSupervisorDatabase,
  runId: string,
  pristine: boolean,
  row: Record<string, unknown> | undefined,
  current: State | null,
  next: State,
) {
  const encoded = encodeState(next);
  const checked = decodeState(encoded, runId);
  if (current !== next) {
    if (!row) {
      if (!pristine) return fail("CORRUPT");
      database.sql.exec(`INSERT INTO ${formatTable} (slot, version) VALUES (1, 2)`);
      database.sql.exec(
        `INSERT INTO ${stateTable} (slot, revision, state_json) VALUES (1, 1, ?)`,
        encoded,
      );
    } else {
      const updated = first(
        database.sql.exec(
          `UPDATE ${stateTable} SET revision = revision + 1, state_json = ? WHERE slot = 1 AND revision = ? RETURNING revision`,
          encoded,
          row.revision as number,
        ),
      );
      if (!updated) return fail("STORAGE");
    }
  }
  return checked;
}

function reconciliationRequestOf(
  command: Extract<HarnessThreadSupervisorCommandType, { readonly type: "reconcile" }>,
): HarnessThreadSupervisorReconciliationInput {
  return {
    runId: command.runId,
    control: command.control,
    expectedGeneration: command.expectedGeneration,
    evidenceId: command.evidenceId,
    outcome: command.outcome,
    checkpoint: command.checkpoint,
    invocationSettlement: command.invocationSettlement,
    preparedFacetCleanup: command.preparedFacetCleanup,
  };
}

function matchesLegacyLatest(state: State, input: HarnessThreadSupervisorReconciliationInput) {
  return (
    state.reconciliationEvidenceId === input.evidenceId &&
    same(state.reconciliationControl, input.control) &&
    state.reconciliationExpectedGeneration === input.expectedGeneration &&
    state.reconciliationOutcome === input.outcome &&
    same(state.reconciliationCheckpoint, input.checkpoint) &&
    same(state.reconciliationInvocationSettlement, input.invocationSettlement) &&
    same(state.reconciliationPreparedFacetCleanup, input.preparedFacetCleanup)
  );
}

export interface HarnessThreadSupervisorReconciliationReservation {
  readonly status: "missing" | "pending" | "committed";
  readonly supervisor: HarnessThreadSupervisorResult;
}

export function reserveHarnessThreadSupervisorReconciliation(
  database: HarnessThreadSupervisorDatabase,
  runId: string,
  input: unknown,
): Effect.Effect<HarnessThreadSupervisorReconciliationReservation, HarnessThreadSupervisorError> {
  return Effect.try({
    try: () => {
      const request = parseReconciliationRequest(input);
      if (request.runId !== runId) return fail("CONFLICT");
      return database.transactionSync((): HarnessThreadSupervisorReconciliationReservation => {
        const { current } = readCurrent(database, runId, false);
        if (!current) return fail("MISSING");
        if (!same(current.control, request.control)) return fail("STALE_CONTROL");
        if (!same(sourceOf(current), request.expectedSource)) return fail("OUT_OF_ORDER");

        const existing = readReconciliationReceipt(database, request.evidenceId);
        if (existing) {
          if (!receiptMatchesRequest(existing, request)) return fail("CONFLICT");
          if (existing.status === "pending" && !receiptMatchesSource(existing, current))
            return fail("CONFLICT");
          return {
            status: existing.status,
            supervisor: result(current, "unchanged"),
          };
        }

        if (current.reconciliationEvidenceId === request.evidenceId) {
          if (!matchesLegacyLatest(current, request)) return fail("CONFLICT");
          return { status: "committed", supervisor: result(current, "unchanged") };
        }

        if (pendingReconciliationReceipt(database)) return fail("OUT_OF_ORDER");
        if (!request.reserve)
          return { status: "missing", supervisor: result(current, "unchanged") };
        validateReconciliationRequest(current, {
          type: "reconcile",
          control: request.control,
          expectedGeneration: request.expectedGeneration,
          evidenceId: request.evidenceId,
          outcome: request.outcome,
          checkpoint: request.checkpoint,
          invocationSettlement: request.invocationSettlement,
          preparedFacetCleanup: request.preparedFacetCleanup,
        });
        insertReconciliationReceipt(database, createPendingReceipt(current, request));
        return { status: "pending" as const, supervisor: result(current, "unchanged") };
      });
    },
    catch: (error) =>
      error instanceof HarnessThreadSupervisorError
        ? error
        : new HarnessThreadSupervisorError("STORAGE", { cause: error }),
  });
}

export function createHarnessThreadSupervisor(
  database: HarnessThreadSupervisorDatabase,
  runId: string,
): HarnessThreadSupervisor {
  return {
    execute: (input) =>
      Effect.try({
        try: () => {
          let command: HarnessThreadSupervisorCommandType;
          try {
            command = decodeCommand(input);
          } catch (error) {
            if (error instanceof HarnessThreadSupervisorError) throw error;
            return fail("INVALID");
          }
          if (command.runId !== runId) return fail("CONFLICT");
          return database.transactionSync(() => {
            const { pristine, row, current } = readCurrent(
              database,
              runId,
              command.type === "initialize",
            );
            const pending = pendingReconciliationReceipt(database);
            if (
              pending &&
              command.type !== "read" &&
              (command.type !== "reconcile" || pending.request.evidenceId !== command.evidenceId)
            )
              return fail("OUT_OF_ORDER");

            if (command.type === "reconcile") {
              if (!current || !same(current.control, command.control)) return fail("STALE_CONTROL");
              const receipt = readReconciliationReceipt(database, command.evidenceId);
              const request = reconciliationRequestOf(command);
              if (!receipt || !receiptMatchesRequest(receipt, request)) return fail("CONFLICT");
              if (receipt.status === "committed") {
                if (!same(receipt.admissionResolution, command.admissionResolution))
                  return fail("CONFLICT");
                if (!current) return fail("MISSING");
                return result(current, "unchanged");
              }
              if (!current || !receiptMatchesSource(receipt, current)) return fail("CONFLICT");
            }

            const next = transition(current, command);
            if (command.type === "reconcile") {
              const receipt = readReconciliationReceipt(database, command.evidenceId);
              if (!receipt || receipt.status !== "pending") return fail("CONFLICT");
              commitPendingReceipt(database, receipt, command.admissionResolution);
            }
            const checked = persistState(database, runId, pristine, row, current, next.state);
            return result(checked, next.action, next.revealPreparedPublisher);
          });
        },
        catch: (error) =>
          error instanceof HarnessThreadSupervisorError
            ? error
            : new HarnessThreadSupervisorError("STORAGE", { cause: error }),
      }),
  };
}
