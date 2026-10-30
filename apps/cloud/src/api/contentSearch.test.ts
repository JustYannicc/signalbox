import { workosStubLayer } from "@signalbox/account/WorkOSTesting";
import {
  AuthFilesystemReadScope,
  type ProjectSearchContentsInput,
  ProjectSearchContentsResult,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CloudTokens from "../auth/CloudTokens.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { threadRef } from "../drive/DriveStore.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import { signLocalKey } from "../localKeys/LocalKeys.ts";
import { layerConfig, makeMemoryCloud } from "../testing.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { handleApiRequest } from "./apiRoutes.ts";
import { handleMcpRequest } from "./mcpRoutes.ts";

const userId = "user_content_search";
const driveId = `my/personal/${userId}`;
const sentence = "The cobalt orchard only blooms after midnight.";
const request: ProjectSearchContentsInput = {
  cwd: `/drives/${driveId}`,
  query: sentence,
  limit: 20,
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
};
const completed = {
  matches: [
    {
      path: "z-result.md",
      lineNumber: 2,
      lineContent: sentence,
      matchRanges: [{ start: 0, end: sentence.length }],
    },
  ],
  truncated: false,
};
const repos: Array<ReturnType<typeof makeRepo>> = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

const decodeSearch = Schema.decodeUnknownSync(Schema.fromJsonString(ProjectSearchContentsResult));
const decodeAnswer = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.Unknown),
    }),
  ),
);
const decodeTool = Schema.decodeUnknownSync(
  Schema.Struct({
    content: Schema.Array(Schema.Struct({ text: Schema.String })),
    isError: Schema.optional(Schema.Boolean),
  }),
);
const bodyOf = (text: string) =>
  text.trimStart().startsWith("{")
    ? text
    : (text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5) ?? "{}");

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  const user = cloud.userDirectory.forUser(userId);
  yield* user.recordSignIn({ id: userId, email: "content-search@example.test" });
  const git = makeRepo();
  repos.push(git);
  for (let file = 0; file < 512; file++) {
    git.write(`a-${String(file).padStart(3, "0")}.txt`, "excluded text\n");
  }
  git.write(".gitignore", "a-*.txt\n");
  git.write("z-result.md", `Searchable prose\n${sentence}\n`);
  // Keep ignored files in the tree so each exclusion spends the scanner's entry budget.
  git.git(["add", "--force", "."]);
  const head = git.commit("Content search pages");
  expect(git.git(["ls-files"])).not.toContain(sentence);
  yield* Effect.gen(function* () {
    const threadId = "content-search-writer";
    expect((yield* uploadPack({ driveId, threadId, ...git.pack([head]) }))._tag).toBe("ok");
    const drive = (yield* DriveDirectory).forDrive(driveId);
    const writer = { threadId, userId, generation: 1, live: true, packsAfter: 0 };
    const opened = yield* drive.open(writer);
    if (opened._tag !== "ok") return yield* Effect.die(opened);
    expect(
      (yield* drive.updateRefs(writer, [
        {
          name: threadRef(threadId),
          old: opened.refs.thread,
          new: head,
        },
      ]))._tag,
    ).toBe("ok");
    expect(
      (yield* drive.reconcile(writer, {
        expectedMain: opened.refs.main,
        newMain: head,
      }))._tag,
    ).toBe("ok");
  }).pipe(Effect.provide(cloud.drives.layer));

  const created = yield* user.createLocalKey("Content search caller", {
    scopes: [AuthFilesystemReadScope],
    model: false,
  });
  if (created._tag !== "created") return yield* Effect.die("Missing test API key.");
  const layer = Layer.mergeAll(
    CloudTokens.layer.pipe(Layer.provide(layerConfig())),
    layerConfig(),
    Layer.succeed(UserDirectory.UserDirectory, cloud.userDirectory),
    workosStubLayer({}),
  );
  const key = yield* signLocalKey(userId, created.secret).pipe(Effect.provide(layer));
  const raw = (body: ProjectSearchContentsInput) =>
    handleApiRequest(
      new Request("https://cloud.test/api/v1/projects.searchContents", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.flatMap((response) =>
        Effect.promise(async () => {
          expect(response.status).toBe(200);
          return decodeSearch(await response.text());
        }),
      ),
    );

  let session: string | null = null;
  let id = 0;
  const rpc = (method: string, params: object) =>
    handleMcpRequest(
      new Request("https://cloud.test/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(session === null
            ? {}
            : {
                "mcp-session-id": session,
                "mcp-protocol-version": "2025-06-18",
              }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.flatMap((response) =>
        Effect.promise(async () => {
          expect(response.status).toBe(200);
          session = response.headers.get("mcp-session-id") ?? session;
          return decodeAnswer(bodyOf(await response.text()));
        }),
      ),
    );
  yield* rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "content-search-test", version: "1" },
  });
  const mcp = (body: ProjectSearchContentsInput) =>
    Effect.gen(function* () {
      const answer = yield* rpc("tools/call", {
        name: "signalbox_call",
        arguments: { operation: "projects.searchContents", input: body },
      });
      expect(answer.error).toBeUndefined();
      const tool = decodeTool(answer.result);
      expect(tool.isError ?? false).toBe(false);
      const text = tool.content[0]?.text;
      if (text === undefined) return yield* Effect.die("Missing MCP search result.");
      return decodeSearch(text);
    });
  return { raw, mcp };
});

