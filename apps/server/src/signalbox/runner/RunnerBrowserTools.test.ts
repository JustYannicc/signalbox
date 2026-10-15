// @effect-diagnostics globalFetchInEffect:off nodeBuiltinImport:off - speaks MCP to a real loopback server, as the harnesses do, and serves the page the browser opens.
import * as NodeHttp from "node:http";

import { describe, expect, it } from "@effect/vitest";
import type { PreviewAutomationSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool } from "effect/ai";

import { PreviewToolkit } from "../../mcp/toolkits/preview/tools.ts";
import { type BrowserBackend, makeHeadlessBrowser } from "./RunnerBrowser.ts";
import { BROWSER_SERVER_NAME } from "./RunnerBrowserTools.ts";
import { startContextServer } from "./RunnerContextServer.ts";

/**
 * The thread machine's browser (#402) as the harnesses reach it: the
 * `t3-code` MCP server on the Runner's loopback context server.
 */

const PNG = Buffer.from("not really a png").toString("base64");

const SNAPSHOT: PreviewAutomationSnapshot = {
  url: "http://localhost:5173/",
  title: "Vite App",
  loading: false,
  visibleText: "count is 0",
  interactiveElements: [],
  accessibilityTree: '- button "count is 0" [ref=t3-1-e1]',
  consoleEntries: Array.from({ length: 80 }, (_, index) => ({
    level: "log",
    text: `line ${index}`,
    timestamp: "2026-10-15T00:00:00.000Z",
  })),
  networkEntries: [],
  actionTimeline: [],
  screenshot: { mimeType: "image/png", data: PNG, width: 1280, height: 800 },
};

const unused = () => Promise.reject(new Error("not used"));
const fakeBrowser: BrowserBackend = {
  status: unused,
  open: unused,
  navigate: unused,
  dialog: unused,
  resize: unused,
  setColorScheme: unused,
  snapshot: () => Promise.resolve(SNAPSHOT),
  click: unused,
  type: unused,
  hover: unused,
  select: unused,
  drag: unused,
  upload: unused,
  press: unused,
  scroll: unused,
  evaluate: unused,
  waitFor: unused,
  close: () => Promise.resolve(),
};

interface Content {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
}

const connect = (browser: BrowserBackend) =>
  Effect.gen(function* () {
    const server = yield* startContextServer({ mountPoint: null, browser });
    const url = server.mcpServers[BROWSER_SERVER_NAME]!;
    let session: string | null = null;
    let id = 0;
    const mcp = (method: string, params: unknown) =>
      Effect.promise(async () => {
        const response = await fetch(url, {
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
        (answer) => answer.result as { isError?: boolean; content: ReadonlyArray<Content> },
      );
    return { mcp, call };
  });

describe("thread machine browser (#402)", () => {
  it.effect("serves the preview tools agents use locally, with the same arguments", () =>
    Effect.gen(function* () {
      const { mcp } = yield* connect(fakeBrowser);
      const listed = (yield* mcp("tools/list", {})).result.tools as ReadonlyArray<{
        name: string;
        inputSchema: { properties?: Record<string, unknown> };
      }>;
      // Recordings need a viewer to hand the file to; the machine has none.
      const local = Object.values(PreviewToolkit.tools).filter(
        (tool) => !tool.name.startsWith("preview_recording_"),
      );
      expect(listed.map((tool) => tool.name).toSorted()).toEqual(
        local.map((tool) => tool.name).toSorted(),
      );
      for (const tool of local) {
        const served = listed.find((each) => each.name === tool.name)!;
        const properties = (Tool.getJsonSchema(tool) as { properties?: object }).properties;
        expect(Object.keys(served.inputSchema.properties ?? {}).toSorted(), tool.name).toEqual(
          Object.keys(properties ?? {}).toSorted(),
        );
      }
    }),
  );

  it.effect("keeps a screenshot in the thread only when asked", () =>
    Effect.gen(function* () {
      const { call } = yield* connect(fakeBrowser);

      const read = yield* call("preview_snapshot", {});
      expect(read.content.map((block) => block.type)).toEqual(["text"]);
      const page = JSON.parse(read.content[0]!.text!);
      expect(page.screenshot).toEqual({ mimeType: "image/png", width: 1280, height: 800 });
      // The newest console lines, bounded.
      expect(page.consoleEntries).toHaveLength(40);
      expect(page.consoleEntries.at(-1).text).toBe("line 79");

      const saved = yield* call("preview_snapshot", { save: true });
      expect(saved.content).toEqual([
        { type: "text", text: expect.stringContaining('"savedToThread": true') },
        { type: "image", data: PNG, mimeType: "image/png" },
      ]);
    }),
  );

  const executable = process.env.SIGNALBOX_BROWSER_EXECUTABLE;
  // Needs the pinned headless shell: the Runner image sets this, elsewhere set it by hand.
  it.effect.skipIf(executable === undefined)(
    "opens a dev server on the machine, reads its console and screenshots it",
    () =>
      Effect.gen(function* () {
        const devServer = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((resolve) => {
                const server = NodeHttp.createServer((_request, response) => {
                  response.setHeader("content-type", "text/html");
                  response.end(
                    '<title>Dev</title><button>count is 0</button><script>console.error("boom from the page")</script>',
                  );
                });
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) => Effect.sync(() => server.close()),
        );
        const port = (devServer.address() as { port: number }).port;
        const browser = makeHeadlessBrowser({
          executable,
          env: { ...process.env, T3CODE_SERVER_BROWSER_SANDBOX: "0" },
        });
        const { call } = yield* connect(browser);

        const opened = yield* call("preview_navigate", {
          target: { kind: "environment-port", port },
        });
        expect(opened.isError, opened.content[0]?.text).toBeFalsy();
        expect(JSON.parse(opened.content[0]!.text!)).toMatchObject({
          url: `http://localhost:${port}/`,
          title: "Dev",
        });

        const snapshot = yield* call("preview_snapshot", { includeImage: true });
        const page = JSON.parse(snapshot.content[0]!.text!);
        expect(page.consoleEntries).toEqual([
          expect.objectContaining({ level: "error", text: "boom from the page" }),
        ]);
        expect(page.accessibilityTree).toContain('button "count is 0"');
        const image = snapshot.content[1]!;
        expect(image.mimeType).toBe("image/png");
        // A real PNG, at the 1280px a snapshot renders.
        const png = Buffer.from(image.data!, "base64");
        expect(png.subarray(1, 4).toString()).toBe("PNG");
        expect(png.readUInt32BE(16)).toBe(1280);

        const clicked = yield* call("preview_click", { locator: "role=button[name='count is 0']" });
        expect(clicked.isError, clicked.content[0]?.text).toBeFalsy();
      }).pipe(Effect.scoped),
    60_000,
  );
});
