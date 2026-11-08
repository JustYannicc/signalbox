import { createNodeFs } from "../../../isolate/NodeFs.ts";
import {
  CodexSettings,
  ProviderDriverKind,
  ThreadId,
  RunId,
  RunAttemptId,
  MessageId,
} from "@t3tools/contracts";
import { CODEX_DEFAULT_INSTANCE_ID } from "@signalbox/provider-codex/defaults";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { makeCodexIsolateAdapter } from "../../CodexIsolateAdapter.ts";
import type { CodexHarnessProcessOptions } from "../../CodexHarnessProcess.ts";
import { dataForDriver } from "../../adapter/tests/data.ts";

const decodeSettings = Schema.decodeEffect(CodexSettings);
const decodeThread = Schema.decodeUnknownEffect(
  Schema.Struct({ id: Schema.String, path: Schema.String }),
);
const decodeMeta = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export async function freshThread(process: CodexHarnessProcessOptions, secret?: string) {
  const fs = createNodeFs(process.computer.files).fs;
  const home = process.bootstrap.codex_home;
  fs.mkdirSync(`${home}/sessions`, { recursive: true });
  fs.writeFileSync(`${home}/sessions/unrelated.jsonl`, "{}\n");
  const stderr: string[] = [];
  const input: string[] = [];
  const decoder = new TextDecoder();
  const unobserve = process.stdio.observeAcceptedWrites((fd, bytes) => {
    if (fd === 0) input.push(decoder.decode(bytes, { stream: true }));
  });
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const data = yield* dataForDriver(ProviderDriverKind.make("codex"));
        const session = {
          threadId: ThreadId.make(process.computer.threadId),
          providerSessionId: data.providerSessionId,
          modelSelection: { instanceId: CODEX_DEFAULT_INSTANCE_ID, model: "gpt-5.5" },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            cwd: process.bootstrap.cwd,
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        };
        const providerThread = {
          ...data.providerThread,
          appThreadId: session.threadId,
          providerInstanceId: session.modelSelection.instanceId,
          nativeThreadRef: null,
        };
        const runtime = yield* makeCodexIsolateAdapter({
          process,
          adapter: {
            defaultCwd: process.bootstrap.cwd,
            instanceId: CODEX_DEFAULT_INSTANCE_ID,
            settings: yield* decodeSettings({}),
            crypto: yield* Crypto.Crypto,
            fileSystem: yield* FileSystem.FileSystem,
            idAllocator: yield* IdAllocator.IdAllocatorV2,
            attachmentsDir: "/work/attachments",
            attachments: {
              resolvePath: () => null,
              resolvePathById: () => null,
              snapshotMcpApp: () => Effect.succeed(undefined),
            },
            clientInfo: { name: "fresh-thread-workerd-fixture", version: "1" },
          },
          mcpSessions: yield* McpProviderSessions.McpProviderSessions,
          modelOrigins: ["http://model.fixture"],
          onStderr: (bytes) =>
            Effect.sync(() => {
              stderr.push(new TextDecoder().decode(bytes));
            }),
        }).open({
          release: { harness: "codex", version: "0.162.1", manifestSha256: "fixture", modules: {} },
          session,
          computer: process.computer,
          modelTransport: process.fetch,
          creation: { providerThread },
        });
        const thread = yield* runtime.ensureThread({
          ...session,
          existingProviderThread: providerThread,
        });
        const snapshot = yield* runtime.readThreadSnapshot({ providerThread: thread });
        const native = yield* decodeThread(snapshot.providerPayload);
        const persisted = fs.readFileSync(native.path, "utf8");
        if (typeof persisted !== "string") throw new Error("Fresh rollout is not text");
        const sessionMeta = yield* decodeMeta(persisted.split("\n")[0]!);
        const completions: string[] = [];
        if (secret !== undefined) {
          for (const ordinal of [1, 2]) {
            yield* runtime.startTurn({
              rootNodeId: data.turn.rootNodeId,
              threadId: session.threadId,
              providerThread: thread,
              runtimePolicy: session.runtimePolicy,
              runId: RunId.make(`auth-${ordinal}`),
              attemptId: RunAttemptId.make(`auth-${ordinal}`),
              runOrdinal: ordinal,
              providerTurnOrdinal: ordinal,
              modelSelection: session.modelSelection,
              appThread: {
                ...data.turn.appThread,
                id: session.threadId,
                providerInstanceId: session.modelSelection.instanceId,
                modelSelection: session.modelSelection,
                activeProviderThreadId: thread.id,
                lineage: { ...data.turn.appThread.lineage, rootThreadId: session.threadId },
              },
              message: {
                ...data.turn.message,
                messageId: MessageId.make(`auth-${ordinal}`),
                text: `Remember this key: ${secret}`,
              },
            });
            const completed = yield* runtime.events.pipe(
              Stream.filter((event) => event.type === "turn.terminal"),
              Stream.runHead,
            );
            const status = Option.isSome(completed) ? completed.value.status : "missing";
            completions.push(status);
            if (status !== "completed") break;
          }
        }
        return {
          completions,
          snapshot: snapshot.providerPayload,
          sessionMeta,
          input: input.join(""),
          nativeId: thread.nativeThreadRef?.nativeId,
          stderr,
        };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
    );
  } catch (cause) {
    throw new Error(`Public Codex creation failed: ${String(cause)}; stderr: ${stderr.join("")}`, {
      cause,
    });
  } finally {
    unobserve();
  }
}
