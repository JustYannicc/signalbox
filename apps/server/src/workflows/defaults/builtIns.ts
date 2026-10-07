import {
  ProjectId,
  type Automation,
  type AutomationDefaults,
  type AutomationError,
  type AutomationSaveInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { CatalogShape } from "../catalog.ts";
import { automationDefaults } from "../columns.ts";
import { compileWorkflow } from "../compiler/compileWorkflow.ts";
import { fail } from "../errors.ts";
import type { Change } from "../liveFeed.ts";
import { explained } from "../runLog.ts";
import type { AutomationRow, WorkflowStore } from "../WorkflowStore.ts";
import type { HostStore } from "./hostStore.ts";
import { builtInById, builtInByName, builtInOfRow, type BuiltInAutomation } from "./registry.ts";

/** Where a built-in would run: the project, and the defaults its host row starts with there. */
export interface BuiltInPlace {
  readonly projectId: string;
  readonly defaults: AutomationDefaults;
}

export const makeBuiltIns = (deps: {
  readonly store: WorkflowStore;
  readonly hosts: HostStore;
  readonly catalog: CatalogShape;
  readonly changed: (change: Change) => Effect.Effect<void>;
  readonly requireAutomation: (
    automationId: string,
  ) => Effect.Effect<AutomationRow, AutomationError>;
}) => {
  const { store, hosts, catalog } = deps;

  /** The project's own automation named like the built-in, when it isn't the host. */
  const customized = (builtIn: BuiltInAutomation, projectId: string) =>
    store
      .getAutomationByName(projectId, builtIn.name)
      .pipe(Effect.map((row) => (row && !builtInOfRow(row) ? row : undefined)));

  /** The built-in's host row in a project, saved from the code when missing or out of date. */
  const ensureHost = (builtIn: BuiltInAutomation, place: BuiltInPlace) =>
    Effect.gen(function* () {
      const existing = yield* hosts.hostIn(place.projectId, builtIn.slug);
      if (existing && existing.version > 0) {
        const live = yield* store.getVersionView(existing.automation_id, existing.version);
        if (live?.source === builtIn.source) return existing;
      }
      const saved = yield* catalog.save({
        source: builtIn.source,
        projectId: ProjectId.make(place.projectId),
        // A host row keeps the defaults it started with; callers are authorized against them.
        defaults: existing ? automationDefaults(existing) : place.defaults,
        ...(existing ? { automationId: existing.automation_id } : {}),
      });
      if (!saved.ok)
        return yield* fail(
          `The built-in "${builtIn.name}" doesn't compile: ${saved.diagnostics.map((d) => d.message).join(" ")}`,
        );
      yield* hosts.mark(saved.automation.id, builtIn.slug);
      yield* deps.changed({ kind: "automation", automationId: saved.automation.id });
      return yield* deps.requireAutomation(saved.automation.id);
    });

  /**
   * The automation to run for `automationId`: itself, or for `builtin:<slug>`
   * the project's customized copy when there is one, else the built-in's host.
   */
  const resolve = (automationId: string, place: BuiltInPlace | undefined) =>
    Effect.gen(function* () {
      const builtIn = builtInById(automationId);
      if (!builtIn) return yield* deps.requireAutomation(automationId);
      if (!place)
        return yield* fail(
          `Say which project to run "${builtIn.name}" in: attach it to a thread or pass projectId.`,
        );
      return (yield* customized(builtIn, place.projectId)) ?? (yield* ensureHost(builtIn, place));
    });

  /** `w.start` by name falls back to a built-in of that name. */
  const resolveName = (name: string, place: BuiltInPlace) => {
    const builtIn = builtInByName(name);
    return builtIn ? ensureHost(builtIn, place) : Effect.succeed(undefined);
  };

  /** Refuses saves that would change a built-in's host row; only the code changes it. */
  const guardSave = (input: AutomationSaveInput) =>
    Effect.gen(function* () {
      const compiled = compileWorkflow(input.source);
      const target = input.automationId
        ? yield* store.getAutomation(input.automationId)
        : compiled.ok
          ? yield* store.getAutomationByName(input.projectId, compiled.workflow.meta.name)
          : undefined;
      const builtIn = target ? builtInOfRow(target) : undefined;
      if (builtIn)
        return yield* Effect.fail(
          explained(`"${builtIn.name}" runs Signalbox's built-in code and can't be edited.`, {
            fix: `Customize it first (automation_customize, or Customize in the app); then it's the project's own and saves normally.`,
          }),
        );
    });

  /**
   * Makes a built-in the project's own: its host row loses the mark and
   * becomes an ordinary automation, or, where it never ran, a copy is saved
   * under its name. Either way that project runs it from then on.
   */
  const customize = (automationId: string, place: BuiltInPlace) =>
    Effect.gen(function* () {
      const row = builtInById(automationId)
        ? undefined
        : yield* deps.requireAutomation(automationId);
      const builtIn = builtInById(automationId) ?? (row ? builtInOfRow(row) : undefined);
      if (!builtIn) return yield* fail("That automation isn't built in, so it's already editable.");
      const projectId = row?.project_id ?? place.projectId;
      if (yield* customized(builtIn, projectId))
        return yield* fail(`This project already has its own "${builtIn.name}"; edit that one.`);
      const host = yield* hosts.hostIn(projectId, builtIn.slug);
      if (host) {
        yield* hosts.mark(host.automation_id, null);
        yield* deps.changed({ kind: "definition", automationId: host.automation_id });
        return (yield* catalog.get(host.automation_id)).automation;
      }
      const saved = yield* catalog.save({
        source: builtIn.source,
        projectId: ProjectId.make(projectId),
        defaults: place.defaults,
      });
      if (!saved.ok) return yield* fail(`The built-in "${builtIn.name}" doesn't compile.`);
      return saved.automation satisfies Automation;
    });

  return { resolve, resolveName, guardSave, customize };
};

export type BuiltIns = ReturnType<typeof makeBuiltIns>;
