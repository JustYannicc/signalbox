// @effect-diagnostics globalFetchInEffect:off - speaks MCP and WebDAV to a real loopback server, as the harness and rclone do.
import type { PublishRequest, PublishResult } from "@signalbox/runner-protocol/BranchProtocol";
import type { PreviewService } from "@signalbox/runner-protocol/PreviewServices";
import type {
  ContextView,
  ContextSearchResult,
  SearchRequest,
  ThreadRequest,
  TreeResult,
} from "@signalbox/runner-protocol/ContextProtocol";
import { contextJson } from "@signalbox/runner-protocol/ContextProtocol";
import type { ToolRequest, ToolResult } from "@signalbox/runner-protocol/AutomationProtocol";
import { PULL_REQUEST_REVIEW_TOOL } from "@signalbox/runner-protocol/PullRequestReviewTools";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { RUNNER_AUTOMATION_TOOLS, RUNNER_NOTE_TOOLS } from "./RunnerAutomationTools.ts";
import { RUNNER_LEARNER_TOOLS } from "./RunnerLearnerTools.ts";
import { RUNNER_SCHEDULED_TASK_TOOLS } from "./RunnerScheduledTaskTools.ts";
import { RUNNER_STATUS_LINE_TOOLS } from "./RunnerStatusLineTools.ts";
import type { BranchDrive } from "./RunnerBranchTools.ts";
import type { ContextClient } from "./RunnerContextClient.ts";
import { startContextServer } from "./RunnerContextServer.ts";
import { CONTEXT_SERVER_NAME } from "./RunnerContextTools.ts";
import type { RunnerPreviewServices } from "./RunnerPreviewServices.ts";

/** Cloud-backed tools have their own integration tests. */
const CLOUD_SIDE = new Set<string>([
  ...RUNNER_AUTOMATION_TOOLS,
  ...RUNNER_LEARNER_TOOLS,
  ...RUNNER_SCHEDULED_TASK_TOOLS,
  ...RUNNER_STATUS_LINE_TOOLS,
  PULL_REQUEST_REVIEW_TOOL,
  ...Object.keys(RUNNER_NOTE_TOOLS),
]);

/**
 * The context server as the harnesses and `rclone mount` reach it: MCP and
 * WebDAV over loopback HTTP, reading through a fake of the cloud's context API.
 */

const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const OLD = "3".repeat(40);
const blob = (n: number) => String(n).repeat(40);

const VIEW: ContextView = {
  driveId: "my/personal/user_1",
  contexts: [
    {
      contextId: "personal",
      name: "Personal",
      drives: [
        {
          driveId: "my/personal/user_1",
          path: "My Drive",
          commit: C1,
          time: 1_700_000_000,
          shortcuts: [{ path: "shared/plans", target: "folder/personal/plans" }],
        },
        {
          driveId: "folder/personal/plans",
          path: null,
          commit: C2,
          time: 1_700_000_100,
          shortcuts: [],
        },
      ],
    },
    {
      contextId: "org_acme",
      name: "Acme",
      drives: [
        {
          driveId: "shared/org_acme/billing",
          path: "Shared drives/Billing",
          commit: C2,
          time: 1_700_000_200,
          shortcuts: [],
        },
      ],
    },
  ],
};

const file = (name: string, oid: string, size: number) =>
  ({ name, kind: "file", oid, size }) as const;
const dir = (name: string) => ({ name, kind: "directory", oid: "d".repeat(40), size: 0 }) as const;

const TREES: Record<string, TreeResult> = {
  [`my/personal/user_1:${C1}:`]: {
    _tag: "directory",
    entries: [file("notes.md", blob(4), 6), dir("shared")],
  },
  [`my/personal/user_1:${C1}:shared`]: { _tag: "directory", entries: [] },
  [`folder/personal/plans:${C2}:`]: { _tag: "directory", entries: [file("q3.md", blob(5), 3)] },
  [`shared/org_acme/billing:${C2}:`]: {
    _tag: "directory",
    entries: [dir("theme"), file("README.md", blob(6), 8)],
  },
  [`shared/org_acme/billing:${C2}:theme`]: {
    _tag: "directory",
    entries: [file("darkMode.ts", blob(7), 12)],
  },
  [`shared/org_acme/billing:${OLD}:theme`]: {
    _tag: "directory",
    entries: [file("darkMode.ts", blob(8), 3)],
  },
};
const BLOBS: Record<string, string> = {
  [blob(5)]: "Q3\n",
  [blob(7)]: "dark = true\n",
  [blob(8)]: "v0\n",
};

