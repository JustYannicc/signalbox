import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HarnessFilesStoreCommand } from "./contracts.ts";
import type { HarnessFilesStoreResult } from "./contracts.ts";
import { HarnessFilesStoreError, fail } from "./errors.ts";
import { insertCheckpoint, prepareCheckpoint, readCheckpoint } from "./content.ts";
import { metaTable, requireOwnSchema } from "./sqlite.ts";
import { decodeState, encodeState } from "./state.ts";
import type { State } from "./state.ts";
import type { HarnessFilesStore } from "./types.ts";
import type { HarnessFilesDatabase } from "./types.ts";
import type { HarnessFilesStoreCommand as HarnessFilesStoreCommandType } from "./contracts.ts";

const first = (rows: Iterable<Record<string, unknown>>) => rows[Symbol.iterator]().next().value;
interface MetaRow {
  readonly revision: number;
  readonly state_json: string;
}
const decodeCommand = Schema.decodeUnknownSync(HarnessFilesStoreCommand, {
  onExcessProperty: "error",
});
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
type SyncControlCommand = Extract<HarnessFilesStoreCommandType, { readonly type: "syncControl" }>;
const sameReceipt = (
  publication: State["lastPublication"],
  receipt: SyncControlCommand["publication"],
) =>
  publication === null || receipt === null
    ? publication === receipt
    : publication.operationId === receipt.operationId &&
      publication.fromGeneration === receipt.fromGeneration &&
      publication.toGeneration === receipt.toGeneration &&
      publication.priorFacetNonce === receipt.priorFacetNonce &&
      publication.preparedFacetNonce === receipt.preparedFacetNonce &&
      same(publication.checkpoint, receipt.checkpoint);
const visiblePublication = (state: State) => state.pendingPublication ?? state.lastPublication;

function controlSyncMatchesState(state: State, command: SyncControlCommand): boolean {
  const pending = state.pendingPublication;
  if (pending) {
    if (command.preparedPublication) {
      return (
        command.expectedGeneration === pending.fromGeneration &&
        sameReceipt(state.lastPublication, command.publication) &&
        sameReceipt(pending, command.preparedPublication) &&
        state.publisher.generation === pending.fromGeneration &&
        state.pendingPublisher?.generation === pending.toGeneration &&
        state.pendingPublisher.facetNonce === pending.preparedFacetNonce
      );
    }
    return (
      command.expectedGeneration === pending.toGeneration &&
      sameReceipt(pending, command.publication) &&
      state.publisher.generation === pending.fromGeneration &&
      state.pendingPublisher?.generation === pending.toGeneration &&
      state.pendingPublisher.facetNonce === pending.preparedFacetNonce
    );
  }

  const prepared = command.preparedPublication;
  return (
    command.expectedGeneration === state.publisher.generation &&
    sameReceipt(state.lastPublication, command.publication) &&
    (prepared === null ||
      (prepared.fromGeneration === state.publisher.generation &&
        prepared.toGeneration === state.publisher.generation + 1 &&
        prepared.priorFacetNonce === state.publisher.facetNonce &&
        prepared.preparedFacetNonce !== state.publisher.facetNonce &&
        same(prepared.checkpoint, state.checkpoint)))
  );
}

function stateRow(database: HarnessFilesDatabase) {
  const row = first(
    database.sql.exec(`SELECT revision, state_json FROM ${metaTable} WHERE slot = 1`),
  );
  if (!row) return undefined;
  if (
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    typeof row.state_json !== "string"
  )
    return fail("CORRUPT");
  return { revision: row.revision, state_json: row.state_json } satisfies MetaRow;
}

function saveState(
  database: HarnessFilesDatabase,
  row: MetaRow | undefined,
  state: Parameters<typeof encodeState>[0],
) {
  const json = encodeState(state);
  if (!row) {
    database.sql.exec(
      `INSERT INTO ${metaTable} (slot, revision, state_json) VALUES (1, 1, ?)`,
      json,
    );
    return;
  }
  const updated = first(
    database.sql.exec(
      `UPDATE ${metaTable} SET revision = revision + 1, state_json = ? WHERE slot = 1 AND revision = ? RETURNING revision`,
      json,
      row.revision,
    ),
  );
  if (!updated) return fail("STORAGE");
}

function currentState(database: HarnessFilesDatabase, runId: string) {
  const row = stateRow(database);
  if (!row) return { row: undefined, state: null } as const;
  try {
    return { row, state: decodeState(row.state_json, runId) } as const;
  } catch (error) {
    if (error instanceof HarnessFilesStoreError) throw error;
    throw new HarnessFilesStoreError("CORRUPT", { cause: error });
  }
}

