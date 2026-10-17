import { afterEach, describe, expect, it } from "@effect/vitest";
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
import * as UserDirectory from "../user/UserDirectory.ts";
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

/** The answer's JSON, whether the server sent JSON or one SSE event. */
const bodyOf = (text: string) =>
  text.trimStart().startsWith("{")
    ? text
    : (text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5) ?? "{}");

/** An MCP client of `userId`, through the Worker's `/mcp` with a personal key. */
const connect = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  const handle = cloud.userDirectory.forUser(userId);
  yield* handle.recordSignIn({ id: userId, email: "a@b.c" });
  const created = yield* handle.createLocalKey("agent", {
    scopes: ["orchestration:read", "orchestration:operate", "filesystem:read"],
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

describe("Signalbox's MCP", () => {
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
      expect(names).not.toContain("folders.delete");
      expect(names).not.toContain("keys.create");
      const refused = yield* tool("signalbox_call", {
        operation: "folders.delete",
        input: { id: "folder" },
      });
      expect(refused.isError).toBe(true);
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
