import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, Toolkit } from "effect/ai";
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
    const answered = yield* call("t3_ask_answer", {
      askId: "ask",
      round: 1,
      answers: [{ questionId: "question", value: true }],
      answeredBy: { kind: "person", personId: "spoofed" },
    });
    expect(answered.isError).not.toBe(true);
    expect(dispatched[2]).toMatchObject({
      type: "thread.ask.answer",
      deferredQuestionIds: [],
      answeredBy: { kind: "assistant", personId: "thread-owner", assistantThreadId: threadId },
    });
  }).pipe(Effect.provide(server));
});
