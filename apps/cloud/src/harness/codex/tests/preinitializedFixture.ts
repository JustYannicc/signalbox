import { CodexSettings, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { CODEX_DEFAULT_INSTANCE_ID } from "@signalbox/provider-codex/defaults";
import { makeCodexAdapterV2 } from "@signalbox/provider-codex/runtime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as CodexSchema from "effect-codex-app-server/schema";
import type { CodexHarnessProcess } from "../../CodexHarnessProcess.ts";
import { observeCodexReady, makeCodexProcessClient } from "../../CodexTransport.ts";

const encoder = new TextEncoder();
const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Union([Schema.Number, Schema.String]),
      method: Schema.String,
      params: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const settings = Schema.decodeSync(CodexSettings)({});
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  cwd: "/workspace",
  runtimeMode: "full-access",
  interactionMode: "default",
});
export const session = {
  threadId: ThreadId.make("preinitialized-thread"),
  providerSessionId: ProviderSessionId.make("preinitialized-session"),
  modelSelection: { instanceId: CODEX_DEFAULT_INSTANCE_ID, model: "gpt-5.4" },
  runtimePolicy,
};
export const readyLine =
  encode({
    method: "signalbox/ready",
    params: { upstreamVersion: "0.162.1", engineVersion: "0.1.0" },
  }) + "\n";

export function processFixture(beforeReply?: (method: string) => Promise<void>) {
  const started = Promise.withResolvers<"ready-wait" | "outbound">();
  const exited = Promise.withResolvers<{ exitCode: number; signal: number; coreDumped: boolean }>();
  const output = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const source = new ReadableStream<Uint8Array>({
    start: (controller) => output.resolve(controller),
  });
  const observed = observeCodexReady(source);
  const sent: string[] = [];
  const requests: ReturnType<typeof decode>[] = [];
  let stopped = false;
  const stdin = new WritableStream<Uint8Array>({
    async write(bytes) {
      const request = decode(new TextDecoder().decode(bytes));
      sent.push(request.method);
      requests.push(request);
      started.resolve("outbound");
      const frame =
        request.method === "thread/start" ||
        request.method === "thread/resume" ||
        request.method === "thread/read"
          ? {
              id: request.id,
              result: {
                thread: {
                  id: "preinitialized-native-thread",
                  sessionId: "preinitialized-native-thread",
                  forkedFromId: null,
                  preview: "",
                  projectId: null,
                  ephemeral: false,
                  modelProvider: "openai",
                  createdAt: 1782622440,
                  updatedAt: 1782622440,
                  status: { type: "idle" },
                  path: "/home/codex/sessions/preinitialized.jsonl",
                  cwd: "/workspace",
                  cliVersion: "0.162.1",
                  source: "exec",
                  threadSource: null,
                  agentNickname: null,
                  agentRole: null,
                  gitInfo: null,
                  name: null,
                  turns: [],
                },
                model: "gpt-5.4",
                modelProvider: "openai",
                serviceTier: null,
                cwd: "/workspace",
                instructionSources: [],
                approvalPolicy: "never",
                approvalsReviewer: "user",
                sandbox: { type: "dangerFullAccess" },
                reasoningEffort: "medium",
              } satisfies CodexSchema.V2ThreadStartResponse,
            }
          : request.method === "turn/start"
            ? {
                id: request.id,
                result: {
                  turn: { id: "preinitialized-turn", items: [], status: "inProgress" },
                } satisfies CodexSchema.V2TurnStartResponse,
              }
            : {
                id: request.id,
                error: {
                  code: -32600,
                  message: "engine is already initialized; wait for signalbox/ready",
                },
              };
      const reply = async () => {
        await beforeReply?.(request.method);
        const controller = await output.promise;
        if (!stopped) controller.enqueue(encoder.encode(encode(frame) + "\n"));
      };
      if (beforeReply === undefined) await reply();
      else {
        // A delayed native reply does not hold the accepted stdin write open.
        void reply().catch((error) => {
          if (!stopped) observed.fail(error);
        });
      }
    },
  });
  const process: CodexHarnessProcess = {
    get ready() {
      started.resolve("ready-wait");
      return observed.ready;
    },
    stdin,
    stdout: observed.stdout,
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    exited: exited.promise,
    async abort() {
      stopped = true;
      exited.resolve({ exitCode: 0, signal: 15, coreDumped: false });
    },
    async dispose() {
      stopped = true;
    },
  };
  return { process, sent, requests, started: started.promise, output: output.promise };
}

export const adapterOptions = () =>
  Effect.gen(function* () {
    return {
      defaultCwd: "/workspace",
      instanceId: CODEX_DEFAULT_INSTANCE_ID,
      settings,
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      attachmentsDir: "/workspace/attachments",
      attachments: {
        resolvePath: () => null,
        resolvePathById: () => null,
        snapshotMcpApp: () => Effect.succeed(undefined),
      },
      clientInfo: { name: "preinitialized-test", version: "1" },
    };
  });

export function openAdapter(process: CodexHarnessProcess) {
  return Effect.gen(function* () {
    const adapter = yield* makeCodexAdapterV2({
      ...(yield* adapterOptions()),
      environment: {},
      clientFactory: { open: () => makeCodexProcessClient(process) },
    });
    return yield* adapter.openSession(session);
  });
}
