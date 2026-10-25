import { AutomationError, RunId, type WorkflowEventCursor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * Storage for what binds a run beyond its own row: the thread it's attached
 * to, the run it continues after `w.restart`, and the events its
 * `w.waitFor({ on })` steps collect. storeSchema.ts creates the tables.
 */

export interface RunLinkRow {
  readonly run_id: string;
  readonly thread_id: string | null;
  readonly attach_key: string | null;
  readonly label: string | null;
  readonly restart_of_run_id: string | null;
  /** The first run of a `w.restart` chain; the run itself when it isn't one. */
  readonly lineage_id: string;
  readonly started_at: string;
}

export interface InboxRow {
  readonly seq: number;
  readonly run_id: string;
  readonly event_id: string;
  readonly name: string;
  readonly envelope_json: string;
  readonly consumed_by: string | null;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const run = <A>(operation: string, statement: Effect.Effect<A, SqlError>) =>
    statement.pipe(
      Effect.mapError(
        (cause) =>
          new AutomationError({ message: `Automation storage failed (${operation}).`, cause }),
      ),
    );

  const insertLink = (row: RunLinkRow) =>
    run(
      "insertLink",
      sql`
        INSERT INTO signalbox_automation_run_links (
          run_id, thread_id, attach_key, label, restart_of_run_id, lineage_id, started_at
        ) VALUES (
          ${row.run_id}, ${row.thread_id}, ${row.attach_key}, ${row.label},
          ${row.restart_of_run_id}, ${row.lineage_id}, ${row.started_at}
        )
        ON CONFLICT (run_id) DO NOTHING
      `,
    );
  const getLink = (runId: string) =>
    run(
      "getLink",
      sql<RunLinkRow>`SELECT * FROM signalbox_automation_run_links WHERE run_id = ${runId}`,
    ).pipe(Effect.map((rows) => rows[0]));

  return {
    insertLink,
    getLink,
    /** Adopts an existing unlinked run as a thread attachment. */
    adoptAttachment: (input: {
      readonly runId: string;
      readonly threadId: string;
      readonly key: string;
      readonly label: string;
      readonly startedAt: string;
    }) =>
      Effect.gen(function* () {
        const existing = yield* getLink(input.runId);
        if (existing) {
          if (existing.thread_id === input.threadId && existing.attach_key === input.key) return;
          if (existing.thread_id !== null || existing.attach_key !== null)
            return yield* Effect.fail(
              new AutomationError({ message: "That run is already attached to another task." }),
            );
          yield* run(
            "adoptAttachment",
            sql`
              UPDATE signalbox_automation_run_links
              SET thread_id = ${input.threadId}, attach_key = ${input.key}, label = ${input.label}
              WHERE run_id = ${input.runId} AND thread_id IS NULL AND attach_key IS NULL
            `,
          );
        } else {
          yield* insertLink({
            run_id: input.runId,
            thread_id: input.threadId,
            attach_key: input.key,
            label: input.label,
            restart_of_run_id: null,
            lineage_id: input.runId,
            started_at: input.startedAt,
          });
        }
        const adopted = yield* getLink(input.runId);
        if (adopted?.thread_id !== input.threadId || adopted.attach_key !== input.key)
          return yield* Effect.fail(
            new AutomationError({ message: "That run is already attached to another task." }),
          );
      }),
    /** The running run attached to `threadId` under `key`, if any. */
    runningAttached: (threadId: string, key: string) =>
      run(
        "runningAttached",
        sql<{ run_id: string }>`
          SELECT l.run_id FROM signalbox_automation_run_links l
          JOIN signalbox_automation_runs r ON r.run_id = l.run_id
          WHERE l.thread_id = ${threadId} AND l.attach_key = ${key} AND r.status = 'running'
        `,
      ).pipe(Effect.map((rows) => rows[0]?.run_id)),
    /** Every running run attached to a thread, of one thread or of all. */
    runningAttachedTo: (threadId?: string) =>
      run(
        "runningAttachedTo",
        sql<RunLinkRow>`
          SELECT l.* FROM signalbox_automation_run_links l
          JOIN signalbox_automation_runs r ON r.run_id = l.run_id
          WHERE l.thread_id IS NOT NULL AND r.status = 'running'
            ${threadId === undefined ? sql`` : sql`AND l.thread_id = ${threadId}`}
        `,
      ),
    /** How many runs of a restart chain started since `since`. */
    restartsSince: (lineageId: string, since: string) =>
      run(
        "restartsSince",
        sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM signalbox_automation_run_links
          WHERE lineage_id = ${lineageId} AND restart_of_run_id IS NOT NULL
            AND started_at >= ${since}
        `,
      ).pipe(Effect.map((rows) => rows[0]?.count ?? 0)),

    /** Keeps an event for a run; false when the run already has it. */
    keepEvent: (row: Omit<InboxRow, "seq" | "consumed_by"> & { readonly received_at: string }) =>
      run(
        "keepEvent",
        sql<{ seq: number }>`
          INSERT INTO signalbox_automation_run_inbox (
            run_id, event_id, name, envelope_json, received_at
          ) VALUES (
            ${row.run_id}, ${row.event_id}, ${row.name}, ${row.envelope_json}, ${row.received_at}
          )
          ON CONFLICT (run_id, event_id) DO NOTHING
          RETURNING seq
        `,
      ).pipe(Effect.map((rows) => rows.length > 0)),
    /** Untaken events and claims whose waiting step still needs settlement, oldest first. */
    unconsumed: (runId: string) =>
      run(
        "unconsumed",
        sql<InboxRow>`
          SELECT i.seq, i.run_id, i.event_id, i.name, i.envelope_json, i.consumed_by
          FROM signalbox_automation_run_inbox i
          WHERE i.run_id = ${runId} AND (
            i.consumed_by IS NULL OR EXISTS (
              SELECT 1 FROM signalbox_automation_steps s
              WHERE s.run_id = i.run_id AND s.step_key = i.consumed_by
                AND s.status = 'waiting'
            )
          )
          ORDER BY i.seq
        `,
      ),
    /** Captures the run's inbox high-watermark; an empty inbox starts at sequence zero. */
    captureEventCursor: (runId: string) =>
      run(
        "captureEventCursor",
        sql<{ sequence: number }>`
          SELECT COALESCE(MAX(seq), 0) AS sequence
          FROM signalbox_automation_run_inbox
          WHERE run_id = ${runId}
        `,
      ).pipe(
        Effect.map((rows): WorkflowEventCursor => ({
          runId: RunId.make(runId),
          sequence: rows[0]?.sequence ?? 0,
        })),
      ),
    /**
     * Gives event `seq` to step `stepKey`. False when another step took it
     * first or the step already has one, so each step gets one event and each
     * event one step.
     */
    consume: (runId: string, seq: number, stepKey: string) =>
      run(
        "consume",
        sql<{ seq: number }>`
          UPDATE signalbox_automation_run_inbox SET consumed_by = ${stepKey}
          WHERE seq = ${seq} AND consumed_by IS NULL AND NOT EXISTS (
            SELECT 1 FROM signalbox_automation_run_inbox
            WHERE run_id = ${runId} AND consumed_by = ${stepKey}
          )
          RETURNING seq
        `,
      ).pipe(Effect.map((rows) => rows.length > 0)),
    /** Drops a run's inbox once it ended, and keeps it from growing without bound meanwhile. */
    trimInbox: (runId: string, keep: number) =>
      run(
        "trimInbox",
        sql`
          DELETE FROM signalbox_automation_run_inbox
          WHERE run_id = ${runId} AND seq NOT IN (
            SELECT seq FROM signalbox_automation_run_inbox
            WHERE run_id = ${runId} ORDER BY seq DESC LIMIT ${keep}
          )
        `,
      ),
    /** Links and inboxes of runs that no longer exist or stopped running. */
    prune: () =>
      Effect.all(
        [
          run(
            "pruneLinks",
            sql`
              DELETE FROM signalbox_automation_run_links
              WHERE run_id NOT IN (SELECT run_id FROM signalbox_automation_runs)
            `,
          ),
          run(
            "pruneInbox",
            sql`
              DELETE FROM signalbox_automation_run_inbox
              WHERE run_id NOT IN (
                SELECT run_id FROM signalbox_automation_runs WHERE status = 'running'
              )
            `,
          ),
        ],
        { discard: true },
      ),
  };
});

export type RunLinkStore = Effect.Success<typeof make>;
