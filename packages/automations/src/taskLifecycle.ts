import { AutomationError } from "@t3tools/contracts";
import {
  TaskLifecycleDoneCondition as TaskLifecycleDoneConditionSchema,
  TaskLifecycleSettleReason as TaskLifecycleSettleReasonSchema,
} from "@t3tools/contracts/taskLifecycle";
import type {
  TaskLifecycleDoneCondition,
  TaskLifecycleInput,
  TaskLifecycleRecord,
  TaskLifecycleSettlementHistoryEntry,
  TaskLifecycleSettleReason,
} from "@t3tools/contracts/taskLifecycle";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

interface TaskLifecycleRow {
  readonly thread_id: string;
  readonly condition_json: string | null;
  readonly outcome: string | null;
  readonly settled_reason: string | null;
  readonly uncertain: number;
  readonly settled_at: string | null;
  readonly generation: number;
  readonly updated_at: string;
}

interface CommandRow {
  readonly thread_id: string;
  readonly action: string;
}

interface SettlementHistoryRow {
  readonly outcome: string | null;
  readonly reason: TaskLifecycleSettleReason;
  readonly uncertain: number;
  readonly settled_at: string;
  readonly generation: number;
  readonly recorded_at: string;
}

export interface TaskLifecycleStoreResult {
  readonly record: TaskLifecycleRecord | null;
  readonly applied: boolean;
}

type MutationFields = Omit<TaskLifecycleInput, "action">;

export type TaskLifecycleProposeInput = MutationFields & { readonly summary: string };
export type TaskLifecycleOutcomeInput = MutationFields & { readonly outcome?: string };
export type TaskLifecycleReopenInput = Pick<
  TaskLifecycleInput,
  "threadId" | "expectedGeneration" | "expectedUpdatedAt" | "commandId"
>;

export interface TaskLifecycleStore {
  readonly read: (threadId: string) => Effect.Effect<TaskLifecycleRecord | null, AutomationError>;
  readonly setConditionRunId: (
    threadId: string,
    expectedGeneration: number,
    runId: string,
  ) => Effect.Effect<boolean, AutomationError>;
  readonly apply: (
    input: TaskLifecycleInput,
  ) => Effect.Effect<TaskLifecycleStoreResult, AutomationError>;
  readonly propose: (
    input: TaskLifecycleProposeInput,
  ) => Effect.Effect<TaskLifecycleStoreResult, AutomationError>;
  readonly complete: (
    input: TaskLifecycleOutcomeInput,
  ) => Effect.Effect<TaskLifecycleStoreResult, AutomationError>;
  readonly recordSettle: (
    input: TaskLifecycleOutcomeInput & { readonly reason: TaskLifecycleSettleReason },
  ) => Effect.Effect<TaskLifecycleStoreResult, AutomationError>;
  readonly recordOutcome: (
    input: TaskLifecycleOutcomeInput,
  ) => Effect.Effect<TaskLifecycleStoreResult, AutomationError>;
  readonly reopen: (
    input: TaskLifecycleReopenInput,
  ) => Effect.Effect<TaskLifecycleStoreResult, AutomationError>;
}

const recordTable = "signalbox_automation_task_lifecycle";
const commandTable = "signalbox_automation_task_lifecycle_commands";
const TaskLifecycleDoneConditionJson = Schema.fromJsonString(TaskLifecycleDoneConditionSchema);
const decodeTaskLifecycleDoneCondition = Schema.decodeUnknownEffect(TaskLifecycleDoneConditionJson);
const encodeTaskLifecycleDoneCondition = Schema.encodeEffect(TaskLifecycleDoneConditionJson);
const decodeTaskLifecycleDoneConditionSync = Schema.decodeUnknownSync(
  TaskLifecycleDoneConditionSchema,
);
const decodeTaskLifecycleSettleReasonSync = Schema.decodeUnknownSync(
  TaskLifecycleSettleReasonSchema,
);

