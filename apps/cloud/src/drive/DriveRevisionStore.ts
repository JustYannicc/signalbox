import { canWrite } from "./driveAccess.ts";
import type { DriveCheckpointRecord } from "@signalbox/runner-protocol/DriveProtocol";
import * as DriveRevisions from "./DriveRevisions.ts";
import type {
  CheckpointOperationResult,
  DriveWriter,
  ForkCheckpointRequest,
  RefWrite,
  RestoreCheckpointRequest,
  UndoRestoreRequest,
  ThreadRefs,
  UpdateToLatestRequest,
} from "./driveRevisionTypes.ts";
import type { Oid } from "./git/gitObjects.ts";
import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export interface RevisionOperationsInput {
  readonly sql: SqlClient.SqlClient;
  readonly role: (userId: string) => Effect.Effect<SignalboxDriveRole | null, SqlError>;
  readonly threadRow: (
    threadId: string,
  ) => Effect.Effect<typeof DriveRevisions.ThreadRevisionRow.Type | null, SqlError>;
  readonly refs: (
    threadId: string | null,
    packsAfter?: number,
  ) => Effect.Effect<ThreadRefs, SqlError>;
  readonly ref: (name: string) => Effect.Effect<Oid | null, SqlError>;
  readonly internalRef: (name: string) => Effect.Effect<Oid | null, SqlError>;
  readonly publicCommit: (oid: Oid) => Effect.Effect<boolean, SqlError>;
  readonly threadRef: (threadId: string) => string;
  readonly wipRef: (threadId: string) => string;
  readonly setRef: (name: string, oid: Oid, by: string) => Effect.Effect<void, SqlError>;
  readonly removeRef: (name: string) => Effect.Effect<void, SqlError>;
  readonly land: (
    name: string,
    before: Oid | null,
    after: Oid | null,
    by: { readonly threadId: string } | { readonly userId: string },
  ) => Effect.Effect<void, SqlError>;
  readonly fence: (writer: DriveWriter) => Effect.Effect<boolean, SqlError>;
}