const requireControl = (
  state: NonNullable<ReturnType<typeof currentState>["state"]>,
  control: unknown,
) => {
  if (!same(state.control, control)) return fail("STALE_CONTROL");
};
const requirePublisher = (
  state: NonNullable<ReturnType<typeof currentState>["state"]>,
  publisher: unknown,
) => {
  if (!same(state.publisher, publisher)) return fail("STALE_PUBLISHER");
};

export function createHarnessFilesStore(
  database: HarnessFilesDatabase,
  runId: string,
): HarnessFilesStore {
  return {
    execute: (input) =>
      Effect.tryPromise({
        try: async () => {
          let command: HarnessFilesStoreCommandType;
          try {
            command = decodeCommand(input);
          } catch (error) {
            if (error instanceof HarnessFilesStoreError) throw error;
            throw new HarnessFilesStoreError("INVALID", { cause: error });
          }
          if (command.runId !== runId) return fail("CONFLICT");
          const prepared =
            command.type === "initialize" || command.type === "writeCheckpoint"
              ? await prepareCheckpoint(command.checkpoint)
              : null;

          if (command.type === "readCheckpoint" || command.type === "recoverCheckpoint") {
            const target = database.transactionSync(() => {
              const current = currentState(database, runId);
              if (!current.state) return fail("MISSING");
              requirePublisher(current.state, command.publisher);
              return current.state;
            });
            const content = await readCheckpoint(database, command.checkpointId, "read");
            const stillCurrent = database.transactionSync(() => {
              const current = currentState(database, runId);
              if (!current.state) return fail("MISSING");
              requirePublisher(current.state, command.publisher);
              return current.state;
            });
            if (target.runId !== stillCurrent.runId) return fail("CORRUPT");
            return {
              action: command.type === "readCheckpoint" ? "read" : "recovered",
              checkpoint: {
                checkpointId: content.checkpointId,
                manifestSha256: content.manifestSha256,
              },
              parentCheckpointId: content.parentCheckpointId,
              activeStepId: stillCurrent.activeStepId,
              publication: visiblePublication(stillCurrent),
              files: content.files,
            } as const;
          }

          return database.transactionSync(() => {
            const pristine = requireOwnSchema(database, command.type === "initialize");
            const current = currentState(database, runId);
            if (!current.state && command.type !== "initialize") return fail("MISSING");
            const state = current.state;
            if (command.type === "initialize") {
              if (!prepared) return fail("INVALID");
              if (prepared.parentCheckpointId !== null) return fail("INVALID");
              if (state) {
                requireControl(state, command.control);
                requirePublisher(state, command.publisher);
                if (
                  !same(state.initialCheckpoint, {
                    checkpointId: prepared.checkpointId,
                    manifestSha256: prepared.manifestSha256,
                  })
                )
                  return fail("CONFLICT");
                return result(state, "unchanged", []);
              }
              if (!pristine || command.control.controlKey === command.publisher.publisherKey)
                return fail("CONFLICT");
              const inserted = insertCheckpoint(database, prepared);
              const initial = {
                version: 1 as const,
                runId,
                control: command.control,
                publisher: command.publisher,
                initialCheckpoint: {
                  checkpointId: prepared.checkpointId,
                  manifestSha256: prepared.manifestSha256,
                },
                checkpoint: {
                  checkpointId: prepared.checkpointId,
                  manifestSha256: prepared.manifestSha256,
                },
                lifecycle: "accepting" as const,
                activeStepId: null,
                lastCommittedStepId: null,
                pendingPublisher: null,
                lastPublication: null,
                pendingPublication: null,
                controlSyncOperationId: null,
                activationOperationId: null,
              };
              saveState(database, undefined, initial);
              return result(initial, inserted);
            }
            if (!state || !current.row) return fail("MISSING");

            switch (command.type) {
              case "syncControl": {
                if (
                  same(state.control, command.control) &&
                  state.controlSyncOperationId === command.operationId
                ) {
                  if (!controlSyncMatchesState(state, command)) return fail("CONFLICT");
                  return result(state, "unchanged");
                }
                if (
                  command.control.ownerId !== state.control.ownerId ||
                  command.control.epoch !== state.control.epoch + 1 ||
                  command.control.incarnationId === state.control.incarnationId ||
                  command.control.controlKey === state.control.controlKey ||
                  !controlSyncMatchesState(state, command)
                )
                  return fail("CONFLICT");
                const next = {
                  ...state,
                  control: command.control,
                  lifecycle:
                    state.lifecycle === "accepting" ? ("draining" as const) : state.lifecycle,
                  controlSyncOperationId: command.operationId,
                };
                saveState(database, current.row, next);
                return result(next, "draining");
              }
              case "admitStep": {
                requirePublisher(state, command.publisher);
                if (state.lifecycle !== "accepting" || state.pendingPublication !== null)
                  return fail("OUT_OF_ORDER");
                if (state.activeStepId) {
                  if (state.activeStepId === command.stepId) return result(state, "unchanged");
                  return fail("CONFLICT");
                }
                if (state.checkpoint.checkpointId !== command.expectedCheckpointId)
                  return fail("OUT_OF_ORDER");
                const next = { ...state, activeStepId: command.stepId };
                saveState(database, current.row, next);
                return result(next, "admitted");
              }
              case "writeCheckpoint": {
                if (!prepared) return fail("INVALID");
                requirePublisher(state, command.publisher);
                if (state.lifecycle !== "accepting" && state.lifecycle !== "draining")
                  return fail("OUT_OF_ORDER");
                if (
                  state.lastCommittedStepId === command.stepId &&
                  state.checkpoint.checkpointId === prepared.checkpointId &&
                  state.checkpoint.manifestSha256 === prepared.manifestSha256
                )
                  return result(state, "unchanged", []);
                if (
                  state.activeStepId !== command.stepId ||
                  state.checkpoint.checkpointId !== command.expectedCheckpointId ||
                  prepared.parentCheckpointId !== command.expectedCheckpointId ||
                  prepared.checkpointId === command.expectedCheckpointId
                )
                  return fail("OUT_OF_ORDER");
                const inserted = insertCheckpoint(database, prepared);
                const next = {
                  ...state,
                  checkpoint: {
                    checkpointId: prepared.checkpointId,
                    manifestSha256: prepared.manifestSha256,
                  },
                  activeStepId: null,
                  lastCommittedStepId: command.stepId,
                };
                saveState(database, current.row, next);
                return result(next, inserted, prepared.files, prepared.parentCheckpointId);
              }
              case "publishFacet": {
                requireControl(state, command.control);
                if (
                  state.lifecycle === "publishing" &&
                  state.pendingPublication?.operationId === command.operationId &&
                  state.pendingPublication.status === "pending" &&
                  same(state.pendingPublisher, command.preparedPublisher) &&
                  same(state.pendingPublication.checkpoint, command.checkpoint) &&
                  command.expectedGeneration === state.pendingPublication.fromGeneration &&
                  (same(state.publisher, command.publisher) ||
                    same(state.pendingPublisher, command.publisher))
                )
                  return result(state, "unchanged", []);
                if (
                  state.lastPublication?.operationId === command.operationId &&
                  state.lastPublication.status === "confirmed" &&
                  same(state.publisher, command.preparedPublisher) &&
                  same(state.lastPublication.checkpoint, command.checkpoint) &&
                  command.expectedGeneration === state.lastPublication.fromGeneration &&
                  same(state.publisher, command.publisher)
                )
                  return result(state, "unchanged", []);
                requirePublisher(state, command.publisher);
                if (
                  state.lifecycle !== "draining" ||
                  state.activeStepId !== null ||
                  state.pendingPublication !== null ||
                  state.pendingPublisher !== null ||
                  command.expectedGeneration !== state.publisher.generation ||
                  command.preparedPublisher.generation !== state.publisher.generation + 1 ||
                  command.preparedPublisher.facetNonce === state.publisher.facetNonce ||
                  command.preparedPublisher.publisherKey === state.publisher.publisherKey ||
                  command.preparedPublisher.publisherKey === state.control.controlKey ||
                  !same(state.checkpoint, command.checkpoint)
                )
                  return fail("OUT_OF_ORDER");
                const next = {
                  ...state,
                  lifecycle: "publishing" as const,
                  pendingPublisher: command.preparedPublisher,
                  pendingPublication: {
                    operationId: command.operationId,
                    fromGeneration: state.publisher.generation,
                    toGeneration: command.preparedPublisher.generation,
                    priorFacetNonce: state.publisher.facetNonce,
                    preparedFacetNonce: command.preparedPublisher.facetNonce,
                    checkpoint: command.checkpoint,
                    status: "pending" as const,
                  },
                };
                saveState(database, current.row, next);
                return result(next, "prepared", []);
              }
              case "confirmFacetPublication": {
                requireControl(state, command.control);
                const publication = state.pendingPublication;
                if (
                  state.lastPublication?.operationId === command.operationId &&
                  state.lastPublication.status === "confirmed" &&
                  same(state.publisher, command.preparedPublisher) &&
                  command.expectedGeneration === state.lastPublication.fromGeneration &&
                  same(state.lastPublication.checkpoint, command.checkpoint)
                )
                  return result(state, "unchanged", []);
                if (
                  state.lifecycle !== "publishing" ||
                  publication?.operationId !== command.operationId ||
                  publication.status !== "pending" ||
                  state.pendingPublisher === null ||
                  !same(state.pendingPublisher, command.preparedPublisher) ||
                  command.expectedGeneration !== publication.fromGeneration ||
                  !same(publication.checkpoint, command.checkpoint)
                )
                  return fail("OUT_OF_ORDER");
                const next = {
                  ...state,
                  publisher: state.pendingPublisher,
                  pendingPublisher: null,
                  lifecycle: "published" as const,
                  lastPublication: { ...publication, status: "confirmed" as const },
                  pendingPublication: null,
                };
                saveState(database, current.row, next);
                return result(next, "confirmed", []);
              }
              case "abortFacetPublication": {
                requireControl(state, command.control);
                const publication = state.pendingPublication;
                if (
                  state.lifecycle !== "publishing" ||
                  publication?.status !== "pending" ||
                  publication.operationId !== command.operationId ||
                  state.pendingPublisher === null ||
                  !same(state.pendingPublisher, command.preparedPublisher) ||
                  command.expectedGeneration !== publication.fromGeneration
                )
                  return fail("OUT_OF_ORDER");
                const next = {
                  ...state,
                  lifecycle: "draining" as const,
                  pendingPublisher: null,
                  pendingPublication: null,
                };
                saveState(database, current.row, next);
                return result(next, "aborted", []);
              }
              case "readPublication": {
                requireControl(state, command.control);
                const publication =
                  state.pendingPublication?.operationId === command.operationId
                    ? state.pendingPublication
                    : state.lastPublication?.operationId === command.operationId
                      ? state.lastPublication
                      : null;
                if (!publication) return fail("MISSING");
                return result(
                  state,
                  publication.status === "pending" ? "pending" : "unchanged",
                  [],
                );
              }
              case "recordActivation": {
                requireControl(state, command.control);
                requirePublisher(state, command.publisher);
                if (
                  state.lifecycle === "accepting" &&
                  state.activationOperationId === command.operationId
                )
                  return result(state, "unchanged");
                if (
                  (state.lifecycle !== "published" && state.lifecycle !== "activation-failed") ||
                  state.lastPublication?.operationId !== command.operationId ||
                  state.lastPublication.status !== "confirmed" ||
                  command.expectedGeneration !== state.publisher.generation
                )
                  return fail("OUT_OF_ORDER");
                const next = {
                  ...state,
                  lifecycle: "accepting" as const,
                  activationOperationId: command.operationId,
                };
                saveState(database, current.row, next);
                return result(next, "activated");
              }
              case "recordActivationFailure": {
                requireControl(state, command.control);
                requirePublisher(state, command.publisher);
                if (state.lifecycle !== "published" && state.lifecycle !== "activation-failed")
                  return fail("OUT_OF_ORDER");
                if (
                  state.lastPublication?.operationId !== command.operationId ||
                  command.expectedGeneration !== state.publisher.generation
                )
                  return fail("CONFLICT");
                const next = {
                  ...state,
                  lifecycle: "activation-failed" as const,
                  activationOperationId: command.operationId,
                };
                saveState(database, current.row, next);
                return result(next, "activation-failed");
              }
              default:
                return fail("INVALID");
            }
          });
        },
        catch: (error) =>
          error instanceof HarnessFilesStoreError
            ? error
            : new HarnessFilesStoreError("STORAGE", { cause: error }),
      }),
  };
}

function result(
  state: import("./state.ts").State,
  action: HarnessFilesStoreResult["action"],
  files: HarnessFilesStoreResult["files"] = [],
  parentCheckpointId: string | null = null,
): HarnessFilesStoreResult {
  return {
    action,
    checkpoint: state.checkpoint,
    parentCheckpointId,
    activeStepId: state.activeStepId,
    publication: visiblePublication(state),
    files,
  };
}