const recordFromRow = (
  row: TaskLifecycleRow | null,
  settlements: ReadonlyArray<SettlementHistoryRow>,
): TaskLifecycleRecord | null => {
  if (row === null) return null;
  return {
    threadId: row.thread_id,
    condition:
      row.condition_json === null
        ? null
        : decodeTaskLifecycleDoneConditionSync(JSON.parse(row.condition_json)),
    outcome: row.outcome,
    reason:
      row.settled_reason === null ? null : decodeTaskLifecycleSettleReasonSync(row.settled_reason),
    uncertain: row.uncertain === 1,
    settledAt: row.settled_at,
    generation: row.generation,
    updatedAt: row.updated_at,
    settlementHistory: settlements.map((settlement): TaskLifecycleSettlementHistoryEntry => ({
      outcome: settlement.outcome,
      reason: settlement.reason,
      uncertain: settlement.uncertain === 1,
      settledAt: settlement.settled_at,
      generation: settlement.generation,
      recordedAt: settlement.recorded_at,
    })),
  };
};

const expectedMatches = (input: TaskLifecycleInput, row: TaskLifecycleRow | null) => {
  if (
    input.expectedGeneration !== undefined &&
    (row?.generation ?? 0) !== input.expectedGeneration
  ) {
    return false;
  }
  if (input.expectedUpdatedAt !== undefined && row?.updated_at !== input.expectedUpdatedAt) {
    return false;
  }
  return true;
};

const conditionFrom = (input: TaskLifecycleInput): TaskLifecycleDoneCondition | null => {
  if (input.summary === undefined) return null;
  return {
    summary: input.summary,
    automationId: input.automationId ?? null,
    runId: input.runId ?? null,
    ...(input.input === undefined ? {} : { input: input.input }),
  };
};

