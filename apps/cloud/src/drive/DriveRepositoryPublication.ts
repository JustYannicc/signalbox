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
  readonly markPublicationCreating: (
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
  const save = (publication: DrivePublication) =>
    sql`INSERT INTO drive_repository_publication (singleton, receipt_json)
      VALUES (1, ${encodeReceipt(publication)})
      ON CONFLICT (singleton) DO UPDATE SET receipt_json = excluded.receipt_json`.pipe(
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
      if (
        existing !== null &&
        (existing.userId !== userId ||
          existing.request.githubAccountId !== normalized.githubAccountId ||
          existing.request.githubAccountLogin !== normalized.githubAccountLogin)
      ) {
        return refused("This drive already has a publication for a different user or account.");
      }
      const changedRequest = existing !== null && !sameRequest(existing.request, normalized);
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
      return yield* save({
        id: normalized.operationId,
        userId,
        request: normalized,
        phase: "reserved",
        repository: null,
        head: null,
      });
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
        publication.phase === "reserved"
          ? save({ ...publication, phase: "creating" })
          : Effect.succeed(ok(publication)),
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
