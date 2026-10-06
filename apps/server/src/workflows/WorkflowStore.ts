import {
  AutomationError,
  type AutomationRunStatus,
  type AutomationRunTrigger,
  type AutomationStepStatus,
  type WorkflowStepVerb,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { ensureAutomationTables } from "./storeSchema.ts";
import { isoAt } from "./time.ts";

/**
 * Durable state for automations: saved versions, runs, and each run's step
 * journal, which replays answer from. storeSchema.ts owns the table shapes.
 */

export interface AutomationRow {
  readonly automation_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly enabled: number;
  readonly version: number;
  readonly project_id: string;
  readonly defaults_json: string;
  readonly triggers_json: string;
  readonly webhook_token: string;
  readonly next_run_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  /** `meta.timeout` of the current version, for runs it starts. */
  readonly timeout_ms: number | null;
  /** `meta.overlap`; null means the default, skip. */
  readonly overlap: string | null;
  /** `meta.intent` of the live version: what the user asked for. */
  readonly intent: string | null;
  /**
   * A saved version that isn't live yet. `version` stays what triggers and
   * runs use; it is 0 while the automation has only ever been a draft.
   */
  readonly draft_version: number | null;
}

export interface VersionRow {
  readonly automation_id: string;
  readonly version: number;
  readonly source: string;
  readonly script: string;
  readonly run_module: string | null;
  readonly graph_json: string;
  /** The compiled `meta`, so publishing a draft needn't compile again. Null before drafts. */
  readonly meta_json: string | null;
  /** The defaults of the thread that saved it, which apply once it's live. Null before drafts. */
  readonly defaults_json: string | null;
  readonly created_at: string;
}

export interface RunRow {
  readonly run_id: string;
  readonly automation_id: string;
  readonly version: number;
  readonly status: AutomationRunStatus;
  readonly trigger: AutomationRunTrigger;
  readonly input_json: string;
  readonly output_json: string | null;
  readonly error: string | null;
  readonly marks_json: string;
  /** The latest replay's `console` lines. */
  readonly logs_json: string | null;
  /** The workflow's third argument: how the run was started, with webhook headers. */
  readonly trigger_json: string | null;
  /** The run whose `w.start` started this one. */
  readonly parent_run_id: string | null;
  /** How many `w.start`s deep this run is; top-level runs are 0. */
  readonly depth: number;
  /** When `meta.timeout` fails the run. */
  readonly deadline_at: string | null;
  /** Why it failed and how to fix it, as `AutomationErrorDetail` JSON. */
  readonly error_detail_json: string | null;
  /** What the run did, in a line: its last notification, or a short text output. */
  readonly title: string | null;
  /** The failed or cancelled run this one retries; its first replay reuses that run's steps. */
  readonly retry_of_run_id: string | null;
  /** Seeds randomness on replay instead of the run id: a retry draws what its original drew. */
  readonly replay_seed: string | null;
  /** The clock replays start from instead of `started_at`, for the same reason. */
  readonly replay_started_at: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly waiting_on_you: number;
}

export interface StepRow {
  readonly run_id: string;
  readonly step_key: string;
  readonly node_id: string;
  readonly verb: WorkflowStepVerb;
  readonly label: string;
  readonly status: AutomationStepStatus;
  readonly args_json: string;
  readonly result_json: string | null;
  readonly error: string | null;
  /** Why it failed and how to fix it, as `AutomationErrorDetail` JSON. */
  readonly error_detail_json: string | null;
  readonly thread_id: string | null;
  /** The thread run an agent step waits on, when it continued an existing thread. */
  readonly agent_run_id?: string | null;
  /** A sleep's or timeout's end, or when a retry starts. */
  readonly wake_at: string | null;
  readonly event: string | null;
  /** Which try this is, from 1. */
  readonly attempt: number;
  readonly started_at: string;
  readonly finished_at: string | null;
}

/** What run lists show; `runSummary` reads only these. */
export type RunSummaryRow = Pick<
  RunRow,
  | "run_id"
  | "automation_id"
  | "version"
  | "status"
  | "trigger"
  | "started_at"
  | "finished_at"
  | "error"
  | "error_detail_json"
  | "title"
  | "retry_of_run_id"
  | "waiting_on_you"
>;

/** A waiting `ask` step as automation views show it. */
export type WaitingAskRow = Pick<
  StepRow,
  "run_id" | "step_key" | "label" | "args_json" | "started_at"
> & { readonly automation_id: string };

/** A saved version as clients show it: the file, its diagram, and when it was saved. */
export type VersionViewRow = Pick<VersionRow, "version" | "source" | "graph_json" | "created_at">;

/** How long a webhook delivery id or event occurrence is remembered, so repeats don't start runs. */
const REQUEST_KEY_TTL_MS = 24 * 60 * 60 * 1000;

type RetryColumns = "retry_of_run_id" | "replay_seed" | "replay_started_at";
export type NewRun = Omit<
  RunRow,
  "waiting_on_you" | "title" | "logs_json" | "error_detail_json" | RetryColumns
> &
  Partial<Pick<RunRow, RetryColumns>>;

const WAITING_ON_YOU = `
  EXISTS (
    SELECT 1 FROM signalbox_automation_steps s
    WHERE s.run_id = r.run_id AND s.verb = 'ask' AND s.status = 'waiting'
  ) AS waiting_on_you
`;
const RUN_COLUMNS = `
  r.run_id, r.automation_id, r.version, r.status, r.trigger, r.input_json, r.output_json,
  r.error, r.error_detail_json, r.marks_json, r.logs_json, r.trigger_json, r.parent_run_id,
  r.depth, r.deadline_at, r.title, r.retry_of_run_id, r.replay_seed, r.replay_started_at,
  r.started_at, r.finished_at, ${WAITING_ON_YOU}
`;
const SUMMARY_COLUMNS = `
  r.run_id, r.automation_id, r.version, r.status, r.trigger, r.started_at, r.finished_at,
  r.error, r.error_detail_json, r.title, r.retry_of_run_id, ${WAITING_ON_YOU}
`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const run = <A>(operation: string, statement: Effect.Effect<A, SqlError>) =>
    statement.pipe(
      Effect.mapError(
        (cause) =>
          new AutomationError({ message: `Automation storage failed (${operation}).`, cause }),
      ),
    );
  const changedRows = <A>(rows: ReadonlyArray<A>) => rows.length > 0;

  yield* run(
    "create tables",
    ensureAutomationTables.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  );
  const runColumns = sql.literal(RUN_COLUMNS);
  const summaryColumns = sql.literal(SUMMARY_COLUMNS);

  return {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(
              new AutomationError({ message: "Automation storage failed (transaction).", cause }),
            ),
          ),
        ),

    getAutomation: (id: string) =>
      run(
        "getAutomation",
        sql<AutomationRow>`SELECT * FROM signalbox_automations WHERE automation_id = ${id}`,
      ).pipe(Effect.map((rows) => rows[0])),
    getAutomationByName: (projectId: string, name: string) =>
      run(
        "getAutomationByName",
        sql<AutomationRow>`
          SELECT * FROM signalbox_automations WHERE project_id = ${projectId} AND name = ${name}
        `,
      ).pipe(Effect.map((rows) => rows[0])),
    getAutomationByWebhook: (token: string) =>
      run(
        "getAutomationByWebhook",
        sql<AutomationRow>`SELECT * FROM signalbox_automations WHERE webhook_token = ${token}`,
      ).pipe(Effect.map((rows) => rows[0])),
    listAutomations: () =>
      run("listAutomations", sql<AutomationRow>`SELECT * FROM signalbox_automations ORDER BY name`),
    dueAutomations: (now: string) =>
      run(
        "dueAutomations",
        sql<AutomationRow>`
          SELECT * FROM signalbox_automations
          WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ${now}
        `,
      ),
    upsertAutomation: (row: AutomationRow) =>
      run(
        "upsertAutomation",
        sql`
          INSERT INTO signalbox_automations (
            automation_id, name, description, enabled, version, project_id, defaults_json,
            triggers_json, webhook_token, next_run_at, created_at, updated_at, timeout_ms, overlap,
            intent, draft_version
          ) VALUES (
            ${row.automation_id}, ${row.name}, ${row.description}, ${row.enabled}, ${row.version},
            ${row.project_id}, ${row.defaults_json}, ${row.triggers_json}, ${row.webhook_token},
            ${row.next_run_at}, ${row.created_at}, ${row.updated_at}, ${row.timeout_ms},
            ${row.overlap}, ${row.intent}, ${row.draft_version}
          )
          ON CONFLICT (automation_id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            enabled = excluded.enabled,
            version = excluded.version,
            project_id = excluded.project_id,
            defaults_json = excluded.defaults_json,
            triggers_json = excluded.triggers_json,
            next_run_at = excluded.next_run_at,
            updated_at = excluded.updated_at,
            timeout_ms = excluded.timeout_ms,
            overlap = excluded.overlap,
            intent = excluded.intent,
            draft_version = excluded.draft_version
        `,
      ),
    setSchedule: (id: string, enabled: boolean, nextRunAt: string | null, now: string) =>
      run(
        "setSchedule",
        sql`
          UPDATE signalbox_automations
          SET enabled = ${enabled ? 1 : 0}, next_run_at = ${nextRunAt}, updated_at = ${now}
          WHERE automation_id = ${id}
        `,
      ),
    /**
     * Moves a due cron to its next time, only if it's still on and nobody moved
     * it since `due` was read. True when this caller owns the firing.
     */
    claimSchedule: (id: string, due: string, next: string | null) =>
      run(
        "claimSchedule",
        sql<{ automation_id: string }>`
          UPDATE signalbox_automations SET next_run_at = ${next}
          WHERE automation_id = ${id} AND enabled = 1 AND next_run_at = ${due}
          RETURNING automation_id
        `,
      ).pipe(Effect.map(changedRows)),
    setWebhookToken: (id: string, token: string, now: string) =>
      run(
        "setWebhookToken",
        sql`
          UPDATE signalbox_automations SET webhook_token = ${token}, updated_at = ${now}
          WHERE automation_id = ${id}
        `,
      ),
    /** Everything the automation owns. Run inside a transaction. */
    deleteAutomation: (id: string) =>
      Effect.forEach(
        [
          sql`DELETE FROM signalbox_automation_steps WHERE run_id IN (SELECT run_id FROM signalbox_automation_runs WHERE automation_id = ${id})`,
          sql`DELETE FROM signalbox_automation_runs WHERE automation_id = ${id}`,
          sql`DELETE FROM signalbox_automation_versions WHERE automation_id = ${id}`,
          sql`DELETE FROM signalbox_automation_memory WHERE automation_id = ${id}`,
          sql`DELETE FROM signalbox_automation_webhook_keys WHERE automation_id = ${id}`,
          sql`DELETE FROM signalbox_automations WHERE automation_id = ${id}`,
        ],
        (statement) => run("deleteAutomation", statement),
        { discard: true },
      ),

    insertVersion: (row: VersionRow) =>
      run(
        "insertVersion",
        sql`
          INSERT INTO signalbox_automation_versions (
            automation_id, version, source, script, run_module, graph_json, meta_json,
            defaults_json, created_at
          ) VALUES (
            ${row.automation_id}, ${row.version}, ${row.source}, ${row.script}, ${row.run_module},
            ${row.graph_json}, ${row.meta_json}, ${row.defaults_json}, ${row.created_at}
          )
        `,
      ),
    getVersion: (automationId: string, version: number) =>
      run(
        "getVersion",
        sql<VersionRow>`
          SELECT * FROM signalbox_automation_versions
          WHERE automation_id = ${automationId} AND version = ${version}
        `,
      ).pipe(Effect.map((rows) => rows[0])),
    /** A version's file and diagram, without the compiled script. */
    getVersionView: (automationId: string, version: number) =>
      run(
        "getVersionView",
        sql<VersionViewRow>`
          SELECT version, source, graph_json, created_at FROM signalbox_automation_versions
          WHERE automation_id = ${automationId} AND version = ${version}
        `,
      ).pipe(Effect.map((rows) => rows[0])),
    /** The compiled script a run replays. */
    getVersionScript: (automationId: string, version: number) =>
      run(
        "getVersionScript",
        sql<{ script: string }>`
          SELECT script FROM signalbox_automation_versions
          WHERE automation_id = ${automationId} AND version = ${version}
        `,
      ).pipe(Effect.map((rows) => rows[0]?.script)),
    /** The highest version ever saved, live or draft; new versions go above it. */
    latestVersion: (automationId: string) =>
      run(
        "latestVersion",
        sql<{ version: number | null }>`
          SELECT MAX(version) AS version FROM signalbox_automation_versions
          WHERE automation_id = ${automationId}
        `,
      ).pipe(Effect.map((rows) => rows[0]?.version ?? 0)),

    insertRun: (row: NewRun) =>
      run(
        "insertRun",
        sql`
          INSERT INTO signalbox_automation_runs (
            run_id, automation_id, version, status, trigger, input_json, output_json, error,
            marks_json, trigger_json, parent_run_id, depth, deadline_at, retry_of_run_id,
            replay_seed, replay_started_at, started_at, finished_at
          ) VALUES (
            ${row.run_id}, ${row.automation_id}, ${row.version}, ${row.status}, ${row.trigger},
            ${row.input_json}, ${row.output_json}, ${row.error}, ${row.marks_json},
            ${row.trigger_json}, ${row.parent_run_id}, ${row.depth}, ${row.deadline_at},
            ${row.retry_of_run_id ?? null}, ${row.replay_seed ?? null},
            ${row.replay_started_at ?? null}, ${row.started_at}, ${row.finished_at}
          )
        `,
      ),
    getRun: (runId: string) =>
      run(
        "getRun",
        sql<RunRow>`SELECT ${runColumns} FROM signalbox_automation_runs r WHERE r.run_id = ${runId}`,
      ).pipe(Effect.map((rows) => rows[0])),
    /** Which automation a run belongs to, and whether it's still going. */
    getRunMeta: (runId: string) =>
      run(
        "getRunMeta",
        sql<Pick<RunRow, "automation_id" | "status">>`
          SELECT automation_id, status FROM signalbox_automation_runs WHERE run_id = ${runId}
        `,
      ).pipe(Effect.map((rows) => rows[0])),
    listRuns: (automationId: string, limit: number) =>
      run(
        "listRuns",
        sql<RunSummaryRow>`
          SELECT ${summaryColumns} FROM signalbox_automation_runs r
          WHERE r.automation_id = ${automationId}
          ORDER BY r.started_at DESC LIMIT ${limit}
        `,
      ),
    latestRuns: () =>
      run(
        "latestRuns",
        sql<RunSummaryRow>`
          SELECT ${summaryColumns} FROM signalbox_automation_runs r
          WHERE r.started_at = (
            SELECT MAX(started_at) FROM signalbox_automation_runs WHERE automation_id = r.automation_id
          )
        `,
      ),
    runningRuns: () =>
      run(
        "runningRuns",
        sql<{
          run_id: string;
          automation_id: string;
          version: number;
        }>`SELECT run_id, automation_id, version FROM signalbox_automation_runs WHERE status = 'running'`,
      ),
    runningRunsOf: (automationId: string) =>
      run(
        "runningRunsOf",
        sql<{ run_id: string }>`
          SELECT run_id FROM signalbox_automation_runs
          WHERE automation_id = ${automationId} AND status = 'running'
        `,
      ).pipe(Effect.map((rows) => rows.map((row) => row.run_id))),
    runningChildren: (parentRunId: string) =>
      run(
        "runningChildren",
        sql<{ run_id: string }>`
          SELECT run_id FROM signalbox_automation_runs
          WHERE parent_run_id = ${parentRunId} AND status = 'running'
        `,
      ).pipe(Effect.map((rows) => rows.map((row) => row.run_id))),
    /** Running runs past their `meta.timeout`. */
    overdueRuns: (now: string) =>
      run(
        "overdueRuns",
        sql<{ run_id: string }>`
          SELECT run_id FROM signalbox_automation_runs
          WHERE status = 'running' AND deadline_at IS NOT NULL AND deadline_at <= ${now}
        `,
      ).pipe(Effect.map((rows) => rows.map((row) => row.run_id))),
    /** Ends a running run once. False when it had already ended, so callers act once. */
    finishRun: (
      runId: string,
      end: {
        readonly status: AutomationRunStatus;
        readonly output: string | null;
        readonly error: string | null;
        readonly errorDetail: string | null;
        readonly title: string | null;
      },
      now: string,
    ) =>
      run(
        "finishRun",
        sql<{ run_id: string }>`
          UPDATE signalbox_automation_runs
          SET status = ${end.status}, output_json = ${end.output}, error = ${end.error},
            error_detail_json = ${end.errorDetail}, finished_at = ${now}, title = ${end.title}
          WHERE run_id = ${runId} AND status = 'running'
          RETURNING run_id
        `,
      ).pipe(Effect.map(changedRows)),
    saveReplay: (runId: string, marks: string, logs: string) =>
      run(
        "saveReplay",
        sql`
          UPDATE signalbox_automation_runs SET marks_json = ${marks}, logs_json = ${logs}
          WHERE run_id = ${runId}
        `,
      ),

    listSteps: (runId: string) =>
      run(
        "listSteps",
        sql<StepRow>`SELECT * FROM signalbox_automation_steps WHERE run_id = ${runId} ORDER BY started_at, step_key`,
      ),
    /** Records a step the code reached. False when another replay already recorded it. */
    insertStep: (row: StepRow) =>
      run(
        "insertStep",
        sql<{ step_key: string }>`
          INSERT INTO signalbox_automation_steps (
            run_id, step_key, node_id, verb, label, status, args_json, result_json, error,
            thread_id, wake_at, event, attempt, started_at, finished_at
          ) VALUES (
            ${row.run_id}, ${row.step_key}, ${row.node_id}, ${row.verb}, ${row.label}, ${row.status},
            ${row.args_json}, ${row.result_json}, ${row.error}, ${row.thread_id}, ${row.wake_at},
            ${row.event}, ${row.attempt}, ${row.started_at}, ${row.finished_at}
          )
          ON CONFLICT (run_id, step_key) DO NOTHING
          RETURNING step_key
        `,
      ).pipe(Effect.map(changedRows)),
    /** Moves a running step to waiting. False when it wasn't running, so callers act once. */
    markWaiting: (
      runId: string,
      key: string,
      wait: { threadId?: string; agentRunId?: string; wakeAt?: string; event?: string },
    ) =>
      run(
        "markWaiting",
        sql<{ step_key: string }>`
          UPDATE signalbox_automation_steps
          SET status = 'waiting', thread_id = ${wait.threadId ?? null}, wake_at = ${wait.wakeAt ?? null},
            event = ${wait.event ?? null}, agent_run_id = ${wait.agentRunId ?? null}
          WHERE run_id = ${runId} AND step_key = ${key} AND status = 'running'
          RETURNING step_key
        `,
      ).pipe(Effect.map(changedRows)),
    /** Settles a step once. Undefined when it was already settled, so callers don't advance twice. */
    completeStep: (
      runId: string,
      key: string,
      outcome:
        | { ok: true; value: string }
        | { ok: false; error: string; errorDetail: string | null },
      now: string,
    ) =>
      run(
        "completeStep",
        sql<StepRow>`
          UPDATE signalbox_automation_steps
          SET status = ${outcome.ok ? "succeeded" : "failed"},
            result_json = ${outcome.ok ? outcome.value : null},
            error = ${outcome.ok ? null : outcome.error},
            error_detail_json = ${outcome.ok ? null : outcome.errorDetail},
            finished_at = ${now}
          WHERE run_id = ${runId} AND step_key = ${key} AND status IN ('running', 'waiting')
          RETURNING *
        `,
      ).pipe(Effect.map((rows) => rows[0])),
    /**
     * Parks attempt `attempt` of a step until `wakeAt`, when the tick starts the
     * next one. Keeps the last error visible meanwhile. False when the step
     * already moved on, so a retry is scheduled once.
     */
    scheduleRetry: (runId: string, key: string, attempt: number, wakeAt: string, error: string) =>
      run(
        "scheduleRetry",
        sql<{ step_key: string }>`
          UPDATE signalbox_automation_steps
          SET status = 'waiting', attempt = ${attempt + 1}, wake_at = ${wakeAt}, thread_id = NULL, agent_run_id = NULL,
            error = ${error}, error_detail_json = NULL
          WHERE run_id = ${runId} AND step_key = ${key} AND attempt = ${attempt}
            AND status IN ('running', 'waiting')
          RETURNING step_key
        `,
      ).pipe(Effect.map(changedRows)),
    /** Starts a parked retry: waiting → running. Undefined when someone else already did. */
    restartStep: (runId: string, key: string, attempt: number) =>
      run(
        "restartStep",
        sql<StepRow>`
          UPDATE signalbox_automation_steps SET status = 'running', wake_at = NULL, error = NULL
          WHERE run_id = ${runId} AND step_key = ${key} AND attempt = ${attempt}
            AND status = 'waiting'
          RETURNING *
        `,
      ).pipe(Effect.map((rows) => rows[0])),
    /** Fails every step of a run that hasn't finished, when the run ends under them. */
    closeOpenSteps: (runId: string, error: string, now: string) =>
      run(
        "closeOpenSteps",
        sql`
          UPDATE signalbox_automation_steps SET status = 'failed', error = ${error}, finished_at = ${now}
          WHERE run_id = ${runId} AND status IN ('running', 'waiting')
        `,
      ),
    stepsWithStatus: (status: AutomationStepStatus) =>
      run(
        "stepsWithStatus",
        sql<StepRow>`
          SELECT s.* FROM signalbox_automation_steps s
          JOIN signalbox_automation_runs r ON r.run_id = s.run_id
          WHERE s.status = ${status} AND r.status = 'running'
        `,
      ),
    /** Waiting steps of running runs whose timer, timeout or retry is due by `now`. */
    dueSteps: (now: string) =>
      run(
        "dueSteps",
        sql<StepRow>`
          SELECT s.* FROM signalbox_automation_steps s
          JOIN signalbox_automation_runs r ON r.run_id = s.run_id
          WHERE s.status = 'waiting' AND s.wake_at IS NOT NULL AND s.wake_at <= ${now}
            AND r.status = 'running'
        `,
      ),
    /** Waiting steps of running runs that wait on an agent thread. */
    threadSteps: () =>
      run(
        "threadSteps",
        sql<StepRow>`
          SELECT s.* FROM signalbox_automation_steps s
          JOIN signalbox_automation_runs r ON r.run_id = s.run_id
          WHERE s.status = 'waiting' AND s.thread_id IS NOT NULL AND r.status = 'running'
        `,
      ),
    /** Waiting `ask` steps of running runs, oldest first; of one automation, or of all. */
    waitingQuestions: (automationId?: string) =>
      run(
        "waitingQuestions",
        sql<WaitingAskRow>`
          SELECT s.run_id, s.step_key, s.label, s.args_json, s.started_at, r.automation_id
          FROM signalbox_automation_steps s
          JOIN signalbox_automation_runs r ON r.run_id = s.run_id
          WHERE s.verb = 'ask' AND s.status = 'waiting' AND r.status = 'running'
            ${automationId === undefined ? sql`` : sql`AND r.automation_id = ${automationId}`}
          ORDER BY s.started_at
        `,
      ),
    stepForThread: (threadId: string) =>
      run(
        "stepForThread",
        sql<StepRow>`SELECT * FROM signalbox_automation_steps WHERE thread_id = ${threadId} AND status = 'waiting'`,
      ).pipe(Effect.map((rows) => rows[0])),
    /** `waitFor` steps of running runs waiting on `event`. */
    waitingForEvent: (event: string) =>
      run(
        "waitingForEvent",
        sql<StepRow>`
          SELECT s.* FROM signalbox_automation_steps s
          JOIN signalbox_automation_runs r ON r.run_id = s.run_id
          WHERE s.event = ${event} AND s.status = 'waiting' AND r.status = 'running'
        `,
      ),
    getStep: (runId: string, key: string) =>
      run(
        "getStep",
        sql<StepRow>`SELECT * FROM signalbox_automation_steps WHERE run_id = ${runId} AND step_key = ${key}`,
      ).pipe(Effect.map((rows) => rows[0])),

    recall: (automationId: string, key: string) =>
      run(
        "recall",
        sql<{ value_json: string }>`
          SELECT value_json FROM signalbox_automation_memory
          WHERE automation_id = ${automationId} AND memory_key = ${key}
        `,
      ).pipe(Effect.map((rows) => rows[0]?.value_json)),
    remember: (automationId: string, key: string, value: string, now: string) =>
      run(
        "remember",
        sql`
          INSERT INTO signalbox_automation_memory (automation_id, memory_key, value_json, updated_at)
          VALUES (${automationId}, ${key}, ${value}, ${now})
          ON CONFLICT (automation_id, memory_key) DO UPDATE SET
            value_json = excluded.value_json, updated_at = excluded.updated_at
        `,
      ),

    /**
     * Claims a request key (a webhook delivery id, an event occurrence) for
     * `runId`. Returns the run that already claimed it, or undefined when this
     * call did. Keys older than a day are forgotten first, so a sender may
     * reuse one after that.
     */
    claimRequestKey: (claim: {
      readonly automationId: string;
      readonly key: string;
      readonly runId: string;
      readonly now: DateTime.Utc;
    }) =>
      Effect.gen(function* () {
        const { automationId, key, runId } = claim;
        const since = isoAt(claim.now.epochMilliseconds - REQUEST_KEY_TTL_MS);
        yield* run(
          "claimRequestKey",
          sql`
            DELETE FROM signalbox_automation_webhook_keys
            WHERE automation_id = ${automationId} AND request_key = ${key} AND created_at < ${since}
          `,
        );
        const claimed = yield* run(
          "claimRequestKey",
          sql<{ run_id: string }>`
            INSERT INTO signalbox_automation_webhook_keys (automation_id, request_key, run_id, created_at)
            VALUES (${automationId}, ${key}, ${runId}, ${DateTime.formatIso(claim.now)})
            ON CONFLICT (automation_id, request_key) DO NOTHING
            RETURNING run_id
          `,
        );
        if (claimed.length > 0) return undefined;
        const existing = yield* run(
          "claimRequestKey",
          sql<{ run_id: string }>`
            SELECT run_id FROM signalbox_automation_webhook_keys
            WHERE automation_id = ${automationId} AND request_key = ${key}
          `,
        );
        return existing[0]?.run_id;
      }),

    /**
     * Deletes finished runs (with their steps) that ended before `before`,
     * except each automation's latest `keep` runs, and request keys past their
     * day. Returns the automations that lost runs. Run inside a transaction.
     */
    prune: (input: {
      readonly before: string;
      readonly keep: number;
      readonly now: DateTime.Utc;
    }) =>
      Effect.gen(function* () {
        const { before, keep } = input;
        const old = yield* run(
          "prune",
          sql<{ run_id: string; automation_id: string }>`
            SELECT run_id, automation_id FROM (
              SELECT run_id, automation_id, status, finished_at,
                ROW_NUMBER() OVER (PARTITION BY automation_id ORDER BY started_at DESC) AS position
              FROM signalbox_automation_runs
            )
            WHERE position > ${keep} AND status != 'running' AND finished_at < ${before}
          `,
        );
        const ids = old.map((row) => row.run_id);
        if (ids.length > 0) {
          yield* run(
            "prune",
            sql`DELETE FROM signalbox_automation_steps WHERE ${sql.in("run_id", ids)}`,
          );
          yield* run(
            "prune",
            sql`DELETE FROM signalbox_automation_runs WHERE ${sql.in("run_id", ids)}`,
          );
        }
        yield* run(
          "prune",
          sql`DELETE FROM signalbox_automation_webhook_keys WHERE created_at < ${isoAt(input.now.epochMilliseconds - REQUEST_KEY_TTL_MS)}`,
        );
        return new Set(old.map((row) => row.automation_id));
      }),
  };
});

export type WorkflowStore = Effect.Success<typeof make>;
