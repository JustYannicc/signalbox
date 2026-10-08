// @effect-diagnostics globalFetchInEffect:off - speaks MCP and WebDAV to a real loopback server, as the harness and rclone do.
import type {
  ContextView,
  SearchResult,
  TreeResult,
} from "@signalbox/runner-protocol/ContextProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ContextClient } from "./RunnerContextClient.ts";
import { startContextServer } from "./RunnerContextServer.ts";

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

const fakeClient = (searches: Array<{ query: string; driveId: string | null }>): ContextClient => ({
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
    searches.push(request);
    return Effect.succeed({
      _tag: "found",
      terms: ["dark", "mode"],
      hits: [
        {
          kind: "commit",
          driveId: "shared/org_acme/billing",
          commit: C2,
          parent: OLD,
          message: "Add dark mode",
          time: 1,
          matched: ["dark", "mode"],
          files: ["theme/darkMode.ts"],
        },
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
      searched: { threads: 0, threadsInScope: 0, drives: 1, commits: 2, work: 0 },
    } satisfies SearchResult);
  },
  thread: () => Effect.succeed({ _tag: "not_found" }),
});

const serve = Effect.gen(function* () {
  const searches: Array<{ query: string; driveId: string | null }> = [];
  const server = yield* startContextServer({ mountPoint: null });
  yield* server.pin(fakeClient(searches));
  const origin = server.mcpUrl.replace(/\/mcp$/, "");
  const dav = (method: string, path: string, headers: Record<string, string> = {}) =>
    Effect.promise(async () => {
      const response = await fetch(`${origin}/dav${path}`, { method, headers });
      return { status: response.status, headers: response.headers, text: await response.text() };
    });
  let session: string | null = null;
  let id = 0;
  const mcp = (method: string, params: unknown) =>
    Effect.promise(async () => {
      const response = await fetch(server.mcpUrl, {
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
      (answer) => answer.result as { isError?: boolean; content: ReadonlyArray<{ text: string }> },
    );
  return { dav, mcp, call, searches };
});

const hrefs = (xml: string) =>
  [...xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((match) => decodeURIComponent(match[1]!));

describe("context server (#141)", () => {
  it.effect("serves /drives as read-only WebDAV, by context, through shortcuts", () =>
    Effect.gen(function* () {
      const { dav } = yield* serve;
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
      const { mcp, call, searches } = yield* serve;
      const tools = (yield* mcp("tools/list", {})).result.tools as ReadonlyArray<{
        name: string;
        annotations: { readOnlyHint: boolean };
      }>;
      expect(tools.map((tool) => tool.name)).toEqual([
        "search_context",
        "open_thread",
        "drive_diff",
        "list_drives",
        "read_drive_file",
      ]);
      expect(tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);

      const found = yield* call("search_context", {
        query: "dark mode",
        drive: "/drives/Acme/Shared drives/Billing",
      });
      expect(searches).toEqual([{ query: "dark mode", driveId: "shared/org_acme/billing" }]);
      // Drives come back as the paths the agent reads them at.
      expect(JSON.parse(found.content[0]!.text)).toMatchObject({
        result: "found",
        hits: [
          { kind: "commit", drive: "/drives/Acme/Shared drives/Billing", parent: OLD },
          // A drive only a shortcut reaches is named by the shortcut's path.
          { kind: "work", drive: "/drives/Personal/My Drive/shared/plans" },
        ],
      });

      // A drive's own name does too, when only one drive has it.
      yield* call("search_context", { query: "dark mode", drive: "billing" });
      expect(searches.at(-1)?.driveId).toBe("shared/org_acme/billing");
      expect((yield* call("search_context", { query: "x", drive: "Payroll" })).isError).toBe(true);

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
});
