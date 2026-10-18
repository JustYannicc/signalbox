import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as WorkflowStore from "@signalbox/automations/WorkflowStore";

import { layerMemoryStore } from "../testing.ts";
import { TrashAutomations, layer } from "./trashAutomations.ts";

const storeLayer = Layer.effectDiscard(WorkflowStore.make).pipe(
  Layer.provideMerge(layerMemoryStore),
);
const services = layer.pipe(Layer.provideMerge(storeLayer));

const seedRun = (input: {
  readonly id: string;
  readonly status: string;
  readonly threadId: string;
  readonly parentRunId?: string;
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
          ${input.id}, ${input.threadId}, ${input.parentRunId ?? input.id},
          '2026-10-17T10:00:00.000Z'
        )
      `;
    }),
  );

describe("Trash automation preparation", () => {
  it.effect("retains a shared run family without cancelling its parent", () =>
    Effect.gen(function* () {
      const trash = yield* TrashAutomations;
      const sql = yield* SqlClient.SqlClient;
      yield* seedRun({ id: "parent-run", status: "running", threadId: "trashed-thread" });
      yield* seedRun({
        id: "shared-child",
        status: "running",
        threadId: "surviving-thread",
        parentRunId: "parent-run",
      });

      const prepared = yield* trash.prepareAutomationTrash(["trashed-thread"], "trash-1");
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
      expect(
        yield* sql<{ run_id: string; status: string }>`
          SELECT run_id, status FROM signalbox_automation_runs ORDER BY run_id
        `,
      ).toEqual([
        { run_id: "parent-run", status: "running" },
        { run_id: "shared-child", status: "running" },
      ]);
    }).pipe(Effect.provide(services)),
  );
});
