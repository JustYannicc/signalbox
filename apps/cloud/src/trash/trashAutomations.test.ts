import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import * as WorkflowStore from "@signalbox/automations/WorkflowStore";

import * as CloudAutomations from "../automations/CloudAutomations.ts";
import { layerMemoryStore } from "../testing.ts";
import { TrashAutomations, layer } from "./trashAutomations.ts";

const storeLayer = Layer.effectDiscard(WorkflowStore.make).pipe(
  Layer.provideMerge(layerMemoryStore),
);

const unused = () => Effect.die("Unused by Trash automation tests.");

const fakeEngine = (cancelRun: (runId: string) => Effect.Effect<void> = () => Effect.void) =>
  WorkflowEngine.WorkflowEngine.of({
    validate: () => ({ ok: false, diagnostics: [] }),
    save: unused,
    publish: unused,
    discardDraft: unused,
    list: unused,
    get: unused,
    getRun: unused,
    setEnabled: unused,
    rotateWebhook: unused,
    remove: unused,
    startRun: unused,
    builtIns: Effect.succeed([]),
    customize: unused,
    cancelAttached: unused,
    startWait: unused,
    listWaits: unused,
    stopWait: unused,
    watchPullRequest: unused,
    requestMerge: unused,
    registerBuiltinTools: () => Effect.void,
    registerPullRequestReads: () => Effect.void,
    registerExternalRunner: () => Effect.void,
    nextExternalPollAt: Effect.succeed(null),
    setWebhookSecret: unused,
    cancelRun,
    retryRun: unused,
    answer: unused,
    emit: unused,
    deliverEvent: () => Effect.void,
    subscribeList: () => Stream.empty,
    subscribeAutomation: () => Stream.empty,
    subscribeRun: () => Stream.empty,
    subscribeNotices: Effect.succeed(Stream.empty),
    tick: Effect.void,
    drain: Effect.void,
  });

const fakeCloudAutomations = (flush: Effect.Effect<void> = Effect.void) =>
  CloudAutomations.CloudAutomations.of({
    threadEvents: () => Effect.void,
    driveEvents: () => Effect.void,
    tool: () => Effect.succeed(undefined),
    host: () => Effect.succeed(undefined),
    workerModule: () => Effect.succeed(""),
    start: Effect.void,
    wake: Effect.void,
    flush,
  });

const services = (
  options: {
    readonly cancelRun?: (runId: string) => Effect.Effect<void>;
    readonly flush?: Effect.Effect<void>;
  } = {},
) => {
  const dependencies = Layer.mergeAll(
    Layer.succeed(WorkflowEngine.WorkflowEngine, fakeEngine(options.cancelRun)),
    Layer.succeed(CloudAutomations.CloudAutomations, fakeCloudAutomations(options.flush)),
  );
  return layer.pipe(Layer.provideMerge(dependencies), Layer.provideMerge(storeLayer));
};

const seedTrash = (id: string, threadId: string) =>
  SqlClient.SqlClient.use(
    (sql) =>
      sql`
      INSERT INTO trash_entries (
        id, kind, target_id, title, context_id, deleted_at, purge_after, status, targets, removals
      ) VALUES (
        ${id}, 'thread', ${threadId}, 'A thread', 'personal', 0, 1, 'purging', '[]', '[]'
      )
    `,
  );

