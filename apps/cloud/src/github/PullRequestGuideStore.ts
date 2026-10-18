import { PullRequestRef, PullRequestReviewGuide } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const ReferenceJson = Schema.fromJsonString(PullRequestRef);
const GuideJson = Schema.fromJsonString(PullRequestReviewGuide);
const encodeReference = Schema.encodeSync(ReferenceJson);
const decodeReference = Schema.decodeSync(ReferenceJson);
const encodeGuide = Schema.encodeSync(GuideJson);
const decodeGuide = Schema.decodeSync(GuideJson);

type JobRow = {
  readonly id: string;
  readonly scope: string;
  readonly reference: string;
  readonly account_id: string;
  readonly head_sha: string;
  readonly status: "queued" | "running" | "finished" | "failed";
  readonly created_at: number;
  readonly finished_at: number | null;
  readonly deadline_at: number | null;
  readonly detail: string | null;
  readonly guide: string | null;
};

export const makePullRequestGuideStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS pull_request_guide_jobs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL,
    reference TEXT NOT NULL,
    account_id TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'finished', 'failed')),
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    deadline_at INTEGER,
    detail TEXT,
    guide TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS pull_request_guide_scope
    ON pull_request_guide_jobs (scope, sequence)`;
  yield* sql`CREATE TABLE IF NOT EXISTS pull_request_guide_requests (
    operation_id TEXT PRIMARY KEY,
    request TEXT NOT NULL,
    job_id TEXT NOT NULL
  )`;

  const job = (row: JobRow) => ({ ...row, reference: decodeReference(row.reference) });
  const lookup = (operationId: string, request: string) =>
    sql<{ readonly request: string; readonly job_id: string }>`
      SELECT request, job_id FROM pull_request_guide_requests
      WHERE operation_id = ${operationId}`.pipe(
      Effect.map(([row]) =>
        row === undefined
          ? ({ _tag: "new" } as const)
          : row.request === request
            ? ({ _tag: "replay", jobId: row.job_id } as const)
            : ({ _tag: "conflict" } as const),
      ),
    );

  const claim = (input: {
    readonly operationId: string;
    readonly request: string;
    readonly scope: string;
    readonly reference: PullRequestRef;
    readonly accountId: string;
    readonly headSha: string;
    readonly now: number;
  }) =>
    Effect.gen(function* () {
      const existing = yield* lookup(input.operationId, input.request);
      if (existing._tag !== "new") return existing;
      const [running] = yield* sql<{ readonly id: string }>`
        SELECT id FROM pull_request_guide_jobs
        WHERE scope = ${input.scope} AND head_sha = ${input.headSha}
          AND status IN ('queued', 'running') ORDER BY sequence DESC LIMIT 1`;
      const jobId = running?.id ?? input.operationId;
      if (running === undefined) {
        yield* sql`INSERT INTO pull_request_guide_jobs
          (id, scope, reference, account_id, head_sha, status, created_at)
          VALUES (${jobId}, ${input.scope}, ${encodeReference(input.reference)},
            ${input.accountId}, ${input.headSha}, 'queued', ${input.now})`;
      }
      yield* sql`INSERT INTO pull_request_guide_requests (operation_id, request, job_id)
        VALUES (${input.operationId}, ${input.request}, ${jobId})`;
      return { _tag: "claimed", jobId, started: running === undefined } as const;
    }).pipe(sql.withTransaction);

  const snapshot = (scope: string) =>
    Effect.gen(function* () {
      const [latest] = yield* sql<JobRow>`SELECT * FROM pull_request_guide_jobs
        WHERE scope = ${scope} ORDER BY sequence DESC LIMIT 1`;
      const [finished] = yield* sql<{ readonly guide: string }>`
        SELECT guide FROM pull_request_guide_jobs WHERE scope = ${scope}
          AND status = 'finished' ORDER BY sequence DESC LIMIT 1`;
      return {
        guide: finished === undefined ? null : decodeGuide(finished.guide),
        latest: latest === undefined ? null : job(latest),
      };
    }).pipe(sql.withTransaction);

  // A lost model response cannot be recovered safely. Keep the failure as a receipt;
  // only a new explicit request may spend on another completion.
  const expire = (now: number) =>
    sql<{ readonly reference: string }>`UPDATE pull_request_guide_jobs
        SET status = 'failed', finished_at = ${now}, detail = 'Guide generation was interrupted. Generate it again.'
        WHERE status = 'running' AND deadline_at <= ${now} RETURNING reference`.pipe(
      Effect.map((rows) => rows.map((row) => decodeReference(row.reference))),
    );
  const startNext = (deadline: number) =>
    sql<JobRow>`UPDATE pull_request_guide_jobs
        SET status = 'running', deadline_at = ${deadline}
        WHERE id = (SELECT id FROM pull_request_guide_jobs WHERE status = 'queued'
          ORDER BY sequence LIMIT 1) AND status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM pull_request_guide_jobs WHERE status = 'running')
        RETURNING *`.pipe(Effect.map(([next]) => (next === undefined ? null : job(next))));

  const finish = (id: string, guide: PullRequestReviewGuide, now: number) =>
    sql`UPDATE pull_request_guide_jobs
      SET status = 'finished', guide = ${encodeGuide(guide)}, finished_at = ${now}, deadline_at = NULL
      WHERE id = ${id} AND status = 'running'`.pipe(Effect.asVoid);
  const fail = (id: string, detail: string, now: number) =>
    sql`UPDATE pull_request_guide_jobs
      SET status = 'failed', detail = ${detail}, finished_at = ${now}, deadline_at = NULL
      WHERE id = ${id} AND status = 'running'`.pipe(Effect.asVoid);
  const nextWake = sql<{ readonly next_at: number | null }>`
    SELECT COALESCE(
      (SELECT MIN(deadline_at) FROM pull_request_guide_jobs WHERE status = 'running'),
      (SELECT MIN(created_at) FROM pull_request_guide_jobs WHERE status = 'queued')
    ) AS next_at`.pipe(Effect.map(([row]) => row?.next_at ?? null));

  return { lookup, claim, snapshot, expire, startNext, finish, fail, nextWake };
});
