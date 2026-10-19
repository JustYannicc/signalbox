import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  makeClaudeAdapterV2,
  type ClaudeNativeAdmission,
  type ClaudeNativeReceipt,
  type ClaudeNativeRecoveryBinding,
} from "@signalbox/provider-claude/ClaudeAdapter";
import type { ClaudeAgentSdkQueryOpenInput } from "@signalbox/provider-claude/ClaudeQueryRunner";
import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ClaudeSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";

const decodeSettings = Schema.decodeEffect(ClaudeSettings);
const promptUuid = "00000000-0000-4000-8000-000000000001";

export function recoveryTurn(): ProviderAdapterV2TurnInput {
  const driver = ProviderDriverKind.make("claudeAgent");
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const threadId = ThreadId.make("thread");
  const now = DateTime.makeUnsafe(0);
  const providerThread = {
    id: ProviderThreadId.make("provider-thread"),
    driver,
    providerInstanceId: instanceId,
    providerSessionId: ProviderSessionId.make("provider-session"),
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: "native-session", strength: "strong" as const },
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt: now,
    updatedAt: now,
  };
  const modelSelection = { instanceId, model: "model" };
  return {
    threadId,
    runId: RunId.make("logical-run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("replacement-attempt"),
    rootNodeId: NodeId.make("root"),
    providerThread,
    modelSelection,
    runtimePolicy: { cwd: "/workspace", runtimeMode: "full-access", interactionMode: "default" },
    message: {
      messageId: MessageId.make("message"),
      text: "ORIGINAL PROMPT MUST NOT BE REOFFERED",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    appThread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Recovery",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
}

export function fixture(
  options: {
    fresh?: boolean;
    unbound?: boolean;
    initial?: ReadonlyArray<SDKMessage>;
    denyReservation?: boolean;
  } = {},
) {
  return Effect.gen(function* () {
    const turn = recoveryTurn();
    const messages = yield* Queue.unbounded<SDKMessage>();
    for (const message of options.initial ?? []) yield* Queue.offer(messages, message);
    const receipts: ClaudeNativeReceipt[] = [];
    const offers: SDKUserMessage[] = [];
    const opened: ClaudeAgentSdkQueryOpenInput[] = [];
    const order: string[] = [];
    const continued = yield* Deferred.make<void>();
    const uncertain = yield* Deferred.make<void>();
    const admission: ClaudeNativeAdmission = {
      logicalRunId: turn.runId,
      nativeIncarnationId: "boot-2",
      nativeSessionId: "native-session",
      nativeFiles: { filesystemId: "files", home: "/claude" },
      providerRelease: "2.1.302/0.3.276",
      inputId: turn.message.messageId,
      nativeInputId: promptUuid,
      nativeTurnId: null,
      inputDurability: options.fresh ? "reserved" : "native-file",
    };
    const reference = { id: "native-files", bytes: 1, sha256: "1".repeat(64) };
    const mode: ClaudeNativeRecoveryBinding["mode"] = options.fresh
      ? { type: "new-turn", admission }
      : {
          type: "resume-unfinished",
          plan: {
            status: "ready",
            admission,
            evidence: {
              file: { path: "/claude/session.jsonl", reference },
              stopped: { nativeIncarnationId: "boot-1", reference },
              nativeSessionId: "native-session",
              nativeInputId: promptUuid,
              headLine: 2,
              inputLine: 1,
              pendingNativeCallIds: [],
              state: "unfinished",
            },
          },
        };
    const binding: ClaudeNativeRecoveryBinding = {
      mode,
      beforeNativeStart: () =>
        Effect.suspend(() => {
          order.push("reserve");
          return options.denyReservation
            ? Effect.fail(
                new ProviderAdapterProtocolError({
                  driver: turn.providerThread.driver,
                  detail: "reservation rejected",
                }),
              )
            : Effect.void;
        }),
      observe: (receipt) =>
        Effect.gen(function* () {
          receipts.push(receipt);
          if (receipt.status === "continued") yield* Deferred.succeed(continued, undefined);
          if (receipt.status === "indeterminate") yield* Deferred.succeed(uncertain, undefined);
        }),
    };
    const adapter = yield* makeClaudeAdapterV2({
      ...(options.unbound ? {} : { nativeRecovery: binding }),
      modelCatalog: { models: [] },
      instanceId: turn.modelSelection.instanceId,
      settings: yield* decodeSettings({}),
      environment: { CUSTOM: "preserved" },
      attachmentsDir: "/attachments",
      fileSystem: FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
      path: yield* Path.Path,
      crypto: Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, bytes) => Effect.succeed(bytes),
      }),
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      host: {
        cwd: () => "/workspace",
        taskOutputRoot: () => undefined,
        resolveAttachmentPath: () => null,
        discoverSkills: () => Effect.succeed([]),
        readWorkflowAgentAnswers: () => Effect.succeed([]),
        signedOutMessage: () => "signed out",
      },
      queryRunner: {
        allocateSessionId: Effect.succeed("native-session"),
        assertComplete: Effect.void,
        forkSession: () => Effect.die(new Error("unused fork")),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        open: (input) =>
          Effect.sync(() => {
            order.push("open");
            opened.push(input);
            return {
              messages: Stream.fromQueue(messages),
              offer: (message: SDKUserMessage) =>
                Effect.sync(() => {
                  order.push("offer");
                  offers.push(message);
                }),
              close: Queue.shutdown(messages),
              interrupt: Effect.void,
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              stopTask: () => Effect.void,
              backgroundTasks: () => Effect.succeed(true),
            };
          }),
      },
    });
    const runtime = yield* adapter.openSession({
      threadId: turn.threadId,
      providerSessionId: ProviderSessionId.make("provider-session"),
      modelSelection: turn.modelSelection,
      runtimePolicy: turn.runtimePolicy,
    });
    return {
      runtime,
      turn,
      opened,
      offers,
      order,
      receipts,
      admission,
      continued,
      uncertain,
      send: (message: SDKMessage) => Queue.offer(messages, message),
    };
  });
}
export const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | IdAllocator.IdAllocatorV2
    | McpProviderSessions.McpProviderSessions
    | Path.Path
    | import("effect/Scope").Scope
  >,
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, Path.layer)),
  );
