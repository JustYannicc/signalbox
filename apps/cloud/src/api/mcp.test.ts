import { type AuthEnvironmentScope, ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { normalizeTerminalOutput } from "@t3tools/shared/terminalOutput";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import { TrashSnapshot } from "@t3tools/contracts/signalboxTrash";

import { makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";

import * as CloudTokens from "../auth/CloudTokens.ts";
import { signLocalKey } from "../localKeys/LocalKeys.ts";
import { layerConfig, makeMemoryCloud } from "../testing.ts";
import * as Environment from "../environment.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { ThreadEngine } from "../thread/ThreadEngine.ts";
import { turnItemEvent } from "../thread/threadEvents.ts";
import { Threads } from "../thread/Threads.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as UserModelSettings from "../user/UserModelSettings.ts";
import { handleMcpRequest, protectedResourceMetadata } from "./mcpRoutes.ts";

const decodeFolders = Schema.decodeUnknownSync(Schema.fromJsonString(SignalboxFoldersSnapshot));
const decodeTrash = Schema.decodeUnknownSync(Schema.fromJsonString(TrashSnapshot));

const userId = "user_1";
const repos: Array<ReturnType<typeof makeRepo>> = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

const JsonRpcAnswer = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
const ToolResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ text: Schema.String })),
  isError: Schema.optional(Schema.Boolean),
});
const ToolList = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) });
const SearchAnswer = Schema.Struct({
  operations: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const decodeAnswer = Schema.decodeUnknownSync(Schema.fromJsonString(JsonRpcAnswer));
const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);
const decodeToolList = Schema.decodeUnknownEffect(ToolList);
const decodeSearch = Schema.decodeUnknownEffect(Schema.fromJsonString(SearchAnswer));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The answer's JSON, whether the server sent JSON or one SSE event. */
const bodyOf = (text: string) =>
  text.trimStart().startsWith("{")
    ? text
    : (text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5) ?? "{}");

/** An MCP client of `userId`, through the Worker's `/mcp` with a personal key. */
const connectWithScopes = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud();
    const handle = cloud.userDirectory.forUser(userId);
    yield* handle.recordSignIn({ id: userId, email: "a@b.c" });
    const created = yield* handle.createLocalKey("agent", {
      scopes,
      model: false,
    });
    if (created._tag !== "created") throw new Error("no key");
    const layer = Layer.mergeAll(
      CloudTokens.layer.pipe(Layer.provide(layerConfig())),
      Layer.succeed(UserDirectory.UserDirectory, cloud.userDirectory),
    );
    const key = yield* signLocalKey(userId, created.secret).pipe(Effect.provide(layer));
    let session: string | null = null;
    let id = 0;
    const rpc = (method: string, params: object = {}) =>
      handleMcpRequest(
        new Request("https://cloud.test/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(session === null
              ? {}
              : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.flatMap((response) =>
          Effect.promise(async () => {
            session = response.headers.get("mcp-session-id") ?? session;
            return decodeAnswer(bodyOf(await response.text()));
          }),
        ),
      );
    yield* rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const tool = (name: string, args: object) =>
      Effect.flatMap(rpc("tools/call", { name, arguments: args }), (answer) =>
        decodeToolResult(answer.result),
      );
    return { rpc, tool, cloud };
  });

const connect = connectWithScopes([
  "orchestration:read",
  "orchestration:operate",
  "filesystem:read",
]);

