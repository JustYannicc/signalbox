import { AutomationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export interface WorkflowAttemptKey {
  readonly projectId: string;
  readonly repository: string;
  readonly workflowFile: string;
  readonly correlationId: string;
  readonly headSha: string;
}

export interface IssueAttemptKey {
  readonly projectId: string;
  readonly repository: string;
  readonly correlationId: string;
}

export type Attempt =
  | { readonly _tag: "claimed"; readonly requestHash: string }
  | { readonly _tag: "pending"; readonly requestHash: string }
  | {
      readonly _tag: "completed";
      readonly requestHash: string;
      readonly resultJson: string;
    };

export interface GitHubOperationJournal {
  readonly claimWorkflow: (
    input: WorkflowAttemptKey & { readonly request: unknown },
  ) => Effect.Effect<Attempt, AutomationError>;
  readonly completeWorkflow: (
    input: WorkflowAttemptKey & { readonly requestHash: string; readonly result: unknown },
  ) => Effect.Effect<void, AutomationError>;
  readonly releaseWorkflow: (
    input: WorkflowAttemptKey & { readonly requestHash: string },
  ) => Effect.Effect<void, AutomationError>;
  readonly claimIssue: (
    input: IssueAttemptKey & { readonly request: unknown },
  ) => Effect.Effect<Attempt, AutomationError>;
  readonly completeIssue: (
    input: IssueAttemptKey & { readonly requestHash: string; readonly result: unknown },
  ) => Effect.Effect<void, AutomationError>;
  readonly releaseIssue: (
    input: IssueAttemptKey & { readonly requestHash: string },
  ) => Effect.Effect<void, AutomationError>;
}

const failed = (message: string, cause?: unknown) =>
  new AutomationError({ message, ...(cause === undefined ? {} : { cause }) });

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isAutomationError = Schema.is(AutomationError);

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
};

const serialize = (value: unknown) =>
  Effect.try({
    try: () => encodeJson(canonicalValue(value)),
    catch: (cause) => failed("Couldn't record the GitHub operation.", cause),
  });

const workflowTableSchema = String.raw`
  CREATE TABLE IF NOT EXISTS github_workflow_dispatch_attempts (
    project_id TEXT NOT NULL,
    repository TEXT NOT NULL,
    workflow_file TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
    result_json TEXT,
    PRIMARY KEY (project_id, repository, workflow_file, correlation_id, head_sha)
  );
`;

const issueTableSchema = String.raw`
  CREATE TABLE IF NOT EXISTS github_issue_create_attempts (
    project_id TEXT NOT NULL,
    repository TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
    result_json TEXT,
    PRIMARY KEY (project_id, repository, correlation_id)
  );
`;

