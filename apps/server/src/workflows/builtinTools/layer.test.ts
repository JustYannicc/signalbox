import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { PullRequestOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DeviceService from "../../device/DeviceService.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Sections from "../../sections/Sections.ts";
import * as SectionsStore from "../../sections/SectionsStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as PullRequestReviewGuideService from "../../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import { WorkflowEngine } from "@signalbox/automations/WorkflowEngine";
import * as BuiltinTools from "./layer.ts";
import type { BuiltinToolHandler } from "@signalbox/automations/builtinTools/runner";

const stubs = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
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
          projectId: "project-1",
          runId: "run-1",
          automationName: "Watch",
          runtimeMode: "approval-required",
          requestKey: "run-1/s1",
        })
        .pipe(Effect.asVoid),
    );
    expect(failure.message).toContain("Pass threadId");

    const sectionCall = {
      automationId: "automation-1",
      projectId: "project-1",
      runId: "run-1",
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

it.effect(
  "pull_request_action is an automation step: it acts on the thread's project's pull request",
  () => {
    let registered: BuiltinToolHandler | undefined;
    const ran: unknown[] = [];
    let refuse = false;
    const engine = Layer.mock(WorkflowEngine)({
      validate: () => ({ ok: true, graph: { nodes: [] } }),
      registerBuiltinTools: (handler) =>
        Effect.sync(() => {
          registered = handler;
        }),
      // A pull request service is here, so its reads register too.
      registerPullRequestReads: () => Effect.void,
    });
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (() =>
        Effect.succeed({
          id: "thread-9",
          projectId: "project-1",
          deletedAt: null,
          runtimeMode: "full-access",
          interactionMode: "default",
          pullRequests: [
            {
              host: "github.com",
              repository: "acme/app",
              number: 12,
              url: "https://github.com/acme/app/pull/12",
              source: "agent",
              snapshot: null,
            },
            {
              host: "github.com",
              repository: "acme/app",
              number: 14,
              url: "https://github.com/acme/app/pull/14",
              source: "stack-dismissed",
              snapshot: null,
            },
          ],
        })) as never,
    });
    const pullRequests = Layer.mock(PullRequestService.PullRequestService)({
      runAction: (input) =>
        refuse
          ? Effect.fail(
              new PullRequestOperationError({
                operation: "runAction",
                detail: "already merged",
              }),
            )
          : Effect.sync(() => {
              ran.push(input);
            }),
      detail: () =>
        Effect.succeed({ state: "merged", title: "Fix login", headSha: "abc" } as never),
    });
    return Effect.gen(function* () {
      yield* Layer.build(
        BuiltinTools.layer.pipe(
          Layer.provide(Layer.mergeAll(stubs, engine, NodeServices.layer, threads, pullRequests)),
        ),
      );
      const call = (args: Record<string, unknown>) =>
        registered!.call({
          tool: "pull_request_action",
          args: { threadId: "thread-9", url: "https://github.com/acme/app/pull/12", ...args },
          automationId: "automation-1",
          projectId: "project-1",
          runId: "run-1",
          automationName: "Merge gate",
          runtimeMode: "full-access",
          requestKey: "run-1/s2",
        });
      expect(yield* call({ action: "merge", mergeMethod: "squash" })).toEqual({
        state: "merged",
        moved: false,
      });
      expect(yield* call({ action: "delete-branch" })).toEqual({ state: "merged", moved: false });
      expect(ran).toEqual([
        {
          projectId: "project-1",
          host: "github.com",
          repository: "acme/app",
          number: 12,
          action: "merge",
          mergeMethod: "squash",
        },
        {
          projectId: "project-1",
          host: "github.com",
          repository: "acme/app",
          number: 12,
          action: "delete-branch",
        },
      ]);
      const bad = yield* Effect.flip(
        call({ url: "not a url", action: "merge" }).pipe(Effect.asVoid),
      );
      expect(bad.message).toContain("isn't a pull request URL");
      // A merge step that runs again finds the host already merged it: that's done, not failed.
      refuse = true;
      expect(yield* call({ action: "merge" })).toEqual({ state: "merged", moved: false });
      const closeAgain = yield* Effect.flip(call({ action: "close" }).pipe(Effect.asVoid));
      expect(closeAgain.message).toContain("The host refused to close it");
      refuse = false;
      const unlinked = yield* Effect.flip(
        call({ url: "https://github.com/acme/app/pull/13", action: "merge" }).pipe(Effect.asVoid),
      );
      expect(unlinked.message).toContain("isn't linked to this thread");
      // A stacked pull request the user dismissed is no longer the thread's.
      const dismissed = yield* Effect.flip(
        call({ url: "https://github.com/acme/app/pull/14", action: "merge" }).pipe(Effect.asVoid),
      );
      expect(dismissed.message).toContain("isn't linked to this thread");

      // Commits newer than the approved one: nothing happens.
      const before = ran.length;
      expect(yield* call({ action: "merge", expectedHeadSha: "older" })).toEqual({
        state: "merged",
        moved: true,
      });
      expect(ran).toHaveLength(before);
      expect(
        yield* registered!.call({
          tool: "pull_request_read",
          args: { threadId: "thread-9", url: "https://github.com/acme/app/pull/12" },
          automationId: "automation-1",
          projectId: "project-1",
          runId: "run-1",
          automationName: "Merge gate",
          runtimeMode: "approval-required",
          requestKey: "run-1/s1",
        }),
      ).toEqual({
        repository: "acme/app",
        number: 12,
        title: "Fix login",
        state: "merged",
        headSha: "abc",
      });
    }).pipe(Effect.scoped);
  },
);