describe("Signalbox's MCP", () => {
  it.effect("serves pool advice through an authorized agent key", () =>
    Effect.gen(function* () {
      const { tool } = yield* connectWithScopes(["providers:manage"]);
      const result = yield* tool("signalbox_call", { operation: "pools.advice", input: {} });
      expect(result.isError ?? false).toBe(false);
      expect(JSON.parse(result.content[0]!.text)).toEqual([{ poolId: "personal", providers: [] }]);
      const reader = yield* connect;
      const denied = yield* reader.tool("signalbox_call", { operation: "pools.advice", input: {} });
      expect(denied.isError).toBe(true);
    }),
  );
  it.effect("reads a bounded command output snapshot without waiting for its live stream", () =>
    Effect.gen(function* () {
      const { tool, cloud } = yield* connect;
      const threadId = ThreadId.make("command-thread");
      const itemId = TurnItemId.make("command-item");
      yield* Threads.use((threads) =>
        threads.launch(
          { userId, contextIds: [PERSONAL_CONTEXT_ID] },
          {
            commandId: CommandId.make("command-launch"),
            threadId,
            projectId: Environment.SCRATCH_PROJECT_ID,
            title: "Command output",
            modelSelection: scriptedModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: MessageId.make("command-message"),
              text: "Run a command",
              attachments: [],
            },
          },
        ),
      ).pipe(Effect.provide(cloud.layerFor(userId)));
      const output = `${"old line\n".repeat(10_000)}last line\rfinal line\n`;
      yield* cloud.inThread(
        threadId,
        ThreadEngine.use((engine) =>
          engine.apply((projection, ctx) => {
            const run = projection?.runs[0];
            if (run === undefined) return Effect.die("Expected a run");
            return Effect.succeed({
              events: [
                turnItemEvent(ctx, {
                  id: itemId,
                  threadId,
                  runId: run.id,
                  nodeId: run.rootNodeId,
                  providerThreadId: run.providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 10,
                  status: "running",
                  title: "Print output",
                  startedAt: ctx.now,
                  completedAt: null,
                  updatedAt: ctx.now,
                  type: "command_execution",
                  input: "print output",
                  output,
                }),
              ],
              result: undefined,
            });
          }),
        ),
      );
      const result = yield* tool("signalbox_call", {
        operation: "threads.commandOutput",
        input: { threadId, itemId },
      });
      expect(result.isError ?? false).toBe(false);
      const frame = JSON.parse(result.content[0]!.text);
      expect(frame).toMatchObject({ kind: "replace", running: true, truncated: true });
      expect(normalizeTerminalOutput(frame.text).text).toContain("final line");
      expect(frame.text.length).toBeLessThan(70_000);
      const missing = yield* tool("signalbox_call", {
        operation: "threads.commandOutput",
        input: { threadId: "someone-elses-thread", itemId },
      });
      expect(missing.isError).toBe(true);
      expect(missing.content[0]!.text).not.toContain("final line");
    }),
  );
  it.effect(
    "runs cloud lifecycle actions and reversals through the generated API with receipts",
    () =>
      Effect.gen(function* () {
        const { tool, cloud } = yield* connect;
        const threadId = ThreadId.make("mcp-lifecycle");
        const actor = { userId, contextIds: [PERSONAL_CONTEXT_ID] };
        const call = (operation: string, input: object) =>
          tool("signalbox_call", { operation, input });
        const created = yield* call("threads.create", {
          commandId: "create-lifecycle",
          threadId,
          projectId: "scratch",
          title: "Lifecycle via MCP",
          modelSelection: scriptedModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        });
        expect(created.isError ?? false).toBe(false);
        const snapshot = () => cloud.threadDirectory.forThread(threadId).snapshot(actor);
        for (const [operation, input] of [
          ["threads.pin", { orderKey: "a" }],
          ["threads.pin.reorder", { orderKey: "b" }],
        ] as const) {
          expect(
            (yield* call(operation, { commandId: operation, threadId, ...input })).isError ?? false,
          ).toBe(false);
        }
        expect((yield* snapshot()).projection.thread).toMatchObject({ pinOrderKey: "b" });
        expect((yield* snapshot()).projection.thread.pinnedAt).not.toBeNull();
        yield* call("threads.unpin", { commandId: "unpin", threadId });
        expect((yield* snapshot()).projection.thread.pinnedAt).toBeNull();
        yield* call("threads.autoSettle.set", { commandId: "disable", threadId, enabled: false });
        expect((yield* snapshot()).projection.thread.autoSettleDisabledAt).not.toBeNull();
        yield* call("threads.autoSettle.set", { commandId: "enable", threadId, enabled: true });
        expect((yield* snapshot()).projection.thread.autoSettleDisabledAt).toBeNull();
        const settled = yield* call("threads.settle", { commandId: "settle", threadId });
        expect(settled.isError ?? false).toBe(false);
        expect((yield* snapshot()).projection.thread.settledOverride).toBe("settled");
        yield* call("threads.unsettle", { commandId: "unsettle", threadId, reason: "user" });
        expect((yield* snapshot()).projection.thread.settledOverride).toBe("active");
        const replayed = yield* call("threads.settle", { commandId: "settle", threadId });
        expect(replayed.isError ?? false).toBe(false);
        const decodeReceipt = Schema.decodeUnknownEffect(
          Schema.fromJsonString(OrchestrationV2DispatchCommandResult),
        );
        const originalReceipt = yield* decodeReceipt(settled.content[0]!.text);
        const replayedReceipt = yield* decodeReceipt(replayed.content[0]!.text);
        const summary = yield* cloud.threadDirectory.forThread(threadId).summary(actor);
        expect(replayedReceipt).toEqual({
          sequence: originalReceipt.sequence,
          summaryRevision: summary?.shell.summaryRevision,
        });
        expect(replayedReceipt.summaryRevision).toBeGreaterThan(originalReceipt.summaryRevision!);
        expect((yield* snapshot()).projection.thread.settledOverride).toBe("active");
        yield* call("threads.archive", { commandId: "archive", threadId });
        yield* cloud.settle;
        const archived = yield* call("threads.subscribeArchived", {});
        expect(archived.isError ?? false).toBe(false);
        expect(archived.content[0]!.text).toContain("Lifecycle via MCP");
        yield* call("threads.unarchive", { commandId: "unarchive", threadId });
        yield* cloud.settle;
        expect((yield* call("threads.subscribeArchived", {})).content[0]!.text).not.toContain(
          "Lifecycle via MCP",
        );
      }),
  );

  it.effect("says where clients get a token for this cloud", () =>
    Effect.gen(function* () {
      const response = yield* protectedResourceMetadata(
        new Request("https://cloud.test/.well-known/oauth-protected-resource/mcp"),
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { WORKOS_AUTHKIT_DOMAIN: "example.authkit.app" } }),
          ),
        ),
      );
      expect(yield* Effect.promise(() => response.json())).toEqual({
        resource: "https://cloud.test/mcp",
        authorization_servers: ["https://example.authkit.app"],
        bearer_methods_supported: ["header"],
      });
    }),
  );

  it.effect("sends clients without a token to that metadata", () =>
    Effect.gen(function* () {
      const response = yield* handleMcpRequest(
        new Request("https://cloud.test/mcp", { method: "POST", body: "{}" }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            CloudTokens.layer.pipe(Layer.provide(layerConfig())),
            Layer.succeed(UserDirectory.UserDirectory, makeMemoryCloud().userDirectory),
          ),
        ),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        'resource_metadata="https://cloud.test/.well-known/oauth-protected-resource/mcp"',
      );
    }),
  );

  it.effect("offers two tools however many operations there are", () =>
    Effect.gen(function* () {
      const { rpc } = yield* connect;
      const listed = yield* decodeToolList((yield* rpc("tools/list")).result);
      expect(listed.tools.map((tool) => tool.name)).toEqual(["signalbox_search", "signalbox_call"]);
    }),
  );

  it.effect("finds an operation by intent and calls it as the person", () =>
    Effect.gen(function* () {
      const { tool } = yield* connect;
      const found = yield* tool("signalbox_search", { query: "create a folder", limit: 3 });
      const { operations } = yield* decodeSearch(found.content[0]!.text);
      expect(operations[0]?.name).toBe("folders.create");

      const created = yield* tool("signalbox_call", {
        operation: "folders.create",
        input: { name: "Via MCP", parentId: null },
      });
      expect(created.isError ?? false).toBe(false);
      const listed = yield* tool("signalbox_call", { operation: "folders.list" });
      expect(listed.content[0]!.text).toContain("Via MCP");
    }),
  );

  it.effect("creates a thread without a model using the person's saved default", () =>
    Effect.gen(function* () {
      const { tool, cloud } = yield* connect;
      const preferred = {
        instanceId: ProviderInstanceId.make("claude_hub"),
        model: "claude-haiku-5-5",
      };
      yield* UserModelSettings.UserModelSettings.use((settings) =>
        settings.update(
          { defaultModelSelection: preferred },
          new Map([[preferred.instanceId, new Set([preferred.model])]]),
        ),
      ).pipe(Effect.provide(cloud.userObject(userId)));
      const result = yield* tool("signalbox_call", {
        operation: "threads.create",
        input: {
          commandId: "mcp-default",
          projectId: Environment.SCRATCH_PROJECT_ID,
          title: "From MCP",
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        },
      });
      expect(result.isError ?? false).toBe(false);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        projection: { thread: { modelSelection: preferred } },
      });
    }),
  );

  it.effect("serves cloud refs and immutable diff contents through MCP", () =>
    Effect.gen(function* () {
      const { tool, cloud } = yield* connect;
      const git = makeRepo();
      repos.push(git);
      git.write("file.txt", "from MCP\n");
      const headRef = git.commit("files");
      const driveId = "my/personal/user_1";
      yield* uploadPack({ driveId, threadId: "t1", ...git.pack([headRef]) }).pipe(
        Effect.provide(cloud.drives.layer),
      );
      const contents = yield* tool("signalbox_call", {
        operation: "review.getDiffFileContents",
        input: {
          cwd: `/drives/${driveId}`,
          sourceKind: "branch-range",
          changeType: "new",
          baseRef: null,
          headRef,
          oldPath: "file.txt",
          newPath: "file.txt",
        },
      });
      expect(contents.isError ?? false).toBe(false);
      expect(contents.content[0]!.text).toContain('"newContents":"from MCP\\n"');
      const refs = yield* tool("signalbox_call", {
        operation: "vcs.listRefs",
        input: { cwd: "/host/path" },
      });
      expect(refs.isError ?? false).toBe(false);
      expect(refs.content[0]!.text).toContain('"isRepo":false');
    }),
  );

  it.effect("never offers or runs what only a person may do", () =>
    Effect.gen(function* () {
      const { tool } = yield* connect;
      const found = yield* tool("signalbox_search", {
        query: "answer respond approval delete folder key",
      });
      const names = (yield* decodeSearch(found.content[0]!.text)).operations.map(
        (operation) => operation.name,
      );
      expect(names).not.toContain("threads.respond");
      expect(names).not.toContain("threads.dismissQuestion");
      expect(names).not.toContain("secrets.answer");
      expect(names).not.toContain("folders.delete");
      expect(names).not.toContain("keys.create");
      const refused = yield* tool("signalbox_call", {
        operation: "folders.delete",
        input: { id: "folder" },
      });
      expect(refused.isError).toBe(true);
      for (const operation of ["threads.respond", "threads.dismissQuestion", "secrets.answer"]) {
        const answer = yield* tool("signalbox_call", { operation, input: {} });
        expect(answer.isError).toBe(true);
        expect(answer.content[0]?.text).toContain(`No operation ${operation} you can call`);
      }
    }),
  );

  it.effect("offers recoverable Trash but keeps permanent cleanup out of agent tools", () =>
    Effect.gen(function* () {
      const { tool } = yield* connect;
      const call = (operation: string, input: object = {}) =>
        tool("signalbox_call", { operation, input });
      const found = yield* tool("signalbox_search", { query: "empty trash", limit: 3 });
      expect(
        (yield* decodeSearch(found.content[0]!.text)).operations.map((row) => row.name),
      ).not.toContain("trash.empty");
      const created = yield* call("folders.create", { name: "MCP trash", parentId: null });
      const folder = decodeFolders(created.content[0]!.text).folders[0]!;
      const moved = yield* call("trash.folder", { folderId: folder.id });
      expect(moved.isError ?? false).toBe(false);
      const entry = decodeTrash(moved.content[0]!.text).entries[0]!;
      expect((yield* call("trash.restore", { id: entry.id })).isError ?? false).toBe(false);
      const movedAgain = yield* call("trash.folder", { folderId: folder.id });
      const next = decodeTrash(movedAgain.content[0]!.text).entries.find(
        (row) => row.status === "trashed",
      )!;
      const emptied = yield* call("trash.empty", { ids: [next.id] });
      expect(emptied.isError).toBe(true);
      const listed = yield* call("trash.list");
      expect(
        decodeTrash(listed.content[0]!.text).entries.find((row) => row.id === next.id)?.status,
      ).toBe("trashed");
    }),
  );
});

