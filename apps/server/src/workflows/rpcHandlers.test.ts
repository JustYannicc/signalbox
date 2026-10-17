import { expect, it } from "@effect/vitest";
import {
  AUTOMATION_WS_METHODS,
  type AutomationSaveInput,
  ProjectId,
  ProviderInstanceId,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import { automationRpcHandlers } from "./rpcHandlers.ts";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";

const PROJECT = ProjectId.make("project-api");
const SOURCE = "export const meta = { name: 'Inbox' }";
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
const harness = () => {
  const saved: AutomationSaveInput[] = [];
  const engine = {
    validate: (source: string) =>
      source === SOURCE
        ? ({ ok: true, graph: { nodes: [] } } as const)
        : ({ ok: false, diagnostics: [{ line: 1, column: 1, message: "nope" }] } as const),
    save: (input: AutomationSaveInput) => {
      saved.push(input);
      return Effect.succeed({ ok: false, diagnostics: [] } as const);
    },
  } as unknown as WorkflowEngine.WorkflowEngine["Service"];
  const layer = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(projectId === PROJECT ? Option.some(project) : Option.none()),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      initialModelSelection: () => Effect.succeed(model),
    }),
  );
  return { handlers: automationRpcHandlers(engine), saved, layer };
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