const seedRun = (input: {
  readonly id: string;
  readonly status: string;
  readonly threadId: string;
  readonly parentRunId?: string;
  readonly lineageId?: string;
}) =>
  SqlClient.SqlClient.use((sql) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO signalbox_automation_runs (
          run_id, automation_id, version, status, trigger, input_json, marks_json, started_at,
          finished_at, parent_run_id
        ) VALUES (
          ${input.id}, 'automation-1', 1, ${input.status}, 'event', '{}', '{}',
          '2026-10-17T10:00:00.000Z',
          ${input.status === "running" ? null : "2026-10-17T10:01:00.000Z"},
          ${input.parentRunId ?? null}
        )
      `;
      yield* sql`
        INSERT INTO signalbox_automation_run_links (run_id, thread_id, lineage_id, started_at)
        VALUES (
          ${input.id}, ${input.threadId}, ${input.lineageId ?? input.id},
          '2026-10-17T10:00:00.000Z'
        )
      `;
    }),
  );

describe("Trash automation runs", () => {
  it.effect("replays purge receipts until the Trash journal records them", () =>
    Effect.gen(function* () {
      const trashId = "trash-owned";
      const threadId = "trashed-thread";
      const trash = yield* TrashAutomations;
      const sql = yield* SqlClient.SqlClient;
      yield* seedTrash(trashId, threadId);
      yield* seedRun({ id: "owned-run", status: "succeeded", threadId });

      const first = yield* trash.purgeAutomationTrash([threadId], trashId);
      const retry = yield* trash.purgeAutomationTrash([threadId], trashId);
      expect(first).toEqual([{ kind: "automation-run", id: "owned-run" }]);
      expect(retry).toEqual(first);
      expect(
        yield* sql<{ run_id: string }>`
        SELECT run_id FROM signalbox_automation_runs WHERE run_id = 'owned-run'
      `,
      ).toEqual([]);
      expect(
        yield* sql<{ run_id: string }>`
        SELECT run_id FROM trash_automation_receipts WHERE trash_id = ${trashId}
      `,
      ).toEqual([{ run_id: "owned-run" }]);

      yield* trash.acknowledgeAutomationTrash(trashId);
      expect(
        yield* sql<{ run_id: string }>`
        SELECT run_id FROM trash_automation_receipts WHERE trash_id = ${trashId}
      `,
      ).toEqual([{ run_id: "owned-run" }]);

      yield* sql`
        UPDATE trash_entries SET removals = ${JSON.stringify([
          { kind: "automation-run", id: "owned-run" },
        ])} WHERE id = ${trashId}
      `;
      yield* trash.acknowledgeAutomationTrash(trashId);
      expect(
        yield* sql<{ run_id: string }>`
        SELECT run_id FROM trash_automation_receipts WHERE trash_id = ${trashId}
      `,
      ).toEqual([]);
      expect(yield* trash.purgeAutomationTrash([threadId], trashId)).toEqual([]);
    }).pipe(Effect.provide(services())),
  );

  it.effect("retains a shared run family without cancelling its parent", () => {
    const cancelled: Array<string> = [];
    let flushes = 0;
    return Effect.gen(function* () {
      const trashId = "trash-shared";
      const threadId = "trashed-thread";
      const trash = yield* TrashAutomations;
      const sql = yield* SqlClient.SqlClient;
      yield* seedTrash(trashId, threadId);
      yield* seedRun({ id: "parent-run", status: "running", threadId });
      yield* seedRun({
        id: "shared-child",
        status: "running",
        threadId: "surviving-thread",
        parentRunId: "parent-run",
        lineageId: "parent-run",
      });

      const prepared = yield* trash.prepareAutomationTrash([threadId], trashId);
      expect(prepared.ready).toBe(true);
      expect(prepared.retained.map((run) => run.id).toSorted()).toEqual([
        "parent-run",
        "shared-child",
      ]);
      expect(prepared.retained.find((run) => run.id === "shared-child")?.reason).toContain(
        "surviving thread",
      );
      expect(prepared.retained.find((run) => run.id === "parent-run")?.reason).toContain(
        "shared-child",
      );
      expect(cancelled).toEqual([]);
      expect(flushes).toBe(0);
      expect(
        yield* sql<{ run_id: string; status: string }>`
        SELECT run_id, status FROM signalbox_automation_runs ORDER BY run_id
      `,
      ).toEqual([
        { run_id: "parent-run", status: "running" },
        { run_id: "shared-child", status: "running" },
      ]);
    }).pipe(
      Effect.provide(
        services({
          cancelRun: (runId) =>
            Effect.sync(() => {
              cancelled.push(runId);
            }),
          flush: Effect.sync(() => {
            flushes++;
          }),
        }),
      ),
    );
  });

  it.effect("purges a closed lineage when every run belongs to the trashed thread", () =>
    Effect.gen(function* () {
      const trashId = "trash-lineage";
      const threadId = "trashed-thread";
      const trash = yield* TrashAutomations;
      const sql = yield* SqlClient.SqlClient;
      yield* seedTrash(trashId, threadId);
      yield* seedRun({ id: "lineage-parent", status: "succeeded", threadId });
      yield* seedRun({
        id: "lineage-child",
        status: "failed",
        threadId,
        parentRunId: "lineage-parent",
        lineageId: "lineage-parent",
      });

      expect(yield* trash.purgeAutomationTrash([threadId], trashId)).toEqual([
        { kind: "automation-run", id: "lineage-child" },
        { kind: "automation-run", id: "lineage-parent" },
      ]);
      expect(
        yield* sql<{ run_id: string }>`
        SELECT run_id FROM signalbox_automation_runs
      `,
      ).toEqual([]);
      expect(
        yield* sql<{ run_id: string }>`
        SELECT run_id FROM trash_automation_receipts WHERE trash_id = ${trashId} ORDER BY run_id
      `,
      ).toEqual([{ run_id: "lineage-child" }, { run_id: "lineage-parent" }]);
    }).pipe(Effect.provide(services())),
  );
});
