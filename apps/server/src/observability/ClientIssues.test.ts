import {
  AuthSessionId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadShell,
  Project,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { ClientIssue } from "@t3tools/contracts/clientIssues";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

import packageJson from "../../package.json" with { type: "json" };
import * as ClientIssues from "./ClientIssues.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const environmentId = EnvironmentId.make("client-issue-env");
const projectId = ProjectId.make("4eb1a0f2-6f23-4c86-a948-e85b2b69ea8e");
const threadId = ThreadId.make("237a2457-7022-4618-95b7-5383939abe9b");
const unrelatedProjectId = ProjectId.make("d90d15c8-d59a-426a-9e8d-09f305caf384");
const now = DateTime.makeUnsafe("2026-10-17T12:00:00.000Z");
const projectDate = "2026-10-17T12:00:00.000Z";

const project = Schema.decodeSync(Project)({
  id: projectId,
  title: "Test project",
  workspaceRoot: "/tmp/test-project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: projectDate,
  updatedAt: projectDate,
  deletedAt: null,
});

const thread = Schema.decodeSync(OrchestrationV2ThreadShell)({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: "Test thread",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
});

const issue = (overrides: Partial<ClientIssue> = {}): ClientIssue => ({
  code: "console.error",
  severity: "error",
  source: "console",
  client: "web",
  release: "9.8.7",
  threadId: null,
  folderId: null,
  environmentId: "attacker-controlled-environment",
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  method: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  durationMs: 17,
  ...overrides,
});

const makeServiceLayer = (prefix: string) =>
  ClientIssues.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(id === threadId ? thread : null),
        }),
      ),
    ),
  );

it.effect("persists only trusted issue metadata and validated thread context", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(makeServiceLayer("client-issues-test-"));
    const service = Context.get(context, ClientIssues.ClientIssues);
    const fileSystem = Context.get(context, FileSystem.FileSystem);
    const path = Context.get(context, Path.Path);
    const logsDir = Context.get(context, ServerConfig.ServerConfig).logsDir;

    yield* service.report({
      issue: Object.assign(
        issue({
          threadId,
          folderId: unrelatedProjectId,
        }),
        {
          message: "CANARY-RAW-MESSAGE",
          stack: "CANARY-RAW-STACK",
          content: "CANARY-RAW-CONTENT",
        },
      ),
      sessionId: AuthSessionId.make("reporting-session"),
    });
    yield* service.report({
      issue: issue({
        threadId: ThreadId.make("b351cb39-3e8d-419d-9f87-d3e94b0953f2"),
        folderId: ProjectId.make("9c77dd8c-76d5-432c-97ce-4927954f5201"),
        traceId: "abcdef0123456789abcdef0123456789",
        spanId: "abcdef0123456789",
      }),
      sessionId: AuthSessionId.make("reporting-session"),
    });

    const contents = yield* fileSystem.readFileString(
      path.join(logsDir, "client-issues", "events.ndjson"),
    );
    const [validReference, staleReferences] = contents.trimEnd().split("\n");
    expect(validReference).to.include(`"environmentId":"${environmentId}"`);
    expect(validReference).to.include(`"release":"${packageJson.version}"`);
    expect(validReference).to.include('"clientRelease":"9.8.7"');
    expect(validReference).to.include(`"threadId":"${threadId}"`);
    expect(validReference).to.include(`"folderId":"${projectId}"`);
    expect(validReference).to.include('"traceId":"0123456789abcdef0123456789abcdef"');
    expect(validReference).to.include('"spanId":"0123456789abcdef"');
    expect(validReference).not.to.include("attacker-controlled-environment");
    expect(contents).not.to.include("CANARY-RAW-");
    expect(staleReferences).to.include('"threadId":null');
    expect(staleReferences).to.include('"folderId":null');
    expect(staleReferences).to.include('"traceId":"abcdef0123456789abcdef0123456789"');
    expect(staleReferences).to.include('"spanId":"abcdef0123456789"');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects methods outside WsRpcGroup and limits reports per authenticated session", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(makeServiceLayer("client-issues-limit-test-"));
    const service = Context.get(context, ClientIssues.ClientIssues);

    const invalidMethod = yield* service
      .report({
        issue: issue({ method: "not.an.rpc.method" }),
        sessionId: AuthSessionId.make("invalid-method-session"),
      })
      .pipe(
        Effect.as("accepted" as const),
        Effect.catchTags({
          ClientIssuePayloadError: () => Effect.succeed("invalid_payload" as const),
          ClientIssueInvalidMethodError: () => Effect.succeed("invalid_method" as const),
          ClientIssueRateLimitedError: () => Effect.succeed("rate_limited" as const),
          ClientIssuePersistenceError: () => Effect.succeed("persistence_error" as const),
        }),
      );
    expect(invalidMethod).toBe("invalid_method");

    let accepted = 0;
    for (let index = 0; index < 31; index += 1) {
      const result = yield* service
        .report({
          issue: issue(),
          sessionId: AuthSessionId.make("rate-limited-session"),
        })
        .pipe(
          Effect.as("accepted" as const),
          Effect.catchTags({
            ClientIssuePayloadError: () => Effect.succeed("invalid_payload" as const),
            ClientIssueInvalidMethodError: () => Effect.succeed("invalid_method" as const),
            ClientIssueRateLimitedError: () => Effect.succeed("rate_limited" as const),
            ClientIssuePersistenceError: () => Effect.succeed("persistence_error" as const),
          }),
        );
      if (result === "accepted") {
        accepted += 1;
      } else {
        expect(result).toBe("rate_limited");
      }
    }
    expect(accepted).toBe(30);
  }).pipe(Effect.provide(NodeServices.layer)),
);