export const makeGitHubOperationJournal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  yield* sql
    .unsafe(workflowTableSchema)
    .pipe(
      Effect.mapError((cause) => failed("Couldn't initialize GitHub workflow attempts.", cause)),
    );
  yield* sql
    .unsafe(issueTableSchema)
    .pipe(
      Effect.mapError((cause) => failed("Couldn't initialize GitHub operation records.", cause)),
    );

  const requestHash = (request: unknown) =>
    serialize(request).pipe(
      Effect.flatMap((text) =>
        crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(
          Effect.map(Hex.encode),
          Effect.mapError((cause) => failed("Couldn't fingerprint the GitHub operation.", cause)),
        ),
      ),
    );

  const claim = <Key extends { readonly request: unknown }>(
    input: Key,
    insert: (
      hash: string,
    ) => Effect.Effect<ReadonlyArray<{ readonly request_hash: string }>, SqlError>,
    lookup: () => Effect.Effect<
      ReadonlyArray<{
        readonly request_hash: string;
        readonly status: "pending" | "completed";
        readonly result_json: string | null;
      }>,
      SqlError
    >,
  ): Effect.Effect<Attempt, AutomationError> =>
    Effect.gen(function* () {
      const hash = yield* requestHash(input.request);
      const inserted = yield* insert(hash);
      if (inserted.length > 0) return { _tag: "claimed", requestHash: hash } as const;

      const [row] = yield* lookup();
      if (row === undefined) return yield* failed("The GitHub operation record disappeared.");
      if (row.request_hash !== hash)
        return yield* failed("This GitHub correlation ID already belongs to different input.");
      if (row.status === "pending") return { _tag: "pending", requestHash: hash } as const;
      if (row.result_json === null)
        return yield* failed("The completed GitHub operation has no saved result.");
      return { _tag: "completed", requestHash: hash, resultJson: row.result_json } as const;
    }).pipe(
      Effect.mapError((cause) =>
        isAutomationError(cause) ? cause : failed("Couldn't claim the GitHub operation.", cause),
      ),
    );

  const complete = (
    update: (
      resultJson: string,
    ) => Effect.Effect<ReadonlyArray<{ readonly result_json: string }>, SqlError>,
    lookup: () => Effect.Effect<
      ReadonlyArray<{
        readonly request_hash: string;
        readonly status: "pending" | "completed";
        readonly result_json: string | null;
      }>,
      SqlError
    >,
    expectedHash: string,
    result: unknown,
  ) =>
    Effect.gen(function* () {
      const resultJson = yield* serialize(result);
      const updated = yield* update(resultJson);
      if (updated.length > 0) return;

      const [row] = yield* lookup();
      if (row?.request_hash === expectedHash && row.status === "completed") return;
      return yield* failed("The GitHub operation record changed before completion.");
    }).pipe(
      Effect.mapError((cause) =>
        isAutomationError(cause)
          ? cause
          : failed("Couldn't complete the GitHub operation record.", cause),
      ),
    );

  const release = (deleteRow: () => Effect.Effect<unknown, SqlError>, what: string) =>
    deleteRow().pipe(
      Effect.asVoid,
      Effect.mapError((cause) => failed(`Couldn't release the ${what} record.`, cause)),
    );

  const workflowLookup = (input: WorkflowAttemptKey) =>
    sql<{
      readonly request_hash: string;
      readonly status: "pending" | "completed";
      readonly result_json: string | null;
    }>`SELECT request_hash, status, result_json
      FROM github_workflow_dispatch_attempts
      WHERE project_id = ${input.projectId} AND repository = ${input.repository}
        AND workflow_file = ${input.workflowFile} AND correlation_id = ${input.correlationId}
        AND head_sha = ${input.headSha}`;

  const issueLookup = (input: IssueAttemptKey) =>
    sql<{
      readonly request_hash: string;
      readonly status: "pending" | "completed";
      readonly result_json: string | null;
    }>`SELECT request_hash, status, result_json
      FROM github_issue_create_attempts
      WHERE project_id = ${input.projectId} AND repository = ${input.repository}
        AND correlation_id = ${input.correlationId}`;

  return {
    claimWorkflow: (input: WorkflowAttemptKey & { readonly request: unknown }) =>
      claim(
        input,
        (hash) => sql<{ readonly request_hash: string }>`
          INSERT INTO github_workflow_dispatch_attempts
            (project_id, repository, workflow_file, correlation_id, head_sha, request_hash, status)
          VALUES (${input.projectId}, ${input.repository}, ${input.workflowFile},
            ${input.correlationId}, ${input.headSha}, ${hash}, 'pending')
          ON CONFLICT (project_id, repository, workflow_file, correlation_id, head_sha)
          DO NOTHING RETURNING request_hash`,
        () => workflowLookup(input),
      ),
    completeWorkflow: (input) =>
      complete(
        (resultJson) => sql<{ readonly result_json: string }>`
          UPDATE github_workflow_dispatch_attempts
          SET status = 'completed', result_json = ${resultJson}
          WHERE project_id = ${input.projectId} AND repository = ${input.repository}
            AND workflow_file = ${input.workflowFile} AND correlation_id = ${input.correlationId}
            AND head_sha = ${input.headSha} AND request_hash = ${input.requestHash}
            AND status = 'pending'
          RETURNING result_json`,
        () => workflowLookup(input),
        input.requestHash,
        input.result,
      ),
    releaseWorkflow: (input) =>
      release(
        () =>
          sql`DELETE FROM github_workflow_dispatch_attempts
            WHERE project_id = ${input.projectId} AND repository = ${input.repository}
              AND workflow_file = ${input.workflowFile} AND correlation_id = ${input.correlationId}
              AND head_sha = ${input.headSha} AND request_hash = ${input.requestHash}
              AND status = 'pending'`,
        "workflow dispatch",
      ),
    claimIssue: (input: IssueAttemptKey & { readonly request: unknown }) =>
      claim(
        input,
        (hash) => sql<{ readonly request_hash: string }>`
          INSERT INTO github_issue_create_attempts
            (project_id, repository, correlation_id, request_hash, status)
          VALUES (${input.projectId}, ${input.repository}, ${input.correlationId}, ${hash}, 'pending')
          ON CONFLICT (project_id, repository, correlation_id)
          DO NOTHING RETURNING request_hash`,
        () => issueLookup(input),
      ),
    completeIssue: (input) =>
      complete(
        (resultJson) => sql<{ readonly result_json: string }>`
          UPDATE github_issue_create_attempts
          SET status = 'completed', result_json = ${resultJson}
          WHERE project_id = ${input.projectId} AND repository = ${input.repository}
            AND correlation_id = ${input.correlationId} AND request_hash = ${input.requestHash}
            AND status = 'pending'
          RETURNING result_json`,
        () => issueLookup(input),
        input.requestHash,
        input.result,
      ),
    releaseIssue: (input) =>
      release(
        () =>
          sql`DELETE FROM github_issue_create_attempts
            WHERE project_id = ${input.projectId} AND repository = ${input.repository}
              AND correlation_id = ${input.correlationId} AND request_hash = ${input.requestHash}
              AND status = 'pending'`,
        "issue creation",
      ),
  } satisfies GitHubOperationJournal;
});