type Search = Effect.Success<typeof setup>["raw" | "mcp"];
const follow = (search: Search, replay: Search, firstCursor: string) =>
  Effect.gen(function* () {
    const pages: ProjectSearchContentsResult[] = [];
    let cursor = firstCursor;
    for (let index = 0; index < 20; index++) {
      const continuation = { ...request, cursor };
      const page = yield* search(continuation);
      expect(yield* search(continuation)).toEqual(page);
      expect(yield* replay(continuation)).toEqual(page);
      pages.push(page);
      if (page.nextCursor === undefined) {
        expect(page.truncated).toBe(false);
        return { ...page, matches: pages.flatMap((result) => result.matches) };
      }
      expect(page.truncated).toBe(true);
      cursor = page.nextCursor;
    }
    return yield* Effect.die("Content search did not finish within twenty pages.");
  });

describe("content search API continuation (#812)", () => {
  it.effect("returns an empty raw API page until the caller supplies its continuation", () =>
    Effect.gen(function* () {
      const { raw } = yield* setup;
      const first = yield* raw(request);
      expect(first.matches).toEqual([]);
      expect(first.truncated).toBe(true);
      if (first.nextCursor === undefined) return yield* Effect.die("Expected a continuation.");
      expect(yield* follow(raw, raw, first.nextCursor)).toEqual(completed);
      const restarted = yield* raw(request);
      expect(restarted.matches).toEqual([]);
      expect(restarted.truncated).toBe(true);
      expect(restarted.nextCursor).toBeDefined();
    }).pipe(Effect.scoped),
  );

  it.effect("forwards raw API and MCP cursors through signalbox_call without consuming pages", () =>
    Effect.gen(function* () {
      const { raw, mcp } = yield* setup;
      const firstRaw = yield* raw(request);
      const firstMcp = yield* mcp(request);
      expect(firstRaw.matches).toEqual([]);
      expect(firstMcp.matches).toEqual([]);
      expect(firstMcp.truncated).toBe(true);
      if (firstRaw.nextCursor === undefined || firstMcp.nextCursor === undefined) {
        return yield* Effect.die("Expected API and MCP continuations.");
      }
      expect(yield* follow(mcp, raw, firstRaw.nextCursor)).toEqual(completed);
      expect(yield* follow(raw, mcp, firstMcp.nextCursor)).toEqual(completed);
    }).pipe(Effect.scoped),
  );
});
