import {
  WorkflowGraph,
  type Automation,
  type AutomationDefaults,
  type AutomationDetail,
  type AutomationError,
  type AutomationRunDetail,
  type AutomationSaveInput,
  type AutomationSaveResult,
  type WorkflowDiagnostic,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { automationDefaults, automationTriggers, runLogLines, runMarks } from "./columns.ts";
import { compileWorkflow } from "./compiler/compileWorkflow.ts";
import { liveColumns, makeDrafts, type DraftsShape } from "./drafts.ts";
import { fail } from "./errors.ts";
import { fromJson, toJson } from "./json.ts";
import type { Change } from "./liveFeed.ts";
import { nowIso } from "./time.ts";
import { automationView, nextRunAt, runSummary, stepView } from "./views.ts";
import type { AutomationRow, WorkflowStore } from "./WorkflowStore.ts";

/**
 * Saved automations as clients and agents read and change them: compiling and
 * saving versions, listing, reading runs, pausing, and webhook tokens.
 * Running them is the engine's job.
 */

const decodeGraph = Schema.decodeSync(Schema.fromJsonString(WorkflowGraph));
const RUN_HISTORY = 20;
/** Versions never change, so their decoded file and diagram are kept for the views that show them. */
const VERSION_CACHE = 64;

interface VersionView {
  readonly version: number;
  readonly source: string;
  readonly graph: WorkflowGraph;
  readonly savedAt: string;
}

/** Checks the stored defaults of an automation the caller wants to change or run. */
export type AuthorizeAutomation<E> = (current: AutomationDefaults) => Effect.Effect<void, E>;

export interface CatalogShape extends DraftsShape {
  readonly validate: (
    source: string,
  ) =>
    | { readonly ok: true; readonly graph: WorkflowGraph }
    | { readonly ok: false; readonly diagnostics: ReadonlyArray<WorkflowDiagnostic> };
  readonly save: <E = never>(
    input: AutomationSaveInput,
    authorize?: AuthorizeAutomation<E>,
  ) => Effect.Effect<AutomationSaveResult, AutomationError | E>;
  readonly list: () => Effect.Effect<ReadonlyArray<Automation>, AutomationError>;
  readonly get: (automationId: string) => Effect.Effect<AutomationDetail, AutomationError>;
  readonly getRun: (runId: string) => Effect.Effect<AutomationRunDetail, AutomationError>;
  readonly setEnabled: (
    automationId: string,
    enabled: boolean,
  ) => Effect.Effect<Automation, AutomationError>;
  readonly rotateWebhook: (automationId: string) => Effect.Effect<Automation, AutomationError>;
}

export const makeCatalog = (deps: {
  readonly store: WorkflowStore;
  readonly newId: (prefix: string) => Effect.Effect<string, AutomationError>;
  readonly changed: (change: Change) => Effect.Effect<void>;
  readonly requireAutomation: (
    automationId: string,
  ) => Effect.Effect<AutomationRow, AutomationError>;
}): CatalogShape => {
  const { store, newId, changed, requireAutomation } = deps;

  const versions = new Map<string, VersionView>();
  /** A saved version's file and diagram, read and decoded once. */
  const versionView = (automationId: string, version: number) =>
    Effect.gen(function* () {
      const key = `${automationId}@${version}`;
      const cached = versions.get(key);
      if (cached) {
        versions.delete(key);
        versions.set(key, cached);
        return cached;
      }
      const row = yield* store.getVersionView(automationId, version);
      if (!row) return undefined;
      const view: VersionView = {
        version: row.version,
        source: row.source,
        graph: decodeGraph(row.graph_json),
        savedAt: row.created_at,
      };
      versions.set(key, view);
      if (versions.size > VERSION_CACHE) versions.delete(versions.keys().next().value!);
      return view;
    });

  const validate: CatalogShape["validate"] = (source) => {
    const compiled = compileWorkflow(source);
    return compiled.ok
      ? { ok: true, graph: compiled.workflow.graph }
      : { ok: false, diagnostics: compiled.diagnostics };
  };

  const save: CatalogShape["save"] = (input, authorize) =>
    Effect.gen(function* () {
      const compiled = compileWorkflow(input.source);
      if (!compiled.ok) return { ok: false, diagnostics: compiled.diagnostics } as const;
      const { meta, graph, script, runModule } = compiled.workflow;
      const byName = yield* store.getAutomationByName(input.projectId, meta.name);
      const existing = input.automationId ? yield* requireAutomation(input.automationId) : byName;
      if (existing && existing.project_id !== input.projectId) {
        return yield* fail(
          `"${existing.name}" belongs to another project. Save it with that project's projectId, or give this one a new name.`,
          { automationId: existing.automation_id },
        );
      }
      if (byName && existing && byName.automation_id !== existing.automation_id) {
        return yield* fail(`Another automation in this project is already called "${meta.name}".`);
      }
      if (existing && authorize) yield* authorize(automationDefaults(existing));
      const now = yield* DateTime.now;
      const nowText = DateTime.formatIso(now);
      const automationId = existing?.automation_id ?? (yield* newId("automation"));
      // Versions only go up, past drafts that were discarded too.
      const version =
        Math.max(
          existing ? yield* store.latestVersion(automationId) : 0,
          existing?.version ?? 0,
          existing?.draft_version ?? 0,
        ) + 1;
      const published = existing !== undefined && existing.version > 0;
      const fresh = {
        automation_id: automationId,
        project_id: input.projectId,
        defaults_json: toJson(input.defaults),
        webhook_token: existing?.webhook_token ?? (yield* newId("hook")),
        created_at: existing?.created_at ?? nowText,
        updated_at: nowText,
        ...liveColumns(meta),
      };
      const enabled = published ? existing.enabled === 1 : true;
      const row: AutomationRow =
        input.draft && published
          ? // The live version keeps running; only the pointer to the draft moves.
            { ...existing, draft_version: version, updated_at: nowText }
          : input.draft
            ? // Never published: it waits, off, until someone publishes it.
              { ...fresh, enabled: 0, version: 0, draft_version: version, next_run_at: null }
            : // Going live replaces any pending draft.
              {
                ...fresh,
                enabled: enabled ? 1 : 0,
                version,
                draft_version: null,
                next_run_at: nextRunAt(meta.triggers ?? [], enabled, now),
              };
      yield* store.withTransaction(
        Effect.all([
          store.insertVersion({
            automation_id: automationId,
            version,
            source: input.source,
            script,
            run_module: runModule,
            graph_json: toJson(graph),
            meta_json: toJson(meta),
            defaults_json: toJson(input.defaults),
            created_at: nowText,
          }),
          store.upsertAutomation(row),
        ]),
      );
      yield* changed({ kind: "definition", automationId: row.automation_id });
      return { ok: true, automation: automationView(row, undefined), graph } as const;
    });

  const list: CatalogShape["list"] = () =>
    Effect.gen(function* () {
      const latest = new Map((yield* store.latestRuns()).map((run) => [run.automation_id, run]));
      const waiting = Map.groupBy(yield* store.waitingQuestions(), (step) => step.automation_id);
      return (yield* store.listAutomations()).map((row) =>
        automationView(row, latest.get(row.automation_id), waiting.get(row.automation_id)),
      );
    });

  const get: CatalogShape["get"] = (automationId) =>
    Effect.gen(function* () {
      const row = yield* requireAutomation(automationId);
      const live = row.version > 0 ? yield* versionView(automationId, row.version) : undefined;
      const draft =
        row.draft_version === null
          ? undefined
          : yield* versionView(automationId, row.draft_version);
      const version = live ?? draft;
      if (!version) return yield* fail("This automation's code is missing.", { automationId });
      const runs = yield* store.listRuns(automationId, RUN_HISTORY);
      return {
        automation: automationView(row, runs[0], yield* store.waitingQuestions(automationId)),
        source: version.source,
        graph: version.graph,
        runs: runs.map(runSummary),
        draft: draft ?? null,
      };
    });

  const getRun: CatalogShape["getRun"] = (runId) =>
    Effect.gen(function* () {
      const run = yield* store.getRun(runId);
      if (!run) return yield* fail("That run doesn't exist.", { runId });
      const version = yield* versionView(run.automation_id, run.version);
      return {
        run: runSummary(run),
        graph: version?.graph ?? { nodes: [] },
        input: fromJson(run.input_json),
        output: fromJson(run.output_json),
        steps: (yield* store.listSteps(runId)).map(stepView),
        marks: runMarks(run),
        logs: runLogLines(run),
      };
    });

  const setEnabled: CatalogShape["setEnabled"] = (automationId, enabled) =>
    Effect.gen(function* () {
      const row = yield* requireAutomation(automationId);
      if (enabled && row.version === 0)
        return yield* fail("Publish the draft first; nothing is live to turn on yet.", {
          automationId,
        });
      const now = yield* DateTime.now;
      const next = nextRunAt(automationTriggers(row), enabled, now);
      yield* store.setSchedule(automationId, enabled, next, DateTime.formatIso(now));
      yield* changed({ kind: "definition", automationId });
      return automationView({ ...row, enabled: enabled ? 1 : 0, next_run_at: next }, undefined);
    });

  const rotateWebhook: CatalogShape["rotateWebhook"] = (automationId) =>
    Effect.gen(function* () {
      const row = yield* requireAutomation(automationId);
      const token = yield* newId("hook");
      const now = yield* nowIso;
      yield* store.setWebhookToken(automationId, token, now);
      yield* changed({ kind: "automation", automationId });
      return automationView({ ...row, webhook_token: token, updated_at: now }, undefined);
    });

  const drafts = makeDrafts({ store, changed, requireAutomation });

  return { validate, save, list, get, getRun, setEnabled, rotateWebhook, ...drafts };
};
