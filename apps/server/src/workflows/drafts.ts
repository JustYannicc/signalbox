import { WorkflowMeta, type Automation, type AutomationError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { fail } from "./errors.ts";
import { toJson } from "./json.ts";
import type { Change } from "./liveFeed.ts";
import { durationMs } from "./stepPolicy.ts";
import { automationView, nextRunAt } from "./views.ts";
import type { AutomationRow, WorkflowStore } from "./WorkflowStore.ts";

/**
 * Drafts: a saved version that isn't live. The automation row keeps describing
 * the live version (`version`), which triggers and runs use; `draft_version`
 * points at the newer one until it's published or discarded. An automation
 * saved only as a draft has `version` 0 and stays off until published.
 */

const decodeMeta = Schema.decodeSync(Schema.fromJsonString(WorkflowMeta));

/** The automation columns a version's `meta` decides; they change when that version goes live. */
export function liveColumns(meta: WorkflowMeta) {
  return {
    name: meta.name,
    description: meta.description ?? null,
    intent: meta.intent ?? null,
    triggers_json: toJson(meta.triggers ?? []),
    timeout_ms: durationMs(meta.timeout),
    overlap: meta.overlap ?? null,
  } satisfies Partial<AutomationRow>;
}

export interface DraftsShape {
  /** Makes the pending draft live. A never-published automation turns on with it. */
  readonly publish: (automationId: string) => Effect.Effect<Automation, AutomationError>;
  /** Drops the pending draft; the live version carries on. */
  readonly discardDraft: (automationId: string) => Effect.Effect<Automation, AutomationError>;
}

export const makeDrafts = (deps: {
  readonly store: WorkflowStore;
  readonly changed: (change: Change) => Effect.Effect<void>;
  readonly requireAutomation: (
    automationId: string,
  ) => Effect.Effect<AutomationRow, AutomationError>;
  readonly relayHookBaseUrl: Effect.Effect<string | null>;
}): DraftsShape => {
  const { store, changed, requireAutomation, relayHookBaseUrl } = deps;

  const publish: DraftsShape["publish"] = (automationId) =>
    Effect.gen(function* () {
      const row = yield* requireAutomation(automationId);
      if (row.draft_version === null)
        return yield* fail("There's no draft to publish.", { automationId });
      const draft = yield* store.getVersion(automationId, row.draft_version);
      if (!draft?.meta_json)
        return yield* fail("The draft's code is missing. Save it again.", { automationId });
      const meta = decodeMeta(draft.meta_json);
      const byName = yield* store.getAutomationByName(row.project_id, meta.name);
      if (byName && byName.automation_id !== automationId) {
        return yield* fail(
          `Another automation in this project is already called "${meta.name}". Rename the draft first.`,
          { automationId },
        );
      }
      const now = yield* DateTime.now;
      const enabled = row.version === 0 || row.enabled === 1;
      const live: AutomationRow = {
        ...row,
        ...liveColumns(meta),
        version: draft.version,
        draft_version: null,
        enabled: enabled ? 1 : 0,
        defaults_json: draft.defaults_json ?? row.defaults_json,
        next_run_at: nextRunAt(meta.triggers ?? [], enabled, now),
        updated_at: DateTime.formatIso(now),
      };
      yield* store.upsertAutomation(live);
      yield* changed({ kind: "definition", automationId });
      return automationView(live, undefined, [], yield* relayHookBaseUrl);
    });

  const discardDraft: DraftsShape["discardDraft"] = (automationId) =>
    Effect.gen(function* () {
      const row = yield* requireAutomation(automationId);
      if (row.draft_version === null)
        return yield* fail("There's no draft to discard.", { automationId });
      if (row.version === 0) {
        return yield* fail(
          "This automation was never published, so the draft is all there is. Delete the automation instead.",
          { automationId },
        );
      }
      // The version row stays: version numbers are never reused.
      const next: AutomationRow = {
        ...row,
        draft_version: null,
        updated_at: DateTime.formatIso(yield* DateTime.now),
      };
      yield* store.upsertAutomation(next);
      yield* changed({ kind: "definition", automationId });
      return automationView(next, undefined, [], yield* relayHookBaseUrl);
    });

  return { publish, discardDraft };
};