/** What the fake drive and cloud were asked, in order, and what the cloud answers a publish. */
interface Calls {
  readonly searches: Array<SearchRequest>;
  readonly threads: Array<ThreadRequest>;
  searchResult: ContextSearchResult | null;
  readonly log: Array<string>;
  readonly published: Array<PublishRequest>;
  answer: PublishResult;
  readonly notes: Array<{ nextStep: string; whereItGotTo: string }>;
  readonly automationCalls: Array<{ request: ToolRequest; retry: boolean }>;
  automationAnswer: ToolResult;
}

const PUBLISHED: PublishResult = {
  _tag: "published",
  branch: "signalbox/0000abcd",
  repository: "owner/repo",
  pushed: true,
  pullRequest: {
    number: 7,
    url: "https://github.test/owner/repo/pull/7",
    title: "Add dark mode",
    baseBranch: "main",
    created: true,
  },
};

const fakeDrive = (calls: Calls): BranchDrive => ({
  published: (head) => Effect.sync(() => void calls.log.push(`published: ${head}`)),
  saveBranch: (message) =>
    Effect.sync(() => {
      calls.log.push(`save: ${message ?? "(summary)"}`);
      return message === "unsavable"
        ? { _tag: "not_saved", reason: "A merge is in progress here." }
        : { _tag: "saved", head: C1, lease: message === "Rebased" ? C1 : null };
    }),
});

const fakeClient = (calls: Calls): ContextClient => ({
  view: Effect.succeed(VIEW),
  tree: ({ driveId, commit, path }) =>
    Effect.succeed(TREES[`${driveId}:${commit}:${path}`] ?? { _tag: "missing" }),
  blob: ({ oid }) =>
    Effect.succeed(
      BLOBS[oid] === undefined
        ? { _tag: "missing" }
        : { _tag: "blob", bytes: new TextEncoder().encode(BLOBS[oid]) },
    ),
  diff: () => Effect.succeed({ _tag: "diff", patch: "+dark = true\n", truncated: false }),
  search: (request) => {
    calls.searches.push(request);
    const searchResult = calls.searchResult;
    if (searchResult !== null) return Effect.succeed(searchResult);
    const result = contextJson.search.decode(
      JSON.stringify({
        hits: [
          {
            threadId: ThreadId.make("thread-dark-mode"),
            projectId: ProjectId.make("drive:shared/org_acme/billing"),
            title: "Dark mode",
            archived: false,
            itemId: "item-dark-mode",
            entryId: "entry-dark-mode",
            runId: null,
            position: 0,
            kind: "summary",
            snippet: "Add dark mode",
            createdAt: null,
            sourceSequence: 4,
            indexedThrough: 4,
          },
        ],
        nextCursor: null,
        coverage: { complete: true, indexedThreads: 2, pendingThreads: 0, available: true },
        driveHits: [
          {
            kind: "work",
            driveId: "folder/personal/plans",
            threadId: "thread-2",
            title: null,
            commit: C2,
            base: null,
            matched: ["dark", "mode"],
            files: ["q3.md"],
          },
        ],
        driveSearched: { threads: 0, threadsInScope: 0, drives: 1, commits: 2, work: 1 },
        driveHitsTruncated: false,
      }),
    );
    return Effect.succeed(result);
  },
  thread: (request) =>
    Effect.sync(() => {
      calls.threads.push(request);
      return { _tag: "not_found" } as const;
    }),
  publish: (request) =>
    Effect.sync(() => {
      calls.log.push(`publish: ${request.action}`);
      calls.published.push(request);
      return calls.answer;
    }),
  automationTool: (request, { retry }) =>
    Effect.sync(() => {
      calls.automationCalls.push({ request, retry });
      return calls.automationAnswer;
    }),
  threadStatus: Effect.die("Reading the status line isn't part of these tests."),
  setThreadStatus: (input) =>
    Effect.sync(() => {
      calls.notes.push(input);
      return input.nextStep.includes("ACME-123")
        ? { _tag: "failed", message: "Write it for someone new." }
        : {
            _tag: "written",
            note: { ...input, writtenBy: "agent", writtenAt: "2026-10-16T09:00:00.000Z" },
          };
    }),
  folderStatus: Effect.die("Folder roll-ups aren't part of these tests."),
  learnerTool: () => Effect.die("Learner tools aren't part of these tests."),
  browserSession: Effect.die("The person's browser isn't part of these tests."),
  endBrowser: () => Effect.die("The person's browser isn't part of these tests."),
  browserSignIn: () => Effect.die("The person's browser isn't part of these tests."),
});