describe("MCP queue operations", () => {
  it.effect("uses the same durable queue and reports stale edits and reorders", () =>
    Effect.gen(function* () {
      const { tool } = yield* connect;
      const call = (operation: string, input: object) =>
        tool("signalbox_call", { operation, input });
      expect(
        (yield* call("threads.create", {
          commandId: "mcp-queue-launch",
          threadId: "mcp-queue",
          projectId: Environment.SCRATCH_PROJECT_ID,
          title: "MCP Queue",
          modelSelection: scriptedModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: "Live", attachments: [] },
        })).isError ?? false,
      ).toBe(false);
      for (const n of [2, 3]) {
        expect(
          (yield* call("threads.send", {
            commandId: `mcp-queue-send-${n}`,
            threadId: "mcp-queue",
            createdBy: "user",
            creationSource: "mcp",
            messageId: `mcp-queue-message-${n}`,
            text: `Queued ${n}`,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          })).isError ?? false,
        ).toBe(false);
      }
      const threadId = "mcp-queue";
      const second = "run:mcp-queue:2";
      const third = "run:mcp-queue:3";
      expect(
        (yield* call("threads.queuedRun.edit", {
          commandId: "mcp-edit",
          threadId,
          runId: second,
          text: "Edited through MCP",
        })).isError ?? false,
      ).toBe(false);
      expect(
        (yield* call("threads.queuedRun.reorder", {
          commandId: "mcp-reorder",
          threadId,
          runId: third,
          beforeRunId: second,
        })).isError ?? false,
      ).toBe(false);
      const snapshot = yield* call("threads.get", { threadId });
      const value = yield* decodeJson(snapshot.content[0]!.text);
      expect(value).toMatchObject({
        messages: expect.arrayContaining([expect.objectContaining({ text: "Edited through MCP" })]),
        runs: expect.arrayContaining([
          expect.objectContaining({ id: third, status: "queued", queuePosition: 1 }),
          expect.objectContaining({ id: second, status: "queued", queuePosition: 2 }),
        ]),
      });
      yield* call("threads.queuedRun.cancel", { threadId, runId: second });
      for (const [operation, input] of [
        ["threads.queuedRun.edit", { threadId, runId: second, text: "Stale" }],
        ["threads.queuedRun.reorder", { threadId, runId: second, beforeRunId: null }],
      ] as const) {
        const stale = yield* call(operation, input);
        expect(stale.isError).toBe(true);
        expect(stale.content[0]!.text).toContain("OrchestrationV2DispatchCommandError");
      }
    }),
  );
});
