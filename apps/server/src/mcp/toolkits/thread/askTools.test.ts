import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  RuntimeRequestId,
  NodeId,
  ProviderSessionId,
  TurnItemId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, Toolkit } from "effect/ai";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { askHandlers } from "./askHandlers.ts";
import { askTools } from "./askTools.ts";

const toolkit = Toolkit.make(...askTools);
const threadId = ThreadId.make("thread:assistant");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:test"),
  requestNamespace: "ask-tools",
  issuedAt: 1,
  capabilities: new Set(["orchestration"]),
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "session:test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "ask-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ask-test", version: "1" },
  },
  getClient: Effect.die("Not used"),
});
const call = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name, arguments: args });
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

it.effect("forces agent source and assistant answer provenance, with stable retry IDs", () => {
  const dispatched: OrchestrationV2ServerCommand[] = [];
  const server = McpHttpServer.toolkitRegistration(
    toolkit,
    McpToolAccess.toLayer(toolkit, askHandlers),
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
        getProjectThreadRecords: ({ threadId: id }) =>
          Effect.succeed(idleThreadProjection(liveThreadShell(id))),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 12, storedEvents: [] };
          }),
      }),
    ),
  );
  return Effect.gen(function* () {
    const input = {
      clientRequestId: "retry",
      kind: "ready",
      source: { kind: "native", requestId: "fake" },
      questions: [
        {
          id: "question",
          question: "Ship?",
          why: "Prepared",
          unblocks: "Release",
          recommendation: true,
          options: [],
          blocking: false,
          decisionOwner: "Owner",
          surface: { kind: "kit", component: "text" },
        },
      ],
    };
    expect((yield* call("t3_ask_raise", input)).isError).not.toBe(true);
    yield* call("t3_ask_raise", input);
    expect(dispatched[0]?.commandId).toBe(dispatched[1]?.commandId);
    expect(dispatched[0]).toMatchObject({
      type: "thread.ask.raise",
      ask: { source: { kind: "agent" } },
    });
    expect((yield* call("t3_ask_raise", { ...input, kind: "considering" })).isError).toBe(true);
    const considering = yield* call("t3_ask_raise", {
      ...input,
      clientRequestId: "considering",
      kind: "considering",
      considering: {
        exit: { kind: "evidence", reference: "support ticket update" },
        preparationAttachmentIds: [],
      },
    });
    expect(considering.isError).not.toBe(true);
    expect(dispatched[2]).toMatchObject({
      type: "thread.ask.raise",
      ask: {
        kind: "considering",
        considering: { exit: { kind: "evidence" }, preparationAttachmentIds: [] },
      },
    });
    const answered = yield* call("t3_ask_answer", {
      askId: "ask",
      round: 1,
      answers: [{ questionId: "question", value: true }],
      answeredBy: { kind: "person", personId: "spoofed" },
    });
    expect(answered.isError).not.toBe(true);
    expect(dispatched[3]).toMatchObject({
      type: "thread.ask.answer",
      deferredQuestionIds: [],
      answeredBy: { kind: "assistant", personId: "local-user", assistantThreadId: threadId },
    });
  }).pipe(Effect.provide(server));
});

it.effect(
  "attributes native answers to the authenticated assistant instead of supplied provenance",
  () => {
    const dispatched: OrchestrationV2ServerCommand[] = [];
    const shell = liveThreadShell(threadId);
    const requestId = RuntimeRequestId.make("native-question");
    const nodeId = NodeId.make("native-node");
    const projection = {
      ...idleThreadProjection(shell),
      runtimeRequests: [
        {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: {
            type: "live",
            providerSessionId: ProviderSessionId.make("native-session"),
          },
          createdAt: shell.createdAt,
          resolvedAt: null,
        },
      ],
      turnItems: [
        {
          id: TurnItemId.make("native-item"),
          threadId,
          runId: null,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          title: "City",
          ordinal: 1,
          status: "waiting",
          startedAt: shell.createdAt,
          completedAt: null,
          updatedAt: shell.updatedAt,
          type: "user_input_request",
          requestId,
          questions: [{ id: "city", header: "City", question: "Which city?", options: [] }],
        },
      ],
    } satisfies OrchestrationV2ThreadProjection;
    const server = McpHttpServer.layerThreadToolkit.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          getProjectThreadRecords: () => Effect.succeed(projection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 13, storedEvents: [] };
            }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const result = yield* call("t3_pending_request_respond", {
        requestId,
        answers: { city: "Bern" },
        answeredBy: {
          kind: "person",
          personId: "forged-person",
          assistantThreadId: "forged-thread",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(dispatched).toMatchObject([
        {
          type: "thread.native-ask.respond",
          requestId,
          answers: { city: "Bern" },
          answeredBy: { kind: "assistant", personId: "local-user", assistantThreadId: threadId },
        },
      ]);
    }).pipe(Effect.provide(server));
  },
);
