import { makeCodexAdapterV2, type CodexAdapterV2Options } from "@signalbox/provider-codex/runtime";
import {
  CheckpointId,
  CodexSettings,
  EnvironmentId,
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { recoveryTurn } from "./nativeRecoveryTestData.ts";

const decode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      method: Schema.String,
      params: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeEffect(CodexSettings);
export const operations = ["start", "resume", "fork", "rollback"] as const;
export const targetThreadId = ThreadId.make("fork-target");
export const fallbackEndpoint = "http://fallback.invalid/mcp";

const threadResult = {
  thread: {
    id: "native-session",
    sessionId: "native-session",
    forkedFromId: null,
    projectId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: "/codex/session.jsonl",
    cwd: "/workspace",
    cliVersion: "0.162.1",
    source: "vscode",
    threadSource: "user",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  },
  model: "model",
  modelProvider: "openai",
  serviceTier: null,
  cwd: "/workspace",
  instructionSources: [],
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: { type: "dangerFullAccess" },
  reasoningEffort: null,
} satisfies CodexSchema.V2ThreadStartResponse;

export const fixture = (
  mcpServers?: CodexAdapterV2Options["mcpServers"],
  options: { readonly hold?: "initialize" | "thread/read" } = {},
) =>
  Effect.gen(function* () {
    const turn = recoveryTurn();
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    for (const threadId of [turn.threadId, targetThreadId])
      yield* sessions.set({
        threadId,
        environmentId: EnvironmentId.make("environment"),
        providerSessionId: "provider-session",
        providerInstanceId: turn.modelSelection.instanceId,
        endpoint: fallbackEndpoint,
        authorizationHeader: "Bearer fixture",
        browserToolsAvailable: false,
      });
    const inbound = yield* Queue.unbounded<Uint8Array>();
    const requestHeld = yield* Deferred.make<void>();
    const requestRelease = yield* Deferred.make<void>();
    const requests: { method: string; params: unknown }[] = [];
    const client = yield* CodexClient.make(
      Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.fromQueue(inbound),
        stderr: () => Sink.drain,
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.gen(function* () {
              const request = yield* decode(
                typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
              ).pipe(Effect.orDie);
              if (request.method === "initialized") return;
              requests.push({ method: request.method, params: request.params });
              if (request.method === options.hold) {
                yield* Deferred.succeed(requestHeld, undefined);
                yield* Deferred.await(requestRelease);
              }
              let result: unknown;
              switch (request.method) {
                case "initialize":
                  result = {
                    userAgent: "fixture",
                    codexHome: "/codex",
                    platformFamily: "unix",
                    platformOs: "linux",
                  };
                  break;
                case "thread/start":
                case "thread/resume":
                case "thread/fork":
                case "thread/revert":
                  result = threadResult;
                  break;
                case "thread/read":
                  result = { thread: { historyMode: "paginated", status: { type: "notLoaded" } } };
                  break;
                case "thread/turns/list":
                  result = {
                    data: [{ id: "turn-1", status: "completed", items: [] }],
                    nextCursor: null,
                    prevCursor: null,
                  };
                  break;
                default:
                  return yield* Effect.die(
                    new Error(`Unexpected native request ${request.method}`),
                  );
              }
              yield* Queue.offer(
                inbound,
                new TextEncoder().encode(
                  (yield* encode({ id: request.id, result }).pipe(Effect.orDie)) + "\n",
                ),
              );
            }),
          ),
      }),
    );
    const adapter = yield* makeCodexAdapterV2({
      ...(mcpServers === undefined ? {} : { mcpServers }),
      defaultCwd: "/workspace",
      instanceId: turn.modelSelection.instanceId,
      settings: yield* decodeSettings({}),
      environment: {},
      clientFactory: { open: () => Effect.succeed(client) },
      crypto: Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, bytes) => Effect.succeed(bytes),
      }),
      fileSystem: FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      attachmentsDir: "/attachments",
      attachments: {
        resolvePath: () => null,
        resolvePathById: () => null,
        snapshotMcpApp: () => Effect.succeed(undefined),
      },
      clientInfo: { name: "mcp-contract-test", version: "1" },
    });
    const runtime = yield* adapter.openSession({
      threadId: turn.threadId,
      providerSessionId: ProviderSessionId.make("provider-session"),
      modelSelection: turn.modelSelection,
      runtimePolicy: turn.runtimePolicy,
    });
    const exercise = (operation: (typeof operations)[number]) =>
      Effect.gen(function* () {
        switch (operation) {
          case "start":
            return yield* runtime.ensureThread({
              threadId: turn.threadId,
              modelSelection: turn.modelSelection,
              runtimePolicy: turn.runtimePolicy,
            });
          case "resume":
            return yield* runtime.resumeThread({ providerThread: turn.providerThread });
          case "fork":
            return yield* runtime.forkThread({
              sourceProviderThread: turn.providerThread,
              targetThreadId,
            });
          case "rollback":
            return yield* runtime.rollbackThread({
              providerThread: turn.providerThread,
              target: {
                type: "thread_start",
                checkpointId: CheckpointId.make("checkpoint"),
                appRunOrdinal: 0,
              },
              providerThreadTurns: [
                {
                  id: ProviderTurnId.make("provider-turn"),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver: turn.providerThread.driver,
                    nativeId: "turn-1",
                    strength: "strong",
                  },
                  ordinal: 1,
                  status: "completed",
                  startedAt: turn.appThread.createdAt,
                  completedAt: turn.appThread.createdAt,
                },
              ],
            });
        }
      });
    return {
      runtime,
      turn,
      requests,
      exercise,
      requestHeld: Deferred.await(requestHeld),
      releaseRequest: Deferred.succeed(requestRelease, undefined),
    };
  });

export const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | IdAllocator.IdAllocatorV2
    | McpProviderSessions.McpProviderSessions
    | import("effect/Scope").Scope
  >,
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer)),
  );