/** Per-thread task state on the automation host's SQLite database. */
export const makeTaskRecords = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const run = <A>(operation: string, statement: Effect.Effect<A, SqlError>) =>
    statement.pipe(
      Effect.mapError(
        (cause) =>
          new AutomationError({ message: `Task lifecycle storage failed (${operation}).`, cause }),
      ),
    );
  const transaction = <A>(
    operation: string,
    effect: Effect.Effect<A, AutomationError | SqlError>,
  ) =>
    sql.withTransaction(effect).pipe(
      Effect.mapError((cause) =>
        cause._tag === "AutomationError"
          ? cause
          : new AutomationError({
              message: `Task lifecycle storage failed (${operation}).`,
              cause,
            }),
      ),
    );

  yield* run(
    "createTable",
    sql`
      CREATE TABLE IF NOT EXISTS ${sql(recordTable)} (
        thread_id TEXT PRIMARY KEY NOT NULL,
        condition_json TEXT,
        outcome TEXT,
        settled_reason TEXT CHECK (settled_reason IS NULL OR settled_reason IN ('dropped', 'done-enough')),
        uncertain INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0, 1)),
        settled_at TEXT,
        generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
        updated_at TEXT NOT NULL
      )
    `,
  );
  yield* run(
    "createCommandTable",
    sql`
      CREATE TABLE IF NOT EXISTS ${sql(commandTable)} (
        command_id TEXT PRIMARY KEY NOT NULL,
        thread_id TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `,
  );
  yield* run(
    "createSettlementHistoryTable",
    sql`
      CREATE TABLE IF NOT EXISTS signalbox_automation_task_lifecycle_settlements (
        thread_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        outcome TEXT,
        reason TEXT NOT NULL CHECK (reason IN ('dropped', 'done-enough')),
        uncertain INTEGER NOT NULL CHECK (uncertain IN (0, 1)),
        settled_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, generation)
      )
    `,
  );

  const readRow = (threadId: string) =>
    sql<TaskLifecycleRow>`SELECT * FROM ${sql(recordTable)} WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    );

  const readRecord = (threadId: string) =>
    Effect.gen(function* () {
      const row = yield* readRow(threadId);
      if (row === null) return null;
      const settlements = yield* sql<SettlementHistoryRow>`
        SELECT outcome, reason, uncertain, settled_at, generation, recorded_at
        FROM signalbox_automation_task_lifecycle_settlements
        WHERE thread_id = ${threadId}
        ORDER BY generation
      `;
      return recordFromRow(row, settlements);
    });

  const read = (threadId: string) => run("read", readRecord(threadId));

  const mutate = (
    input: TaskLifecycleInput,
    update: (
      current: TaskLifecycleRow | null,
      now: string,
    ) => Effect.Effect<boolean, SqlError | AutomationError>,
  ) =>
    transaction(
      input.action,
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        if (input.commandId !== undefined) {
          const claimed = yield* sql<{ command_id: string }>`
            INSERT INTO ${sql(commandTable)} (command_id, thread_id, action, created_at)
            VALUES (${input.commandId}, ${input.threadId}, ${input.action}, ${now})
            ON CONFLICT (command_id) DO NOTHING
            RETURNING command_id
          `;
          if (claimed.length === 0) {
            const receipts = yield* sql<CommandRow>`
              SELECT thread_id, action FROM ${sql(commandTable)} WHERE command_id = ${input.commandId}
            `;
            const receipt = receipts[0];
            if (
              receipt === undefined ||
              receipt.thread_id !== input.threadId ||
              receipt.action !== input.action
            ) {
              return yield* Effect.fail(
                new AutomationError({ message: "Task lifecycle command id was already used." }),
              );
            }
            return { record: yield* readRecord(input.threadId), applied: false };
          }
        }

        const current = yield* readRow(input.threadId);
        if (!expectedMatches(input, current)) {
          return { record: yield* readRecord(input.threadId), applied: false };
        }
        const applied = yield* update(current, now);
        return { record: yield* readRecord(input.threadId), applied };
      }),
    );

  const apply = (
    input: TaskLifecycleInput,
  ): Effect.Effect<TaskLifecycleStoreResult, AutomationError> => {
    switch (input.action) {
      case "read":
        return read(input.threadId).pipe(Effect.map((record) => ({ record, applied: false })));
      case "propose": {
        const condition = conditionFrom(input);
        if (condition === null) {
          return Effect.fail(
            new AutomationError({ message: "A task done-condition summary is required." }),
          );
        }
        const conditionJson = JSON.stringify(condition);
        return mutate(input, (current, now) => {
          const generation = (current?.generation ?? 0) + 1;
          return sql`
            INSERT INTO ${sql(recordTable)} (
              thread_id, condition_json, outcome, settled_reason, uncertain, settled_at, generation, updated_at
            ) VALUES (
              ${input.threadId}, ${conditionJson}, NULL, NULL, 0, NULL, ${generation}, ${now}
            )
            ON CONFLICT (thread_id) DO UPDATE SET
              condition_json = excluded.condition_json,
              outcome = NULL,
              settled_reason = NULL,
              uncertain = 0,
              settled_at = NULL,
              generation = excluded.generation,
              updated_at = excluded.updated_at
          `.pipe(Effect.as(true));
        });
      }
      case "complete":
      case "record-settle": {
        const reason = input.action === "record-settle" ? input.reason : null;
        if (input.action === "record-settle" && reason == null) {
          return Effect.fail(
            new AutomationError({ message: "A settle reason is required for an early settle." }),
          );
        }
        return mutate(input, (current, now) => {
          if (input.action === "complete" && current !== null && current.settled_at !== null) {
            return Effect.succeed(false);
          }
          const generation = (current?.generation ?? 0) + 1;
          const settledAt = input.settledAt ?? now;
          return Effect.gen(function* () {
            yield* sql`
              INSERT INTO ${sql(recordTable)} (
                thread_id, condition_json, outcome, settled_reason, uncertain, settled_at, generation, updated_at
              ) VALUES (
                ${input.threadId}, ${current?.condition_json ?? null}, ${input.outcome ?? null},
                ${reason}, ${input.uncertain === true ? 1 : 0}, ${settledAt}, ${generation}, ${now}
              )
              ON CONFLICT (thread_id) DO UPDATE SET
                outcome = excluded.outcome,
                settled_reason = excluded.settled_reason,
                uncertain = excluded.uncertain,
                settled_at = excluded.settled_at,
                generation = excluded.generation,
                updated_at = excluded.updated_at
            `;
            if (input.action === "record-settle") {
              yield* sql`
                INSERT INTO signalbox_automation_task_lifecycle_settlements (
                  thread_id, generation, outcome, reason, uncertain, settled_at, recorded_at
                ) VALUES (
                  ${input.threadId}, ${generation}, ${input.outcome ?? null}, ${reason},
                  ${input.uncertain === true ? 1 : 0}, ${settledAt}, ${now}
                )
              `;
            }
            return true;
          });
        });
      }
      case "reopen":
        return mutate(input, (current, now) => {
          if (current === null) {
            return sql`
              INSERT INTO ${sql(recordTable)} (
                thread_id, condition_json, outcome, settled_reason, uncertain, settled_at, generation, updated_at
              ) VALUES (${input.threadId}, NULL, NULL, NULL, 0, NULL, 1, ${now})
            `.pipe(Effect.as(true));
          }
          return sql`
            UPDATE ${sql(recordTable)} SET
              outcome = NULL,
              settled_reason = NULL,
              uncertain = 0,
              settled_at = NULL,
              generation = ${current.generation + 1},
              updated_at = ${now}
            WHERE thread_id = ${input.threadId}
          `.pipe(Effect.as(true));
        });
    }
  };

  const setConditionRunId = (threadId: string, expectedGeneration: number, runId: string) =>
    transaction(
      "setConditionRunId",
      Effect.gen(function* () {
        const current = yield* readRow(threadId);
        if (
          current === null ||
          current.generation !== expectedGeneration ||
          current.condition_json === null
        )
          return false;
        const condition = yield* decodeTaskLifecycleDoneCondition(current.condition_json).pipe(
          Effect.mapError(
            (cause) =>
              new AutomationError({ message: "Task lifecycle condition is invalid.", cause }),
          ),
        );
        if (condition.runId === runId) return true;
        const conditionJson = yield* encodeTaskLifecycleDoneCondition({ ...condition, runId }).pipe(
          Effect.mapError(
            (cause) =>
              new AutomationError({ message: "Task lifecycle condition is invalid.", cause }),
          ),
        );
        const updated = yield* sql<{ thread_id: string }>`
          UPDATE ${sql(recordTable)} SET condition_json = ${conditionJson}
          WHERE thread_id = ${threadId} AND generation = ${expectedGeneration}
          RETURNING thread_id
        `;
        return updated.length > 0;
      }),
    );

  const propose = (input: TaskLifecycleProposeInput) => apply({ ...input, action: "propose" });
  const complete = (input: TaskLifecycleOutcomeInput) => apply({ ...input, action: "complete" });
  const recordSettle = (
    input: TaskLifecycleOutcomeInput & { readonly reason: TaskLifecycleSettleReason },
  ) => apply({ ...input, action: "record-settle" });
  const recordOutcome = (input: TaskLifecycleOutcomeInput) =>
    input.reason == null ? complete(input) : recordSettle({ ...input, reason: input.reason });
  const reopen = (input: TaskLifecycleReopenInput) => apply({ ...input, action: "reopen" });

  return { read, setConditionRunId, apply, propose, complete, recordSettle, recordOutcome, reopen };
});

export type TaskLifecycleRecords = Effect.Success<typeof makeTaskRecords>;