export const makeOperations = (input: RevisionOperationsInput) => {
  const { sql } = input;
  const checkpointRecord = (
    row: typeof DriveRevisions.CheckpointRow.Type,
  ): DriveCheckpointRecord => ({
    runId: row.run_id,
    turnId: row.turn_id,
    commit: row.commit_oid,
    start: row.start_oid,
    notes: row.notes_oid,
    views: DriveRevisions.decodeViews(row.views_json),
  });

  const checkpointRow = (threadId: string, runId: string) =>
    sql`SELECT thread_id, run_id, turn_id, commit_oid, start_oid, notes_oid, views_json, generation
      FROM drive_checkpoints WHERE thread_id = ${threadId} AND run_id = ${runId}`.pipe(
      Effect.map((rows) => DriveRevisions.decodeCheckpointRows(rows)[0] ?? null),
    );

  const restoreSnapshot = (threadId: string, operationId: string) =>
    sql`SELECT before_thread_oid, before_wip_oid, before_pinned_views, before_revision,
        restored_pinned_views, restored_revision,
        restored_generation, undone_by
      FROM drive_restore_snapshots
      WHERE thread_id = ${threadId} AND restore_operation_id = ${operationId}`.pipe(
      Effect.map((rows) => DriveRevisions.decodeRestoreSnapshotRows(rows)[0] ?? null),
    );

  const checkpoint: (
    threadId: string,
    runId: string,
  ) => Effect.Effect<DriveCheckpointRecord | null, SqlError> = (threadId, runId) =>
    Effect.map(checkpointRow(threadId, runId), (row) =>
      row === null ? null : checkpointRecord(row),
    );

  const NO_ACCESS_REASON = "You no longer have access to change this drive.";
  const refuseOperation = (reason: string, generation?: number): CheckpointOperationResult =>
    generation === undefined
      ? { _tag: "refused", reason }
      : { _tag: "refused", reason, generation };

  const operationResult = (
    tag: "ok" | "conflict",
    threadId: string,
  ): Effect.Effect<CheckpointOperationResult, SqlError> =>
    Effect.gen(function* () {
      const row = yield* input.threadRow(threadId);
      return {
        _tag: tag,
        refs: yield* input.refs(threadId, 0),
        generation: row?.generation ?? 0,
      } as const;
    });

  const receipt = (threadId: string, operationId: string) =>
    sql`SELECT kind, request_json FROM drive_revision_operations
      WHERE thread_id = ${threadId} AND operation_id = ${operationId}`.pipe(
      Effect.map((rows) => DriveRevisions.decodeOperationRows(rows)[0] ?? null),
    );

  const replayOperation = (
    threadId: string,
    request: string,
    kind: string,
    operationId: string,
  ): Effect.Effect<CheckpointOperationResult | null, SqlError> =>
    Effect.gen(function* () {
      const prior = yield* receipt(threadId, operationId);
      if (prior === null) return null;
      if (prior.kind !== kind || prior.request_json !== request) {
        return refuseOperation("This operation id already belongs to a different request.");
      }
      if ((yield* input.threadRow(threadId)) === null) {
        return refuseOperation("The thread for this operation no longer exists.");
      }
      // A retry never reapplies an old ref move; it reports the current state.
      return yield* operationResult("ok", threadId);
    });

  const rememberOperation = (
    threadId: string,
    operationId: string,
    kind: string,
    request: string,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO drive_revision_operations
        (thread_id, operation_id, kind, request_json, created_at)
        VALUES (${threadId}, ${operationId}, ${kind}, ${request}, ${now})`;
    });

  const recordCheckpoint: (
    writer: DriveWriter,
    record: DriveCheckpointRecord,
  ) => Effect.Effect<RefWrite, SqlError> = (writer, record) =>
    Effect.gen(function* () {
      if (!canWrite(yield* input.role(writer.userId))) {
        return { _tag: "refused", reason: NO_ACCESS_REASON } as const;
      }
      if (!(yield* input.fence(writer))) {
        return {
          _tag: "refused",
          reason: "A newer machine of this thread writes here now.",
        } as const;
      }
      if ((yield* input.threadRow(writer.threadId)) === null) {
        return { _tag: "refused", reason: "Open the thread before checkpointing it." } as const;
      }
      if (record.runId === "" || record.turnId === "") {
        return { _tag: "refused", reason: "A checkpoint needs a run and turn id." } as const;
      }
      const commits = [
        record.commit,
        record.notes,
        ...(record.start === null ? [] : [record.start]),
      ];
      for (const oid of commits) {
        if (!(yield* input.publicCommit(oid))) {
          return { _tag: "refused", reason: `Checkpoint commit ${oid} is not public.` } as const;
        }
      }

      const existing = yield* checkpointRow(writer.threadId, record.runId);
      if (existing !== null) {
        if (
          existing.turn_id !== record.turnId ||
          existing.commit_oid !== record.commit ||
          existing.start_oid !== record.start ||
          existing.notes_oid !== record.notes ||
          existing.views_json !== DriveRevisions.encodeViews(record.views)
        ) {
          return {
            _tag: "refused",
            reason: "This run already has a different checkpoint.",
          } as const;
        }
        return { _tag: "ok", refs: yield* input.refs(writer.threadId, writer.packsAfter) } as const;
      }

      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO drive_checkpoints
          (thread_id, run_id, turn_id, commit_oid, start_oid, notes_oid, views_json, generation, created_at)
          VALUES (${writer.threadId}, ${record.runId}, ${record.turnId}, ${record.commit},
            ${record.start}, ${record.notes}, ${DriveRevisions.encodeViews(record.views)},
            ${writer.generation}, ${now})`;
      yield* input.setRef(
        DriveRevisions.checkpointRef(writer.threadId, record.runId),
        record.commit,
        writer.threadId,
      );
      yield* input.setRef(
        DriveRevisions.checkpointNotesRef(writer.threadId, record.runId),
        record.notes,
        writer.threadId,
      );
      yield* input.setRef(DriveRevisions.notesRef(writer.threadId), record.notes, writer.threadId);
      yield* sql`UPDATE threads SET notes_oid = ${record.notes}
          WHERE thread_id = ${writer.threadId}`;
      return { _tag: "ok", refs: yield* input.refs(writer.threadId, writer.packsAfter) } as const;
    }).pipe(sql.withTransaction);

  const forkCheckpoint: (
    userId: string,
    request: ForkCheckpointRequest,
  ) => Effect.Effect<CheckpointOperationResult, SqlError> = (userId, request) =>
    Effect.gen(function* () {
      if (!canWrite(yield* input.role(userId))) return refuseOperation(NO_ACCESS_REASON);
      if (request.operationId === "" || request.runId === "" || request.threadId === "") {
        return refuseOperation("A fork needs an operation, run and destination thread id.");
      }
      if (request.sourceThreadId === request.threadId) {
        return refuseOperation("A checkpoint fork needs a new destination thread.");
      }
      const requestJson = DriveRevisions.encodeForkRequest({
        sourceThreadId: request.sourceThreadId,
        runId: request.runId,
        threadId: request.threadId,
      });
      const replay = yield* replayOperation(
        request.threadId,
        requestJson,
        "fork",
        request.operationId,
      );
      if (replay !== null) return replay;
      if ((yield* input.threadRow(request.threadId)) !== null) {
        return refuseOperation("The destination thread already has a drive.");
      }
      const selected = yield* checkpointRow(request.sourceThreadId, request.runId);
      if (selected === null) return refuseOperation("That checkpoint is no longer available.");
      if (!(yield* input.publicCommit(selected.commit_oid))) {
        return refuseOperation("That checkpoint's commit is no longer public.");
      }
      const source = yield* input.threadRow(request.sourceThreadId);
      const notes = source?.notes_oid ?? selected.notes_oid;
      if (!(yield* input.publicCommit(notes))) {
        return refuseOperation("The source thread's notes are no longer public.");
      }
      const views = DriveRevisions.decodeViews(selected.views_json);
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO threads
        (thread_id, base, generation, opened_at, notes_oid, pinned_views, revision)
        VALUES (${request.threadId}, ${selected.commit_oid}, 0, ${now}, ${notes},
          ${DriveRevisions.encodeViews(views)}, ${request.operationId})`;
      yield* input.setRef(input.threadRef(request.threadId), selected.commit_oid, request.threadId);
      yield* input.setRef(input.wipRef(request.threadId), selected.commit_oid, request.threadId);
      yield* input.setRef(DriveRevisions.notesRef(request.threadId), notes, request.threadId);
      const current = yield* input.refs(request.threadId, 0);
      yield* rememberOperation(request.threadId, request.operationId, "fork", requestJson);
      return { _tag: "ok", refs: current, generation: 0 } as const;
    }).pipe(sql.withTransaction);

  const restoreCheckpoint: (
    userId: string,
    request: RestoreCheckpointRequest,
  ) => Effect.Effect<CheckpointOperationResult, SqlError> = (userId, request) =>
    Effect.gen(function* () {
      if (!canWrite(yield* input.role(userId))) return refuseOperation(NO_ACCESS_REASON);
      if (
        request.operationId === "" ||
        request.runId === "" ||
        !Number.isSafeInteger(request.generation)
      ) {
        return refuseOperation("A restore needs an operation id and current generation.");
      }
      const requestJson = DriveRevisions.encodeRestoreRequest({
        threadId: request.threadId,
        runId: request.runId,
        expectedThread: request.expectedThread,
        expectedWip: request.expectedWip,
        generation: request.generation,
      });
      const replay = yield* replayOperation(
        request.threadId,
        requestJson,
        "restore",
        request.operationId,
      );
      if (replay !== null) return replay;
      const currentRow = yield* input.threadRow(request.threadId);
      if (currentRow === null) return refuseOperation("The thread has no drive.");
      if (request.generation !== currentRow.generation) {
        return refuseOperation("A newer machine owns this thread now.", currentRow.generation);
      }
      const currentThread = yield* input.ref(input.threadRef(request.threadId));
      const currentWip = yield* input.ref(input.wipRef(request.threadId));
      if (currentThread !== request.expectedThread || currentWip !== request.expectedWip) {
        return yield* operationResult("conflict", request.threadId);
      }
      const selected = yield* checkpointRow(request.threadId, request.runId);
      if (selected === null) {
        return refuseOperation("That checkpoint is no longer available.", currentRow.generation);
      }
      if (!(yield* input.publicCommit(selected.commit_oid))) {
        return refuseOperation(
          "That checkpoint's commit is no longer public.",
          currentRow.generation,
        );
      }
      const generation = currentRow.generation + 1;
      if (!Number.isSafeInteger(generation)) {
        return refuseOperation(
          "The thread generation can no longer advance safely.",
          currentRow.generation,
        );
      }
      if (currentThread !== null) {
        yield* input.setRef(
          DriveRevisions.restoreSnapshotRef(request.threadId, request.operationId, "thread"),
          currentThread,
          userId,
        );
      }
      if (currentWip !== null) {
        yield* input.setRef(
          DriveRevisions.restoreSnapshotRef(request.threadId, request.operationId, "wip"),
          currentWip,
          userId,
        );
      }
      yield* sql`INSERT INTO drive_restore_snapshots
        (thread_id, restore_operation_id, before_thread_oid, before_wip_oid,
          before_pinned_views, before_revision, restored_pinned_views,
          restored_revision, restored_generation)
        VALUES (${request.threadId}, ${request.operationId}, ${currentThread}, ${currentWip},
          ${currentRow.pinned_views}, ${currentRow.revision}, ${selected.views_json},
          ${request.operationId}, ${generation})`;
      yield* input.land(input.threadRef(request.threadId), currentThread, selected.commit_oid, {
        userId,
      });
      yield* input.setRef(input.wipRef(request.threadId), selected.commit_oid, userId);
      yield* sql`UPDATE threads SET generation = ${generation},
        pinned_views = ${selected.views_json}, revision = ${request.operationId}
        WHERE thread_id = ${request.threadId}`;
      const updated = yield* input.refs(request.threadId, 0);
      yield* rememberOperation(request.threadId, request.operationId, "restore", requestJson);
      return { _tag: "ok", refs: updated, generation } as const;
    }).pipe(sql.withTransaction);

  const undoRestore: (
    userId: string,
    request: UndoRestoreRequest,
  ) => Effect.Effect<CheckpointOperationResult, SqlError> = (userId, request) =>
    Effect.gen(function* () {
      if (!canWrite(yield* input.role(userId))) return refuseOperation(NO_ACCESS_REASON);
      if (
        request.operationId === "" ||
        request.restoreOperationId === "" ||
        !Number.isSafeInteger(request.generation)
      ) {
        return refuseOperation("An undo needs operation ids and the current generation.");
      }
      const requestJson = DriveRevisions.encodeUndoRestoreRequest({
        threadId: request.threadId,
        restoreOperationId: request.restoreOperationId,
        expectedThread: request.expectedThread,
        expectedWip: request.expectedWip,
        generation: request.generation,
      });
      const replay = yield* replayOperation(
        request.threadId,
        requestJson,
        "undo-restore",
        request.operationId,
      );
      if (replay !== null) return replay;

      const original = yield* receipt(request.threadId, request.restoreOperationId);
      if (original?.kind !== "restore") {
        return refuseOperation("That restore operation is no longer available.");
      }
      const snapshot = yield* restoreSnapshot(request.threadId, request.restoreOperationId);
      if (snapshot === null) {
        return refuseOperation("That restore has no retained undo state.");
      }
      if (snapshot.undone_by !== null) {
        return refuseOperation("That restore has already been undone.");
      }

      const currentRow = yield* input.threadRow(request.threadId);
      if (currentRow === null) return refuseOperation("The thread has no drive.");
      if (request.generation !== currentRow.generation) {
        return refuseOperation("A newer machine owns this thread now.", currentRow.generation);
      }
      if (
        !Number.isSafeInteger(snapshot.restored_generation) ||
        currentRow.generation < snapshot.restored_generation
      ) {
        return refuseOperation(
          "The thread generation predates this restore.",
          currentRow.generation,
        );
      }
      const currentThread = yield* input.ref(input.threadRef(request.threadId));
      const currentWip = yield* input.ref(input.wipRef(request.threadId));
      if (currentThread !== request.expectedThread || currentWip !== request.expectedWip) {
        return yield* operationResult("conflict", request.threadId);
      }
      if (
        currentRow.pinned_views !== snapshot.restored_pinned_views ||
        currentRow.revision !== snapshot.restored_revision
      ) {
        return yield* operationResult("conflict", request.threadId);
      }

      const savedThread = snapshot.before_thread_oid;
      const savedWip = snapshot.before_wip_oid;
      for (const [head, oid] of [
        ["thread", savedThread],
        ["wip", savedWip],
      ] as const) {
        if (oid === null) continue;
        const savedRef = DriveRevisions.restoreSnapshotRef(
          request.threadId,
          request.restoreOperationId,
          head,
        );
        if ((yield* input.internalRef(savedRef)) !== oid) {
          return refuseOperation("The saved pre-restore revision is no longer available.");
        }
      }

      const generation = currentRow.generation + 1;
      if (!Number.isSafeInteger(generation)) {
        return refuseOperation(
          "The thread generation can no longer advance safely.",
          currentRow.generation,
        );
      }
      const claimed =
        yield* sql`UPDATE drive_restore_snapshots SET undone_by = ${request.operationId}
        WHERE thread_id = ${request.threadId}
          AND restore_operation_id = ${request.restoreOperationId} AND undone_by IS NULL
        RETURNING restore_operation_id`;
      if (claimed.length === 0) {
        return refuseOperation("That restore has already been undone.");
      }
      if (currentThread !== null) {
        yield* input.setRef(
          DriveRevisions.restoreUndoRef(request.threadId, request.operationId, "thread"),
          currentThread,
          userId,
        );
      }
      if (currentWip !== null) {
        yield* input.setRef(
          DriveRevisions.restoreUndoRef(request.threadId, request.operationId, "wip"),
          currentWip,
          userId,
        );
      }
      yield* input.land(input.threadRef(request.threadId), currentThread, savedThread, { userId });
      if (savedWip === null) {
        yield* input.removeRef(input.wipRef(request.threadId));
      } else {
        yield* input.setRef(input.wipRef(request.threadId), savedWip, userId);
      }
      yield* sql`UPDATE threads SET generation = ${generation},
        pinned_views = ${snapshot.before_pinned_views}, revision = ${snapshot.before_revision}
        WHERE thread_id = ${request.threadId}`;
      yield* rememberOperation(request.threadId, request.operationId, "undo-restore", requestJson);
      const updated = yield* input.refs(request.threadId, 0);
      return { _tag: "ok", refs: updated, generation } as const;
    }).pipe(sql.withTransaction);

  const updateToLatest: (
    userId: string,
    request: UpdateToLatestRequest,
  ) => Effect.Effect<CheckpointOperationResult, SqlError> = (userId, request) =>
    Effect.gen(function* () {
      if (!canWrite(yield* input.role(userId))) return refuseOperation(NO_ACCESS_REASON);
      if (request.operationId === "" || !Number.isSafeInteger(request.generation)) {
        return refuseOperation("An operation id and current generation are required.");
      }
      const requestJson = DriveRevisions.encodeUpdateToLatestRequest({
        threadId: request.threadId,
        expectedThread: request.expectedThread,
        expectedWip: request.expectedWip,
        generation: request.generation,
      });
      const replay = yield* replayOperation(
        request.threadId,
        requestJson,
        "update-to-latest",
        request.operationId,
      );
      if (replay !== null) return replay;
      const currentRow = yield* input.threadRow(request.threadId);
      if (currentRow === null) return refuseOperation("The thread has no drive.");
      if (request.generation !== currentRow.generation) {
        return refuseOperation("A newer machine owns this thread now.", currentRow.generation);
      }
      const currentThread = yield* input.ref(input.threadRef(request.threadId));
      const currentWip = yield* input.ref(input.wipRef(request.threadId));
      if (currentThread !== request.expectedThread || currentWip !== request.expectedWip) {
        return yield* operationResult("conflict", request.threadId);
      }
      const generation = currentRow.generation + 1;
      if (!Number.isSafeInteger(generation)) {
        return refuseOperation(
          "The thread generation can no longer advance safely.",
          currentRow.generation,
        );
      }
      yield* sql`UPDATE threads SET pinned_views = NULL, generation = ${generation},
        revision = ${request.operationId} WHERE thread_id = ${request.threadId}`;
      const updated = yield* input.refs(request.threadId, 0);
      yield* rememberOperation(
        request.threadId,
        request.operationId,
        "update-to-latest",
        requestJson,
      );
      return { _tag: "ok", refs: updated, generation } as const;
    }).pipe(sql.withTransaction);

  return {
    recordCheckpoint,
    checkpoint,
    forkCheckpoint,
    restoreCheckpoint,
    undoRestore,
    updateToLatest,
  };
};
