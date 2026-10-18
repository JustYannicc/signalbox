import { canManageDrive, type SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import type { DriveRemote } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  DrivePublication,
  DrivePublicationRepository,
  DrivePublicationRequest,
  type BindPublicationRequest,
  type DrivePublicationResult,
  type RecordPublicationCreatedRequest,
} from "./DrivePublicationTypes.ts";

export interface PublicationOperations {
  readonly beginPublication: (
    userId: string,
    request: DrivePublicationRequest,
  ) => Effect.Effect<DrivePublicationResult, SqlError>;
  /** Claim immediately before every create POST; each call counts as another possible POST. */
  readonly markPublicationCreating: (
    userId: string,
    id: string,
  ) => Effect.Effect<DrivePublicationResult, SqlError>;
  /** Only after this caller's own POST definitively failed; never replay a past release after another claim. */
  readonly releasePublicationCreating: (
    userId: string,
    id: string,
  ) => Effect.Effect<DrivePublicationResult, SqlError>;
  readonly recordPublicationCreated: (
    userId: string,
    request: RecordPublicationCreatedRequest,
  ) => Effect.Effect<DrivePublicationResult, SqlError>;
  readonly bindPublication: (
    userId: string,
    request: BindPublicationRequest,
  ) => Effect.Effect<DrivePublicationResult, SqlError>;
  readonly finishPublication: (
    userId: string,
    id: string,
  ) => Effect.Effect<DrivePublicationResult, SqlError>;
}

export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE drive_repository_publication (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    receipt_json TEXT NOT NULL
  )`;
});

export const addCreationAttempts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE drive_repository_publication ADD COLUMN creation_attempts INTEGER DEFAULT 0`;
  // Legacy creating receipts may already have several outstanding or ambiguous POSTs.
  yield* sql`UPDATE drive_repository_publication SET creation_attempts = NULL
    WHERE json_extract(receipt_json, '$.phase') <> 'reserved'`;
  yield* sql`CREATE TABLE drive_publication_ids (operation_id TEXT PRIMARY KEY)`;
  yield* sql`INSERT INTO drive_publication_ids (operation_id)
    SELECT lower(json_extract(receipt_json, '$.id')) FROM drive_repository_publication`;
});

const receiptCodec = Schema.fromJsonString(DrivePublication);
const decodeReceipt = Schema.decodeUnknownSync(receiptCodec);
const encodeReceipt = Schema.encodeSync(receiptCodec);
const validRequest = Schema.is(DrivePublicationRequest);
const validRepository = Schema.is(DrivePublicationRepository);
const ok = (publication: DrivePublication): DrivePublicationResult => ({ _tag: "ok", publication });
const refused = (reason: string): DrivePublicationResult => ({ _tag: "refused", reason });
const normalize = (request: DrivePublicationRequest): DrivePublicationRequest => ({
  ...request,
  githubAccountLogin: request.githubAccountLogin.trim().toLowerCase(),
  owner: request.owner.trim().toLowerCase(),
  name: request.name.trim().toLowerCase(),
});
const sameRequest = (a: DrivePublicationRequest, b: DrivePublicationRequest) =>
  a.githubAccountId === b.githubAccountId &&
  a.githubAccountLogin === b.githubAccountLogin &&
  a.owner === b.owner &&
  a.name === b.name &&
  a.visibility === b.visibility &&
  a.remoteName === b.remoteName &&
  a.protocol === b.protocol &&
  a.branch === b.branch;
const matchesRemote = (publication: DrivePublication, remote: DriveRemote) =>
  publication.repository !== null &&
  remote.provider === "github" &&
  remote.repository.toLowerCase() === publication.repository.fullName.toLowerCase() &&
  remote.defaultBranch === publication.request.branch;
const sameRepository = (a: DrivePublicationRepository, b: DrivePublicationRepository) =>
  a.id === b.id &&
  a.fullName === b.fullName &&
  a.webUrl === b.webUrl &&
  a.httpsUrl === b.httpsUrl &&
  a.sshUrl === b.sshUrl;