const serve = (
  previewServices?: RunnerPreviewServices["Service"],
  persistPreviewServices?: (services: ReadonlyArray<PreviewService>) => Effect.Effect<void>,
  previewServicesReady?: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const calls: Calls = {
      searches: [],
      threads: [],
      searchResult: null,
      log: [],
      published: [],
      answer: PUBLISHED,
      notes: [],
      automationCalls: [],
      automationAnswer: { _tag: "ok", result: null },
    };
    const server = yield* startContextServer({
      mountPoint: null,
      ...(previewServices === undefined ? {} : { previewServices }),
      ...(persistPreviewServices === undefined ? {} : { persistPreviewServices }),
      ...(previewServicesReady === undefined ? {} : { previewServicesReady }),
    });
    yield* server.pin(fakeClient(calls));
    yield* server.attachDrive(fakeDrive(calls));
    const origin = server.mcpServers[CONTEXT_SERVER_NAME]!.replace(/\/mcp$/, "");
    const dav = (method: string, path: string, headers: Record<string, string> = {}) =>
      Effect.promise(async () => {
        const response = await fetch(`${origin}/dav${path}`, { method, headers });
        return { status: response.status, headers: response.headers, text: await response.text() };
      });
    let session: string | null = null;
    let id = 0;
    const mcp = (method: string, params: unknown) =>
      Effect.promise(async () => {
        const response = await fetch(server.mcpServers[CONTEXT_SERVER_NAME]!, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
            ...(session === null ? {} : { "mcp-session-id": session }),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        session = response.headers.get("mcp-session-id") ?? session;
        return (await response.json()) as { result?: any; error?: unknown };
      });
    yield* mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const call = (name: string, args: Record<string, unknown>) =>
      Effect.map(
        mcp("tools/call", { name, arguments: args }),
        (answer) =>
          answer.result as { isError?: boolean; content: ReadonlyArray<{ text: string }> },
      );
    return { dav, mcp, call, searches: calls.searches, threads: calls.threads, calls };
  });

