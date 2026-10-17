import { expect, it } from "@effect/vitest";
import {
  AUTOMATION_WS_METHODS,
  type Automation,
  type AutomationSaveInput,
  ProjectId,
  ProviderInstanceId,
  type Project,
  type WorkflowGraph,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { compileWorkflow } from "@signalbox/automation-compiler/compileWorkflow";
import { AutomationCompiler } from "@signalbox/automations/host";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import { automationRpcHandlers } from "./rpcHandlers.ts";
import * as ProjectAutomations from "./ProjectAutomations.ts";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";

const PROJECT = ProjectId.make("project-api");
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
const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" };

const project: Project = {
  id: PROJECT,
  title: "Signalbox",
  workspaceRoot: "/tmp/signalbox",
  defaultModelSelection: model,
  scripts: [],
  createdAt: "2026-10-15T09:00:00.000Z",
  updatedAt: "2026-10-15T09:00:00.000Z",
  deletedAt: null,
};

/** The RPC handlers over an engine that records saves and compiles nothing. */
const harness = (
  initialModelSelection: typeof model | null = model,
  options: { readonly existingAutomationName?: string; readonly failModelLookup?: boolean } = {},
) => {
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
  const implicitAgent: WorkflowGraph = {
    nodes: [
      {
        type: "step",
        id: "agent",
        line: 1,
        verb: "agent",
        label: { text: "Run", dynamic: false },
        detail: { prompt: { literal: "hello" } },
      },
    ],
  };
  const explicitAgent: WorkflowGraph = {
    nodes: [
      {
        type: "step",
        id: "agent",
        line: 1,
        verb: "agent",
        label: { text: "Run", dynamic: false },
        detail: {
          prompt: { literal: "hello" },
          provider: { literal: "codex" },
          model: { literal: "gpt-5.6-sol" },
        },
      },
    ],
  };
  const engine = {
    list: () => Effect.succeed(automations),
    validate: (source: string) =>
      source === SOURCE
        ? ({ ok: true, graph: implicitAgent } as const)
        : source === PLAIN_SOURCE
          ? ({ ok: true, graph: { nodes: [] } } as const)
          : source === EXPLICIT_SOURCE
            ? ({ ok: true, graph: explicitAgent } as const)
            : ({ ok: false, diagnostics: [{ line: 1, column: 1, message: "nope" }] } as const),
    save: (input: AutomationSaveInput) => {
      saved.push(input);
      return Effect.succeed(
        input.source === "nope"
          ? {
              ok: false,
              diagnostics: [{ line: 1, column: 1, message: "nope" }],
            }
          : { ok: false, diagnostics: [] },
      );
    },
  } as unknown as WorkflowEngine.WorkflowEngine["Service"];
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(projectId === PROJECT ? Option.some(project) : Option.none()),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      initialModelSelection: () => {
        modelLookups += 1;
        if (options.failModelLookup) return Effect.die("unexpected default-model resolution");
        return Effect.succeed(initialModelSelection);
      },
    }),
    Layer.succeed(AutomationCompiler, AutomationCompiler.of({ compile: compileWorkflow })),
    Layer.succeed(WorkflowEngine.WorkflowEngine, engine),
  );
  const layer = ProjectAutomations.layer.pipe(Layer.provideMerge(dependencies));
  return {
    handlers: automationRpcHandlers(engine),
    saved,
    layer,
    get modelLookups() {
      return modelLookups;
    },
  };
};

it.effect("validates a file the way the authoring loop does, without saving it", () =>
  Effect.gen(function* () {
    const { handlers, saved } = harness();
    const validate = handlers[AUTOMATION_WS_METHODS.automationsValidate];
    expect((yield* validate({ source: SOURCE })).ok).toBe(true);
    expect(yield* validate({ source: "nope" })).toEqual({
      ok: false,
      diagnostics: [{ line: 1, column: 1, message: "nope" }],
    });
    expect(saved).toEqual([]);
  }),
);

it.effect("saves into the folder named, with that folder's default model", () => {
  const { handlers, saved, layer } = harness();
  return Effect.gen(function* () {
    yield* handlers[AUTOMATION_WS_METHODS.automationsSave]({
      source: SOURCE,
      projectId: PROJECT,
      draft: true,
    });
    expect(saved).toMatchObject([
      { source: SOURCE, projectId: PROJECT, draft: true, defaults: { modelSelection: model } },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("saves a plain workflow without resolving a model", () => {
  const test = harness(null);
  return Effect.gen(function* () {
    yield* test.handlers[AUTOMATION_WS_METHODS.automationsSave]({
      source: PLAIN_SOURCE,
      projectId: PROJECT,
    });
    expect(test.saved[0]?.defaults.modelSelection).toBeNull();
    expect(test.modelLookups).toBe(0);
  }).pipe(Effect.provide(test.layer));
});

it.effect("requires a default for new workflow code that inherits its model", () => {
  const test = harness(null);
  return Effect.gen(function* () {
    const error = yield* test.handlers[AUTOMATION_WS_METHODS.automationsSave]({
      source: SOURCE,
      projectId: PROJECT,
    }).pipe(Effect.flip);
    expect(error.message).toBe("Choose a default model for this folder or person.");
    expect(test.saved).toEqual([]);
    expect(test.modelLookups).toBe(1);
  }).pipe(Effect.provide(test.layer));
});

it.effect("saves a workflow with explicit models without resolving a default", () => {
  const test = harness(null);
  return Effect.gen(function* () {
    yield* test.handlers[AUTOMATION_WS_METHODS.automationsSave]({
      source: EXPLICIT_SOURCE,
      projectId: PROJECT,
    });
    expect(test.saved[0]?.defaults.modelSelection).toBeNull();
    expect(test.modelLookups).toBe(0);
  }).pipe(Effect.provide(test.layer));
});

it.effect("saves a name-based edit without resolving a model", () => {
  const test = harness(null, { existingAutomationName: "Inbox", failModelLookup: true });
  return Effect.gen(function* () {
    yield* test.handlers[AUTOMATION_WS_METHODS.automationsSave]({
      source: SOURCE,
      projectId: PROJECT,
    });
    expect(test.saved).toHaveLength(1);
    expect(test.modelLookups).toBe(0);
  }).pipe(Effect.provide(test.layer));
});

it.effect("keeps invalid workflow diagnostics without resolving a model", () => {
  const test = harness(null);
  return Effect.gen(function* () {
    const result = yield* test.handlers[AUTOMATION_WS_METHODS.automationsSave]({
      source: "nope",
      projectId: PROJECT,
    });
    expect(result).toEqual({ ok: false, diagnostics: [{ line: 1, column: 1, message: "nope" }] });
    expect(test.modelLookups).toBe(0);
  }).pipe(Effect.provide(test.layer));
});
