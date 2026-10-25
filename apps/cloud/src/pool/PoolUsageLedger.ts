import { NonNegativeInt, UsageTokenTotals } from "@t3tools/contracts";
import { FolderLevel } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Id = Schema.NonEmptyString;
const Amount = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Percent = Amount.check(Schema.isLessThanOrEqualTo(100));
const Identity = { poolOwnerId: Id, poolId: Id, userId: Id };

/** Captured with the token-selected pool; moving a thread cannot rewrite its old usage. */
const Attribution = Schema.Union([
  Schema.TaggedStruct("thread", {
    ...Identity,
    homeOwnerId: Id,
    homeLevel: FolderLevel,
    poolLevel: FolderLevel,
    threadId: Id,
    runId: Id,
    visibility: Schema.Literals(["private", "shared"]),
  }),
  Schema.TaggedStruct("local", { ...Identity, keyId: Id }),
  Schema.TaggedStruct("completion", Identity),
]);

/** No title, prompt, path, response text or credential is part of a retained row. */
export const UsageRequest = Schema.Struct({
  source: Id,
  requestId: Id,
  at: NonNegativeInt,
  attribution: Attribution,
  provider: Id,
  harness: Schema.NullOr(Id),
  accountId: Schema.NullOr(Id),
  lenderId: Schema.NullOr(Id),
  requestedModel: Schema.NullOr(Id),
  responseModel: Schema.NullOr(Id),
  reasoningEffort: Schema.NullOr(Id),
  serviceTier: Schema.NullOr(Id),
  stream: Schema.NullOr(Schema.Boolean),
  status: Schema.NullOr(NonNegativeInt.check(Schema.isLessThanOrEqualTo(599))),
  outcome: Schema.Literals(["complete", "cancelled", "failed"]),
  latencyMs: Schema.NullOr(Amount),
  ttftMs: Schema.NullOr(Amount),
  tokens: Schema.NullOr(UsageTokenTotals),
  quotaAfter: Schema.NullOr(
    Schema.Struct({
      fiveHourUsedPercent: Schema.NullOr(Percent),
      weeklyUsedPercent: Schema.NullOr(Percent),
    }),
  ),
  pricing: Schema.NullOr(Schema.Struct({ version: Id, costUsd: Amount })),
});
export type UsageRequest = typeof UsageRequest.Type;

export class UsageLedgerInputError extends Schema.TaggedError<UsageLedgerInputError>()(
  "UsageLedgerInputError",
  { operation: Schema.Literals(["append", "page"]), cause: Schema.Defect() },
) {
  override get message() {
    return "Invalid pool usage ledger input.";
  }
}

/** The pool owns this table independently of thread diagnostics and quota-history retention. */
export const createTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE usage_ledger (
    source TEXT NOT NULL,
    request_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    thread_id TEXT,
    run_id TEXT,
    record TEXT NOT NULL,
    PRIMARY KEY (source, request_id)
  )`;
  yield* sql`CREATE INDEX usage_ledger_at ON usage_ledger (at, source, request_id)`;
  yield* sql`CREATE INDEX usage_ledger_user ON usage_ledger (user_id, at)`;
});

const decodeRequest = Schema.decodeUnknownEffect(UsageRequest);
const RequestJson = Schema.fromJsonString(UsageRequest);
const encodeRequest = Schema.encodeEffect(RequestJson);
const decodeStoredRequest = Schema.decodeUnknownEffect(RequestJson);

/** First delivery wins. Retried upstream IDs cannot change attribution or count a request twice. */
export const append = (input: unknown) =>
  Effect.gen(function* () {
    const request = yield* decodeRequest(input).pipe(
      Effect.mapError((cause) => new UsageLedgerInputError({ operation: "append", cause })),
    );
    const record = yield* encodeRequest(request).pipe(Effect.orDie);
    const sql = yield* SqlClient.SqlClient;
    const thread = request.attribution._tag === "thread" ? request.attribution : null;
    const inserted = yield* sql`INSERT INTO usage_ledger
      (source, request_id, at, user_id, thread_id, run_id, record)
      VALUES (${request.source}, ${request.requestId}, ${request.at},
        ${request.attribution.userId}, ${thread?.threadId ?? null}, ${thread?.runId ?? null}, ${record})
      ON CONFLICT (source, request_id) DO NOTHING RETURNING request_id`;
    return inserted.length > 0;
  });

const Cursor = Schema.Struct({ at: NonNegativeInt, source: Id, requestId: Id });
const PageInput = Schema.Struct({
  since: NonNegativeInt,
  until: NonNegativeInt,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
  after: Schema.optionalKey(Cursor),
}).check(Schema.makeFilter((input) => input.until >= input.since));
export type PageInput = typeof PageInput.Type;
const decodePageInput = Schema.decodeUnknownEffect(PageInput);

/** Internal to the pool. User-facing reads must apply their role and visibility projection. */
export const page = (input: PageInput) =>
  Effect.gen(function* () {
    const { since, until, limit, after } = yield* decodePageInput(input).pipe(
      Effect.mapError((cause) => new UsageLedgerInputError({ operation: "page", cause })),
    );
    const sql = yield* SqlClient.SqlClient;
    const cursor =
      after === undefined
        ? sql`1 = 1`
        : sql`(at, source, request_id) > (${after.at}, ${after.source}, ${after.requestId})`;
    const rows = yield* sql<{ record: string }>`SELECT record FROM usage_ledger
      WHERE at >= ${since} AND at < ${until} AND ${cursor}
      ORDER BY at, source, request_id LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const requests = yield* Effect.forEach(rows.slice(0, limit), ({ record }) =>
      decodeStoredRequest(record).pipe(Effect.orDie),
    );
    const last = requests.at(-1);
    return {
      requests,
      next:
        hasMore && last !== undefined
          ? { at: last.at, source: last.source, requestId: last.requestId }
          : null,
    };
  });
