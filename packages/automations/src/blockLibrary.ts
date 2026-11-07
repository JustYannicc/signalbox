import {
  ProjectId,
  type AutomationBlockLibraryEntry,
  type AutomationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { automationDefaults } from "./columns.ts";
import { SavedWorkflowMeta } from "./cronTimezones.ts";
import { preferSavedBlock } from "./blockResolution.ts";
import { PRECOMPILED_BUILT_INS } from "./defaults/precompiled.ts";
import { BUILT_IN_AUTOMATIONS } from "./defaults/registry.ts";
import type { AutomationRow, WorkflowStore } from "./WorkflowStore.ts";

const decodeMeta = Schema.decodeSync(Schema.fromJsonString(SavedWorkflowMeta));

/** Lists the same name winners `w.start` resolves, without materializing built-ins. */
export const makeBlockLibrary = (deps: {
  readonly store: Pick<WorkflowStore, "listAutomationsForProject" | "getVersionMeta">;
  readonly projects: (projectId: string) => Effect.Effect<ReadonlyArray<string>, AutomationError>;
}) => {
  const savedEntry = (row: AutomationRow) =>
    Effect.gen(function* () {
      // Draft-only rows have no runnable live version; show their declared shape
      // while keeping them as the nearest winner instead of falling through.
      const metadataVersion = row.version > 0 ? row.version : row.draft_version;
      const metaJson =
        metadataVersion === null
          ? null
          : yield* deps.store.getVersionMeta(row.automation_id, metadataVersion);
      const meta = metaJson === null ? undefined : decodeMeta(metaJson);
      const defaults = automationDefaults(row);

      return {
        name: row.name,
        description: meta?.description ?? row.description,
        ...(meta?.input === undefined ? {} : { input: meta.input }),
        ...(meta?.output === undefined ? {} : { output: meta.output }),
        source: { type: "folder", projectId: ProjectId.make(row.project_id) },
        availability: {
          enabled: row.enabled === 1,
          hasLiveVersion: row.version > 0,
          runtimeMode: defaults.runtimeMode,
        },
      } satisfies AutomationBlockLibraryEntry;
    });

  const builtInEntries = (): ReadonlyArray<AutomationBlockLibraryEntry> =>
    BUILT_IN_AUTOMATIONS.map((builtIn) => {
      const meta = PRECOMPILED_BUILT_INS[builtIn.slug]?.meta;
      return {
        name: builtIn.name,
        description: builtIn.description,
        ...(meta?.input === undefined ? {} : { input: meta.input }),
        ...(meta?.output === undefined ? {} : { output: meta.output }),
        source: { type: "builtin", slug: builtIn.slug },
        availability: { enabled: true, hasLiveVersion: true, runtimeMode: null },
      } satisfies AutomationBlockLibraryEntry;
    });

  return (projectId: string) =>
    Effect.gen(function* () {
      const winners = new Map<string, AutomationRow>();
      for (const scope of yield* deps.projects(projectId)) {
        const rows = yield* deps.store.listAutomationsForProject(scope);
        for (const row of rows) {
          const winner = preferSavedBlock(winners.get(row.name), row);
          if (winner !== undefined) winners.set(row.name, winner);
        }
      }

      const blocks: AutomationBlockLibraryEntry[] = [];
      for (const row of winners.values()) blocks.push(yield* savedEntry(row));
      for (const builtIn of builtInEntries()) {
        if (!winners.has(builtIn.name)) blocks.push(builtIn);
      }

      return { projectId: ProjectId.make(projectId), blocks };
    });
};
