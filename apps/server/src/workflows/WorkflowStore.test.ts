import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

const AT = "2026-10-06T09:00:00.000Z";

const automation = (id: string, projectId: string): WorkflowStore.AutomationRow => ({
  automation_id: id,
  name: "Weekly report",
  description: null,
  enabled: 1,
  version: 1,
  project_id: projectId,
  defaults_json: "{}",
  triggers_json: "[]",
  webhook_token: `hook_${id}`,
  next_run_at: AT,
  created_at: AT,
  updated_at: AT,
  timeout_ms: null,
  overlap: null,
  intent: null,
  draft_version: null,
});

it.effect("a cron firing is claimed once, and never re-enables a paused automation", () =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore.make;
    yield* store.upsertAutomation(automation("automation_1", "project-a"));
    const next = "2026-10-06T10:00:00.000Z";
    expect(yield* store.claimSchedule("automation_1", AT, next)).toBe(true);
    // Another tick that read the same due time loses.
    expect(yield* store.claimSchedule("automation_1", AT, next)).toBe(false);

    yield* store.setSchedule("automation_1", false, null, AT);
    expect(yield* store.claimSchedule("automation_1", next, "2026-10-06T11:00:00.000Z")).toBe(
      false,
    );
    expect(yield* store.getAutomation("automation_1")).toMatchObject({
      enabled: 0,
      next_run_at: null,
    });
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
