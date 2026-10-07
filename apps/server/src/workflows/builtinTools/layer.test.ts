import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DeviceService from "../../device/DeviceService.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Sections from "../../sections/Sections.ts";
import * as SectionsStore from "../../sections/SectionsStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import { WorkflowEngine } from "../WorkflowEngine.ts";
import * as BuiltinTools from "./layer.ts";
import type { BuiltinToolHandler } from "./runner.ts";

const stubs = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed("environment-test" as never),
  }),
  Sections.layer.pipe(
    Layer.provide(SectionsStore.layer),
    Layer.provide(ProjectStore.layer),
    Layer.provide(Sqlite.layerMemory),
    Layer.provide(NodeCrypto.layer),
  ),
);

it.effect("hands the engine Signalbox's MCP handlers, calling as a thread-less client", () => {
  let registered: BuiltinToolHandler | undefined;
  const engine = Layer.mock(WorkflowEngine)({
    validate: () => ({ ok: true, graph: { nodes: [] } }),
    registerBuiltinTools: (handler) =>
      Effect.sync(() => {
        registered = handler;
      }),
  });
  return Effect.gen(function* () {
    yield* Layer.build(
      BuiltinTools.layer.pipe(Layer.provide(Layer.mergeAll(stubs, engine, NodeServices.layer))),
    );
    const tools = registered!.tools;
    expect(tools).toEqual(
      expect.arrayContaining(["t3_thread_send", "list_thread_pull_requests", "t3_project_list"]),
    );
    for (const left of ["delegate_task", "request_secret", "preview_open", "automation_run"])
      expect(tools).not.toContain(left);

    // Without a calling thread, "this thread" isn't a thing: the handler says so.
    const failure = yield* Effect.flip(
      registered!
        .call({
          tool: "list_thread_pull_requests",
          args: {},
          automationId: "automation-1",
          automationName: "Watch",
          runtimeMode: "approval-required",
          requestKey: "run-1/s1",
        })
        .pipe(Effect.asVoid),
    );
    expect(failure.message).toContain("Pass threadId");

    const sectionCall = {
      automationId: "automation-1",
      automationName: "Organize projects",
      requestKey: "run-1/sections",
    };
    const denied = yield* Effect.flip(
      registered!
        .call({
          ...sectionCall,
          tool: "t3_section_create",
          args: { name: "Scheduled", parentId: null },
          runtimeMode: "approval-required",
        })
        .pipe(Effect.asVoid),
    );
    expect(denied.message).toContain("full-access");

    const created = yield* registered!.call({
      ...sectionCall,
      tool: "t3_section_create",
      args: { name: "Scheduled", parentId: null },
      runtimeMode: "full-access",
    });
    expect(created).toMatchObject({ revision: 1, sections: [{ name: "Scheduled" }] });
    const listed = yield* registered!.call({
      ...sectionCall,
      tool: "t3_section_list",
      args: {},
      runtimeMode: "approval-required",
    });
    expect(listed).toEqual(created);
  }).pipe(Effect.scoped);
});