/** All receipt changes and the remote binding share the drive's SQLite transaction. */
export const makeOperations = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly role: (userId: string) => Effect.Effect<SignalboxDriveRole | null, SqlError>;
  readonly main: Effect.Effect<string | null, SqlError>;
  readonly remote: Effect.Effect<DriveRemote | null, SqlError>;
  readonly setRemote: (remote: DriveRemote) => Effect.Effect<void, SqlError>;
}): PublicationOperations => {
  const { sql } = input;
  const read = sql<{ readonly receipt_json: string }>`SELECT receipt_json
    FROM drive_repository_publication WHERE singleton = 1`.pipe(
    Effect.map(([row]) => (row === undefined ? null : decodeReceipt(row.receipt_json))),
  );
  const save = (publication: DrivePublication, resetAttempts = false) =>
    sql`INSERT INTO drive_repository_publication (singleton, receipt_json)
      VALUES (1, ${encodeReceipt(publication)})
      ON CONFLICT (singleton) DO UPDATE SET receipt_json = excluded.receipt_json,
        creation_attempts = CASE WHEN ${resetAttempts ? 1 : 0} THEN 0 ELSE creation_attempts END`.pipe(
      Effect.as(ok(publication)),
    );
  const manages = (userId: string) => Effect.map(input.role(userId), canManageDrive);
  const noAccess = () => refused("Only the drive's current managers can publish it.");
  const unrelatedRemote = () => refused("This drive is already backed by a different remote.");

  const beginPublication: PublicationOperations["beginPublication"] = (userId, request) =>
    Effect.gen(function* () {
      if (!(yield* manages(userId))) return noAccess();
      if (!validRequest(request)) return refused("The publication request is invalid.");
      const normalized = normalize(request);
      if (
        !Number.isSafeInteger(normalized.githubAccountId) ||
        normalized.githubAccountId <= 0 ||
        !/^[a-z0-9-]+$/.test(normalized.githubAccountLogin) ||
        !/^[a-z0-9-]+$/.test(normalized.owner) ||
        !/^[a-z0-9_.-]+$/.test(normalized.name) ||
        normalized.name === "." ||
        normalized.name === ".." ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(normalized.remoteName)
      )
        return refused("The publication needs a GitHub account, repository and remote name.");
      const existing = yield* read;
      const changedRequest =
        existing !== null &&
        (existing.userId !== userId || !sameRequest(existing.request, normalized));
      if (changedRequest && existing.phase !== "reserved") {
        return refused("Repository creation has started. Resume the original publication request.");
      }
      if (changedRequest && existing.id.toLowerCase() === normalized.operationId.toLowerCase()) {
        return refused("A changed publication request needs a new operation id.");
      }
      const remote = yield* input.remote;
      if (remote !== null && (existing === null || !matchesRemote(existing, remote))) {
        return unrelatedRemote();
      }
      if (existing !== null && !changedRequest) return ok(existing);
      const reused = yield* sql`SELECT operation_id FROM drive_publication_ids
        WHERE operation_id = ${normalized.operationId.toLowerCase()}`;
      if (reused.length > 0)
        return refused("That publication operation id has already been replaced.");
      yield* sql`INSERT INTO drive_publication_ids (operation_id) VALUES (${normalized.operationId.toLowerCase()})`;
      return yield* save(
        {
          id: normalized.operationId,
          userId,
          request: normalized,
          phase: "reserved",
          repository: null,
          head: null,
        },
        true,
      );
    }).pipe(sql.withTransaction);

  const change = (
    userId: string,
    id: string,
    update: (publication: DrivePublication) => Effect.Effect<DrivePublicationResult, SqlError>,
  ) =>
    Effect.gen(function* () {
      if (!(yield* manages(userId))) return noAccess();
      const publication = yield* read;
      if (publication === null || publication.id !== id) {
        return refused("That publication receipt does not exist.");
      }
      if (publication.userId !== userId)
        return refused("Only the initiating user can resume this publication.");
      return yield* update(publication);
    }).pipe(sql.withTransaction);

  return {
    beginPublication,
    markPublicationCreating: (userId, id) =>
      change(userId, id, (publication) =>
        Effect.gen(function* () {
          if (publication.phase !== "reserved" && publication.phase !== "creating")
            return ok(publication);
          // Each successful claim permits one POST. NULL preserves unknown legacy attempts.
          yield* sql`UPDATE drive_repository_publication
            SET creation_attempts = creation_attempts + 1 WHERE singleton = 1`;
          return yield* save({ ...publication, phase: "creating" });
        }),
      ),
    releasePublicationCreating: (userId, id) =>
      change(userId, id, (publication) =>
        Effect.gen(function* () {
          if (publication.phase !== "creating" || publication.repository !== null) {
            return refused("Only an unrecorded creating publication can be released.");
          }
          const [row] = yield* sql<{ readonly creation_attempts: number | null }>`
            SELECT creation_attempts FROM drive_repository_publication WHERE singleton = 1`;
          if (row?.creation_attempts !== 1) {
            return refused(
              "Other or unknown creation attempts may still create this repository. Resume this publication.",
            );
          }
          // The caller must prove its sole POST definitively failed before releasing it.
          return yield* save({ ...publication, phase: "reserved" }, true);
        }),
      ),
    recordPublicationCreated: (userId, request) =>
      change(userId, request.id, (publication) =>
        Effect.gen(function* () {
          const repository = request.repository;
          if (
            !validRepository(repository) ||
            !Number.isSafeInteger(repository.id) ||
            repository.id <= 0 ||
            repository.fullName.toLowerCase() !==
              `${publication.request.owner}/${publication.request.name}` ||
            repository.webUrl === "" ||
            repository.httpsUrl === "" ||
            repository.sshUrl === ""
          ) {
            return refused("The created repository does not match this publication.");
          }
          if (publication.repository !== null)
            return sameRepository(publication.repository, repository)
              ? ok(publication)
              : refused("This publication already recorded a different repository.");
          if (publication.phase !== "creating")
            return refused("Mark this publication creating before recording its repository.");
          return yield* save({ ...publication, phase: "created", repository });
        }),
      ),
    bindPublication: (userId, request) =>
      change(userId, request.id, (publication) =>
        Effect.gen(function* () {
          if (
            publication.repository === null ||
            publication.phase === "reserved" ||
            publication.phase === "creating"
          ) {
            return refused("Record the created repository before binding this drive.");
          }
          const remote = yield* input.remote;
          if (remote !== null && !matchesRemote(publication, remote)) return unrelatedRemote();
          if (publication.phase === "bound" || publication.phase === "complete") {
            if (remote === null) return refused("The publication's remote binding is missing.");
            return ok(publication);
          }
          if ((yield* input.main) !== request.expectedMain)
            return refused(
              "The drive's main changed before publication binding. Retry with its current head.",
            );
          yield* input.setRemote({
            provider: "github",
            repository: publication.repository.fullName,
            defaultBranch: publication.request.branch,
          });
          return yield* save({ ...publication, phase: "bound", head: request.expectedMain });
        }),
      ),
    finishPublication: (userId, id) =>
      change(userId, id, (publication) =>
        Effect.gen(function* () {
          if (publication.phase !== "bound" && publication.phase !== "complete") {
            return refused("Bind the drive before completing publication.");
          }
          const remote = yield* input.remote;
          if (remote === null || !matchesRemote(publication, remote)) return unrelatedRemote();
          return publication.phase === "complete"
            ? ok(publication)
            : yield* save({ ...publication, phase: "complete" });
        }),
      ),
  };
};
