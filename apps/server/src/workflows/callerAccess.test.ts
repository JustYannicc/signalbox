import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  type Automation,
  type AutomationSaveInput,
  type ModelSelection,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { compileWorkflow } from "@signalbox/automation-compiler/compileWorkflow";
import { AutomationCompiler } from "@signalbox/automations/host";
import type { CallerLimits } from "../mcp/threadAccess.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import { saveForCaller } from "./callerAccess.ts";
import * as ProjectAutomations from "./ProjectAutomations.ts";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";

const PROJECT = ProjectId.make("project-outside");
const SOURCE = `export const meta = { name: "Inbox" } as const;
export default workflow(async (w) => await w.agent("Run", { prompt: "hello" }));`;
const PLAIN_SOURCE = `export const meta = { name: "Plain" } as const;
export default workflow(async () => "hello");`;
const EXPLICIT_SOURCE = `export const meta = { name: "Explicit" } as const;
export default workflow(async (w) => await w.agent("Run", {
  prompt: "hello",
  provider: "codex",
  model: "gpt-5.6-sol",
}));`;
/** An outside client signed in with OAuth: no thread, only its runtime-mode ceiling. */
const OUTSIDE = {
  caller: undefined,
  limits: { runtimeMode: "auto-accept-edits", interactionMode: "default" } satisfies CallerLimits,
};
const codex = (model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model,
});

const project = (defaultModelSelection: ModelSelection | null): Project => ({
  id: PROJECT,
  title: "Outside",
  workspaceRoot: "/tmp/outside",
  defaultModelSelection,
  scripts: [],
  createdAt: "2026-10-06T09:00:00.000Z",
  updatedAt: "2026-10-06T09:00:00.000Z",
  deletedAt: null,
});

/** Records what reaches the engine; saving itself is the engine's business. */
function harness(options: {
  readonly project: Project;
  readonly environmentModel?: ModelSelection;
  readonly noModel?: boolean;
  readonly failModelLookup?: boolean;
  readonly existingAutomationName?: string;
}) {
  const saved: AutomationSaveInput[] = [];
  let modelLookups = 0;
  const automations =
    options.existingAutomationName === undefined
      ? []
      : ([
          {
            id: "automation-existing",
            name: options.existingAutomationName,
            projectId: PROJECT,
          },
        ] as unknown as ReadonlyArray<Automation>);
  const dependencies = Layer.mergeAll(
    Layer.mock(WorkflowEngine.WorkflowEngine)({
      list: () => Effect.succeed(automations),
      validate: () => ({ ok: false, diagnostics: [] }),
      save: (input) => {
        saved.push(input);
        return Effect.succeed({ ok: false, diagnostics: [] } as const);
      },
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(
          projectId === options.project.id ? Option.some(options.project) : Option.none(),
        ),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      initialModelSelection: () => {
        modelLookups += 1;
        if (options.failModelLookup) return Effect.die("unexpected default-model resolution");
        return Effect.succeed(
          options.noModel
            ? null
            : (options.project.defaultModelSelection ??
                options.environmentModel ??
                codex("gpt-6-luna")),
        );
      },
    }),
    Layer.succeed(AutomationCompiler, AutomationCompiler.of({ compile: compileWorkflow })),
  );
  const layer = ProjectAutomations.layer.pipe(Layer.provideMerge(dependencies));
  return {
    saved,
    layer,
    get modelLookups() {
      return modelLookups;
    },
  };
}

it.effect("a caller without a thread saves into the project it names, with its ceiling", () => {
  const { saved, layer } = harness({ project: project(codex("gpt-5.6-sol")) });
  return Effect.gen(function* () {
    yield* saveForCaller(OUTSIDE, { source: SOURCE, projectId: PROJECT });
    expect(saved).toEqual([
      {
        source: SOURCE,
        projectId: PROJECT,
        defaults: {
          modelSelection: codex("gpt-5.6-sol"),
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
        },
      },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("without a project default, a caller without a thread gets the environment's", () => {
  const { saved, layer } = harness({
    project: project(null),
    environmentModel: codex("gpt-5.6-terra"),
  });
  return Effect.gen(function* () {
    yield* saveForCaller(OUTSIDE, { source: SOURCE, projectId: PROJECT });
    expect(saved[0]?.defaults.modelSelection).toEqual(codex("gpt-5.6-terra"));
  }).pipe(Effect.provide(layer));
});

it.effect("saves a plain workflow without looking for a model", () => {
  const test = harness({ project: project(null), noModel: true });
  return Effect.gen(function* () {
    yield* saveForCaller(OUTSIDE, { source: PLAIN_SOURCE, projectId: PROJECT });
    expect(test.saved[0]?.defaults.modelSelection).toBeNull();
    expect(test.modelLookups).toBe(0);
  }).pipe(Effect.provide(test.layer));
});

it.effect("saves explicit agent models without looking for a default", () => {
  const test = harness({ project: project(null), noModel: true });
  return Effect.gen(function* () {
    yield* saveForCaller(OUTSIDE, { source: EXPLICIT_SOURCE, projectId: PROJECT });
    expect(test.saved[0]?.defaults.modelSelection).toBeNull();
    expect(test.modelLookups).toBe(0);
  }).pipe(Effect.provide(test.layer));
});

it.effect("saves a name-based edit without resolving a model", () => {
  const test = harness({
    project: project(null),
    failModelLookup: true,
    existingAutomationName: "Inbox",
  });
  return Effect.gen(function* () {
    yield* saveForCaller(OUTSIDE, { source: SOURCE, projectId: PROJECT });
    expect(test.saved).toHaveLength(1);
    expect(test.modelLookups).toBe(0);
  }).pipe(Effect.provide(test.layer));
});

it.effect("a caller without a thread has to name a project", () => {
  const { saved, layer } = harness({ project: project(null) });
  return Effect.gen(function* () {
    const error = yield* Effect.flip(saveForCaller(OUTSIDE, { source: SOURCE }));
    expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "target_required" });
    expect(error.message).toContain("Pass projectId");
    expect(saved).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("a project that doesn't exist is refused before saving", () => {
  const { saved, layer } = harness({ project: project(null) });
  return Effect.gen(function* () {
    const error = yield* Effect.flip(
      saveForCaller(OUTSIDE, { source: SOURCE, projectId: ProjectId.make("project-missing") }),
    );
    expect(error.message).toContain("doesn't exist");
    expect(saved).toEqual([]);
  }).pipe(Effect.provide(layer));
});
