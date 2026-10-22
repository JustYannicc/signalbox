import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { HarnessError } from "../Harness.ts";
import type { HarnessProcessStartup } from "../HarnessProcessLifetime.ts";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";

const harnessErrorCodec = Schema.toCodecJson(HarnessError);
const encodeHarnessError = Schema.encodeSync(harnessErrorCodec);

export function writeHostFailure(
  database: FacetStorage,
  bootAttemptId: string,
  runId: string | undefined,
  error: HarnessError,
): void {
  const errorJson = JSON.stringify(encodeHarnessError(error));
  if (errorJson === undefined) throw new Error("HarnessError codec produced no JSON.");
  database.transactionSync(() => {
    database.sql.exec(`
      CREATE TABLE IF NOT EXISTS harness_host_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        boot_attempt_id TEXT NOT NULL,
        run_id TEXT,
        error_json TEXT NOT NULL
      )
    `);
    database.sql.exec(
      "INSERT INTO harness_host_failures (boot_attempt_id, run_id, error_json) VALUES (?, ?, ?)",
      bootAttemptId,
      runId ?? null,
      errorJson,
    );
  });
}

export const closeFailedHostStart = (input: {
  readonly database: FacetStorage;
  readonly bootAttemptId: string;
  readonly runId: string | undefined;
  readonly operation: "open" | "turn";
  readonly cause: Cause.Cause<unknown>;
  readonly startup: () => HarnessProcessStartup | undefined;
  readonly cleanup: Effect.Effect<void, unknown>;
}) =>
  Effect.gen(function* () {
    const observed = yield* Effect.try(input.startup).pipe(Effect.exit);
    const nativeStartup = Exit.isSuccess(observed) ? observed.value : undefined;
    const closed = yield* Effect.exit(input.cleanup);
    const cleanupCause = Cause.combine(
      Exit.isFailure(observed) ? observed.cause : Cause.empty,
      Exit.isFailure(closed) ? closed.cause : Cause.empty,
    );
    const failure = new HarnessError({
      operation: input.operation,
      message:
        input.operation === "turn"
          ? "Native MCP configuration or turn start failed."
          : "Harness native acquisition failed.",
      cause: input.cause,
      ...(nativeStartup === undefined ? {} : { nativeStartup }),
      ...(cleanupCause.reasons.length === 0 ? {} : { cleanupCause }),
    });
    const journaled = yield* Effect.try(() =>
      writeHostFailure(input.database, input.bootAttemptId, input.runId, failure),
    ).pipe(Effect.exit);
    return Exit.isSuccess(journaled)
      ? failure
      : new HarnessError({
          operation: input.operation,
          message: failure.message,
          cause: input.cause,
          ...(nativeStartup === undefined ? {} : { nativeStartup }),
          cleanupCause: Cause.combine(cleanupCause, journaled.cause),
        });
  }).pipe(Effect.uninterruptible);