const hrefs = (xml: string) =>
  [...xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((match) => decodeURIComponent(match[1]!));

describe("context server (#141)", () => {
  it.effect("serves /drives as read-only WebDAV, by context, through shortcuts", () =>
    Effect.gen(function* () {
      const { dav } = yield* serve();
      expect(hrefs((yield* dav("PROPFIND", "/", { depth: "1" })).text)).toEqual([
        "/dav/",
        "/dav/Personal/",
        "/dav/Acme/",
      ]);
      expect(hrefs((yield* dav("PROPFIND", "/Acme/", { depth: "1" })).text)).toEqual([
        "/dav/Acme/",
        "/dav/Acme/Shared drives/",
      ]);
      const billing = yield* dav("PROPFIND", "/Acme/Shared%20drives/Billing", { depth: "1" });
      expect(billing.status).toBe(207);
      expect(hrefs(billing.text)).toEqual([
        "/dav/Acme/Shared drives/Billing/",
        "/dav/Acme/Shared drives/Billing/theme/",
        "/dav/Acme/Shared drives/Billing/README.md",
      ]);
      expect(billing.text).toContain("<D:getcontentlength>8</D:getcontentlength>");
      expect(billing.text).toContain("Tue, 14 Nov 2023 22:16:40 GMT");

      const read = yield* dav("GET", "/Acme/Shared%20drives/Billing/theme/darkMode.ts");
      expect(read).toMatchObject({ status: 200, text: "dark = true\n" });
      const part = yield* dav("GET", "/Acme/Shared%20drives/Billing/theme/darkMode.ts", {
        range: "bytes=7-10",
      });
      expect(part).toMatchObject({ status: 206, text: "true" });
      expect(part.headers.get("content-range")).toBe("bytes 7-10/12");
      // A range that isn't valid is ignored, as RFC 9110 says.
      const backwards = yield* dav("GET", "/Acme/Shared%20drives/Billing/theme/darkMode.ts", {
        range: "bytes=8-5",
      });
      expect(backwards).toMatchObject({ status: 200, text: "dark = true\n" });

      // A shortcut in My Drive reads from the drive it points at.
      const personal = yield* dav("PROPFIND", "/Personal/My%20Drive/shared", { depth: "1" });
      expect(hrefs(personal.text)).toEqual([
        "/dav/Personal/My Drive/shared/",
        "/dav/Personal/My Drive/shared/plans/",
      ]);
      expect((yield* dav("GET", "/Personal/My%20Drive/shared/plans/q3.md")).text).toBe("Q3\n");

      expect((yield* dav("PUT", "/Acme/Shared%20drives/Billing/new.txt")).status).toBe(403);
      expect((yield* dav("DELETE", "/Acme/Shared%20drives/Billing/README.md")).status).toBe(403);
      expect((yield* dav("PROPFIND", "/Nowhere", { depth: "0" })).status).toBe(404);
      expect((yield* dav("GET", "/../etc/passwd")).status).toBe(404);
    }),
  );

  it.effect("serves the context tool over MCP", () =>
    Effect.gen(function* () {
      const { mcp, call, searches, threads, calls } = yield* serve();
      const tools = (yield* mcp("tools/list", {})).result.tools as ReadonlyArray<{
        name: string;
        annotations: { readOnlyHint: boolean };
      }>;
      const reads = tools.filter(
        (tool) => tool.annotations.readOnlyHint && !CLOUD_SIDE.has(tool.name),
      );
      expect(reads.map((tool) => tool.name)).toEqual([
        "search_context",
        "open_thread",
        "drive_diff",
        "list_drives",
        "read_drive_file",
        "orchestrator_capabilities",
        "t3_thread_list",
        "t3_thread_read",
        "t3_thread_wait",
        "task_status",
        "t3_ask_list",
        "t3_ask_read",
        "read_pr",
      ]);

      const found = yield* call("search_context", {
        query: "dark mode",
        mode: "keyword",
        drive: "/drives/Acme/Shared drives/Billing",
      });
      expect(searches[0]).toMatchObject({
        query: "dark mode",
        mode: "keyword",
        driveId: "shared/org_acme/billing",
      });
      // Drives come back as the paths the agent reads them at.
      expect(JSON.parse(found.content[0]!.text)).toMatchObject({
        result: "found",
        nextCursor: null,
        coverage: { complete: true, available: true },
        hits: [{ threadId: "thread-dark-mode", itemId: "item-dark-mode", kind: "summary" }],
        // A drive only a shortcut reaches is named by the shortcut's path.
        driveHits: [{ kind: "work", drive: "/drives/Personal/My Drive/shared/plans" }],
      });

      calls.searchResult = {
        hits: [],
        nextCursor: "opaque-page-2",
        coverage: { complete: false, indexedThreads: 1, pendingThreads: 1, available: true },
        driveHits: [],
        driveSearched: { threads: 0, threadsInScope: 0, drives: 1, commits: 0, work: 0 },
        driveHitsTruncated: false,
      };
      const incomplete = yield* call("search_context", { query: "dark mode" });
      expect(JSON.parse(incomplete.content[0]!.text)).toMatchObject({
        result: "insufficient_evidence",
        coverage: { complete: false, available: true },
        nextCursor: "opaque-page-2",
      });
      calls.searchResult = null;

      // A drive's own name does too, when only one drive has it.
      yield* call("search_context", { query: "dark mode", drive: "billing" });
      expect(searches.at(-1)?.driveId).toBe("shared/org_acme/billing");
      const cursor = "thread-search-cursor/v2/opaque";
      yield* call("search_context", {
        query: "dark mode",
        mode: "literal",
        threadId: "thread-2",
        kinds: ["summary", "assistant"],
        limit: 3,
        drive: "billing",
        cursor,
      });
      expect(searches.at(-1)).toMatchObject({
        query: "dark mode",
        mode: "literal",
        threadId: "thread-2",
        kinds: ["summary", "assistant"],
        limit: 3,
        cursor,
        driveId: "shared/org_acme/billing",
      });
      expect((yield* call("search_context", { query: "x", drive: "Payroll" })).isError).toBe(true);

      yield* call("open_thread", {
        threadId: "thread-dark-mode",
        itemId: "item-dark-mode",
        projectId: "drive:shared/org_acme/billing",
      });
      expect(searches.at(-1)?.cursor).toBe(cursor);
      expect(threads.at(-1)).toMatchObject({
        threadId: "thread-dark-mode",
        itemId: "item-dark-mode",
        projectId: "drive:shared/org_acme/billing",
      });

      expect((yield* call("list_drives", {})).content[0]!.text).toBe("Personal/\nAcme/");
      expect(
        (yield* call("read_drive_file", {
          path: "/drives/Acme/Shared drives/Billing/theme/darkMode.ts",
        })).content[0]!.text,
      ).toBe("dark = true\n");
      expect(
        (yield* call("read_drive_file", {
          path: "/drives/Acme/Shared drives/Billing/theme/darkMode.ts",
          at: OLD,
        })).content[0]!.text,
      ).toBe("v0\n");
      expect(
        (yield* call("read_drive_file", {
          path: "/drives/Acme/Shared drives/Billing/theme/darkMode.ts",
          offset: 5,
        })).content[0]!.text,
      ).toBe("= true\n");
      // At another commit a drive reads as it was, without today's shortcuts.
      const before = yield* call("read_drive_file", {
        path: "/drives/Personal/My Drive/shared/plans/q3.md",
        at: C1,
      });
      expect(before.isError).toBe(true);
      const missing = yield* call("read_drive_file", { path: "/etc/passwd" });
      expect(missing.isError).toBe(true);
      const diff = yield* call("drive_diff", {
        drive: "/drives/Acme/Shared drives/Billing",
        from: OLD,
        to: C2,
      });
      expect(diff.content[0]!.text).toBe("+dark = true\n");
    }),
  );

  it.effect(
    "starts and stops only declared preview services and waits for each declaration to save",
    () =>
      Effect.gen(function* () {
        const declarations: Array<PreviewService> = [];
        const persisted: Array<ReadonlyArray<PreviewService>> = [];
        const services: RunnerPreviewServices["Service"] = {
          start: (service) =>
            Effect.sync(() => {
              const index = declarations.findIndex((entry) => entry.port === service.port);
              if (index >= 0) declarations.splice(index, 1);
              declarations.push(service);
            }),
          stop: (port) =>
            Effect.sync(
              () =>
                void declarations.splice(
                  0,
                  declarations.length,
                  ...declarations.filter((service) => service.port !== port),
                ),
            ),
          restore: (next) =>
            Effect.sync(() => void declarations.splice(0, declarations.length, ...next)),
          list: Effect.sync(() => [...declarations]),
        };
        const { mcp, call } = yield* serve(services, (next) =>
          Effect.sync(() => persisted.push([...next])),
        );
        const tools = (yield* mcp("tools/list", {})).result.tools as ReadonlyArray<{
          name: string;
          annotations: { readOnlyHint: boolean };
        }>;
        expect(
          tools.filter((tool) => tool.name.startsWith("preview_service_")).map((tool) => tool.name),
        ).toEqual(["preview_service_start", "preview_service_stop"]);

        const started = { port: 4173, command: "pnpm dev", cwd: "apps/web" };
        const startResult = yield* call("preview_service_start", started);
        expect(startResult.isError).toBeUndefined();
        expect(startResult.content[0]?.text).toBe("Preview service declared on port 4173.");
        expect(persisted).toEqual([[started]]);
        const stopResult = yield* call("preview_service_stop", { port: 4173 });
        expect(stopResult.isError).toBeUndefined();
        expect(stopResult.content[0]?.text).toBe("Preview service stopped on port 4173.");
        expect(persisted).toEqual([[started], []]);
      }),
  );

  it.effect("waits for saved services to restore before starting another service", () =>
    Effect.gen(function* () {
      const saved = { port: 3000, command: "pnpm dev", cwd: "apps/web" };
      const added = { port: 4173, command: "pnpm preview", cwd: "apps/web" };
      const declarations: Array<PreviewService> = [];
      const persisted: Array<ReadonlyArray<PreviewService>> = [];
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const services: RunnerPreviewServices["Service"] = {
        start: (service) =>
          Effect.sync(() => {
            const index = declarations.findIndex((entry) => entry.port === service.port);
            if (index >= 0) declarations.splice(index, 1);
            declarations.push(service);
          }),
        stop: (port) =>
          Effect.sync(
            () =>
              void declarations.splice(
                0,
                declarations.length,
                ...declarations.filter((service) => service.port !== port),
              ),
          ),
        restore: (next) =>
          Effect.sync(() => void declarations.splice(0, declarations.length, ...next)),
        list: Effect.sync(() => [...declarations]),
      };
      const ready = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const { call } = yield* serve(
        services,
        (next) => Effect.sync(() => persisted.push([...next])),
        ready,
      );

      const starting = yield* Effect.forkChild(call("preview_service_start", added));
      yield* Deferred.await(entered);
      yield* services.restore([saved]);
      expect(declarations).toEqual([saved]);
      expect(persisted).toEqual([]);

      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(starting);
      expect(result.isError).toBeUndefined();
      expect(declarations).toEqual([saved, added]);
      expect(persisted).toEqual([[saved, added]]);
    }),
  );

  it.effect("publishes the thread's branch: saves it first, then asks the cloud", () =>
    Effect.gen(function* () {
      const { mcp, call, calls } = yield* serve();
      const tools = (yield* mcp("tools/list", {})).result.tools as ReadonlyArray<{
        name: string;
        annotations: { readOnlyHint: boolean };
      }>;
      expect(
        tools
          .filter((tool) => !tool.annotations.readOnlyHint && !CLOUD_SIDE.has(tool.name))
          .map((tool) => tool.name),
      ).toEqual([
        "t3_thread_send",
        "delegate_task",
        "task_cancel",
        "t3_thread_interrupt",
        "push",
        "create_pr",
        "t3_ask_raise",
        "t3_ask_answer",
        "t3_ask_withdraw",
        "edit_pr",
        "comment_pr",
        "reply_to_pr_review",
        "upload_pr_image",
      ]);

      const opened = yield* call("create_pr", {
        title: "Add dark mode",
        body: "Adds a dark theme.",
        draft: true,
      });
      expect(opened.isError).toBeUndefined();
      // GitHub's copy of the branch is the pushed head now: the next push's lease.
      // No commit message: the drive describes the change, never the pull request's title.
      expect(calls.log).toEqual(["save: (summary)", "publish: create_pr", `published: ${C1}`]);
      expect(calls.published).toEqual([
        { action: "create_pr", title: "Add dark mode", body: "Adds a dark theme.", draft: true },
      ]);
      expect(JSON.parse(opened.content[0]!.text)).toEqual({
        branch: "signalbox/0000abcd",
        repository: "owner/repo",
        commit: C1,
        pushed: true,
        pullRequest: PUBLISHED._tag === "published" ? PUBLISHED.pullRequest : null,
      });

      yield* call("push", { commitMessage: "Fix typo" });
      expect(calls.log.slice(3)).toEqual(["save: Fix typo", "publish: push", `published: ${C1}`]);
      expect(calls.published.at(-1)).toEqual({ action: "push" });

      // A refusal reads as what to do next.
      calls.answer = {
        _tag: "failed",
        reason: "not_connected",
        message: "Connect GitHub first: Settings › Source Control.",
      };
      const refused = yield* call("create_pr", {});
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toBe(
        "GitHub isn't connected. Ask the user to connect it in Settings › Source Control, then try again.",
      );
      calls.answer = {
        _tag: "failed",
        reason: "branch_conflict",
        message: "The branch on the remote has commits this thread does not. Nothing was pushed.",
      };
      expect((yield* call("push", {})).content[0]!.text).toContain("git pull --rebase");
      calls.answer = PUBLISHED;
      // A branch that took the remote's head in may replace it, like --force-with-lease.
      yield* call("push", { commitMessage: "Rebased" });
      expect(calls.published.at(-1)).toEqual({ action: "push", lease: C1 });

      // Work that can't be saved is never pushed.
      const before = calls.published.length;
      const unsaved = yield* call("push", { commitMessage: "unsavable" });
      expect(unsaved).toMatchObject({
        isError: true,
        content: [{ text: "A merge is in progress here." }],
      });
      expect(calls.published).toHaveLength(before);
    }),
  );

  it.effect("writes the thread's status note through the cloud, in the cloud's words", () =>
    Effect.gen(function* () {
      const { mcp, call, calls } = yield* serve();
      const tools = (yield* mcp("tools/list", {})).result.tools as ReadonlyArray<{
        name: string;
        annotations: { readOnlyHint: boolean };
      }>;
      expect(
        tools
          .filter((tool) => RUNNER_STATUS_LINE_TOOLS.some((name) => name === tool.name))
          .map((tool) => [tool.name, tool.annotations.readOnlyHint]),
      ).toEqual([
        ["thread_status", true],
        ["set_thread_status", false],
        ["folder_status", true],
      ]);
      const note = {
        nextStep: "You: say whether the draft can go out.",
        whereItGotTo: "The draft is written and checked against last year's.",
      };
      const written = yield* call("set_thread_status", note);
      expect(written.isError).toBeUndefined();
      expect(JSON.parse(written.content[0]!.text)).toMatchObject({ written: true, note });
      expect(calls.notes).toEqual([note]);

      const refused = yield* call("set_thread_status", { ...note, nextStep: "Close ACME-123" });
      expect(refused).toMatchObject({
        isError: true,
        content: [{ text: "Write it for someone new." }],
      });
    }),
  );

  it.effect(
    "reads review thread IDs and routes replies and resolutions without retrying writes",
    () =>
      Effect.gen(function* () {
        const { mcp, call, calls } = yield* serve();
        const tools = (yield* mcp("tools/list", {})).result.tools as ReadonlyArray<{
          name: string;
          description: string;
          inputSchema: unknown;
          annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
        }>;
        const review = tools.find((tool) => tool.name === PULL_REQUEST_REVIEW_TOOL);
        expect(review).toMatchObject({
          description: expect.stringContaining("thread IDs"),
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        });
        expect(JSON.stringify(review?.inputSchema)).not.toMatch(
          /projectId|repository|host|driveId|folderId/,
        );

        calls.automationAnswer = {
          _tag: "ok",
          result: {
            reviewThreads: [{ id: "PRRT_kw_1", isResolved: false, comments: [] }],
          },
        };
        const read = yield* call(PULL_REQUEST_REVIEW_TOOL, { action: "read", number: 12 });
        expect(JSON.parse(read.content[0]!.text)).toMatchObject({
          reviewThreads: [{ id: "PRRT_kw_1" }],
        });
        expect(calls.automationCalls[0]).toEqual({
          request: {
            name: PULL_REQUEST_REVIEW_TOOL,
            input: { action: "read", number: 12 },
          },
          retry: true,
        });

        calls.automationAnswer = { _tag: "ok", result: { written: true } };
        const reply = yield* call(PULL_REQUEST_REVIEW_TOOL, {
          action: "reply",
          number: 12,
          threadId: "PRRT_kw_1",
          body: "Fixed in the latest commit.",
          operationId: "reply-12-1",
        });
        expect(JSON.parse(reply.content[0]!.text)).toEqual({ written: true });
        expect(calls.automationCalls[1]).toEqual({
          request: {
            name: PULL_REQUEST_REVIEW_TOOL,
            input: {
              action: "reply",
              number: 12,
              threadId: "PRRT_kw_1",
              body: "Fixed in the latest commit.",
              operationId: "reply-12-1",
            },
          },
          retry: false,
        });

        calls.automationAnswer = {
          _tag: "ok",
          result: { written: true, resolved: true },
        };
        yield* call(PULL_REQUEST_REVIEW_TOOL, {
          action: "resolve",
          number: 12,
          threadId: "PRRT_kw_1",
          resolved: true,
        });
        expect(calls.automationCalls[2]?.retry).toBe(false);

        const cloudError = {
          _tag: "PullRequestOperationError",
          reason: "rate-limit",
          status: 429,
          retryAt: 123_456,
        };
        calls.automationAnswer = {
          _tag: "failed",
          message: "The GitHub connection expired.",
          error: cloudError,
        };
        const failed = yield* call(PULL_REQUEST_REVIEW_TOOL, {
          action: "reply",
          number: 12,
          threadId: "PRRT_kw_1",
          body: "Retry safely with the same operation id.",
          operationId: "reply-12-2",
        });
        expect(failed.isError).toBe(true);
        expect(JSON.parse(failed.content[0]!.text)).toEqual(cloudError);
        expect(calls.automationCalls[3]?.retry).toBe(false);

        const beforeInvalidReply = calls.automationCalls.length;
        const invalidReply = yield* call(PULL_REQUEST_REVIEW_TOOL, {
          action: "reply",
          number: 12,
          threadId: "PRRT_kw_1",
          body: "Missing the required idempotency key.",
        });
        expect(invalidReply.isError).toBe(true);
        expect(calls.automationCalls).toHaveLength(beforeInvalidReply);
      }),
  );
});
