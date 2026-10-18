// @vitest-environment jsdom

import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { V2ItemInspector } from "./V2ItemInspector";
import { collectThreadFindRanges } from "./threadFindHighlights";

vi.mock("../../state/queries", () => ({
  useTurnItemDetail: () => ({ data: undefined, isPending: false, error: null }),
}));
vi.mock("../../state/v2ItemSupport", () => ({ useV2ItemSupport: () => ({}) }));
vi.mock("./CommandOutputPanel", () => ({
  CommandOutputPanel: () => null,
  useCommandOutputStreaming: () => false,
}));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../../lib/syntaxHighlighting", () => {
  const highlighter = Promise.resolve({
    codeToTokens: (text: string) => {
      let offset = 0;
      return {
        tokens: text.split(/\r?\n/u).map((line) => {
          const tokens = Array.from(line, (content) => {
            const token = { content, offset, color: "#000000" };
            offset += content.length;
            return token;
          });
          offset += 1;
          return tokens;
        }),
      };
    },
  });
  return { getSyntaxHighlighterPromise: () => highlighter };
});

let host: HTMLElement;
let root: Root;
const threadId = ThreadId.make("input-find-thread");
const itemId = TurnItemId.make("input-find-item");

async function render(input: unknown, toolName = "search") {
  const now = DateTime.makeUnsafe("2026-10-17T10:00:00.000Z");
  const projectedItem: OrchestrationV2ProjectedTurnItem = {
    position: 1,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: itemId,
    item: {
      id: itemId,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "dynamic_tool",
      toolName,
      input,
      output: "café",
    },
  };
  await act(async () => {
    root.render(
      <div data-thread-find-entry-id={itemId}>
        <V2ItemInspector
          projectedItem={projectedItem}
          environmentId={EnvironmentId.make("input-find-env")}
          onOpenThread={vi.fn()}
          onOpenTurnDiff={vi.fn()}
        />
      </div>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("dynamic tool input Find in the actual inspector", () => {
  it("selects input occurrence zero before output occurrence one", async () => {
    await render({ q: "café" });
    const ranges = collectThreadFindRanges(host, "café");
    expect(ranges.map(({ occurrence, range }) => [occurrence, range.toString()])).toEqual([
      [0, "café"],
      [1, "café"],
    ]);
    expect(
      host
        .querySelector('[data-thread-find-text="tool-input"]')
        ?.contains(ranges[0]!.range.startContainer),
    ).toBe(true);
    expect(
      host
        .querySelector('[data-thread-find-text="tool-output"]')
        ?.contains(ranges[1]!.range.startContainer),
    ).toBe(true);
  });

  it("ignores matching keys, secrets and depth-omitted values in the displayed JSON", async () => {
    await render({
      café: "café",
      password: "café",
      nested: { café: "café", token: "café", list: ["café", { q: "café" }] },
    });
    const ranges = collectThreadFindRanges(host, "café");
    expect(ranges.map(({ occurrence, range }) => [occurrence, range.toString()])).toEqual([
      [0, "café"],
      [1, "café"],
      [2, "café"],
      [3, "café"],
    ]);
    const input = host.querySelector('[data-thread-find-text="tool-input"]')!;
    expect(input.textContent?.match(/café/gu)?.length).toBe(8);
    expect(input.getAttribute("data-thread-find-source")).toBe("café\ncafé\ncafé");
  });

  it("maps escapes and non-BMP characters across syntax token nodes", async () => {
    await render({ nested: { q: 'café\n"😀\\ café' } });
    expect(collectThreadFindRanges(host, "\n").map(({ range }) => range.toString())).toEqual([
      "\\n",
    ]);
    expect(collectThreadFindRanges(host, '"😀\\').map(({ range }) => range.toString())).toEqual([
      '\\"😀\\\\',
    ]);
    expect(collectThreadFindRanges(host, "café").map(({ occurrence }) => occurrence)).toEqual([
      0, 1, 2,
    ]);
  });

  it("preserves CRLF input positions across highlighted code lines", async () => {
    await render({ code: "// x\r\ncafé" }, "js");
    const input = host.querySelector('[data-thread-find-text="tool-input"]')!;
    expect(input.textContent).toBe("code // x\r\ncafé");
    const ranges = collectThreadFindRanges(host, "café");
    expect(ranges.map(({ occurrence, range }) => [occurrence, range.toString()])).toEqual([
      [0, "café"],
      [1, "café"],
    ]);
    expect(input.contains(ranges[0]!.range.startContainer)).toBe(true);
  });

  it("renders all indexed input array fields and keeps repeated value ordinals", async () => {
    const input = [
      { type: "text", text: "café" },
      { type: "text", text: "café" },
    ];
    await render(input);
    expect(host.querySelector('[data-thread-find-text="tool-input"]')?.textContent).toBe(
      JSON.stringify(input, null, 2),
    );
    expect(collectThreadFindRanges(host, "text").map(({ range }) => range.toString())).toEqual([
      "text",
      "text",
    ]);
    expect(collectThreadFindRanges(host, "café").map(({ occurrence }) => occurrence)).toEqual([
      0, 1, 2,
    ]);
  });

  it("uses one 1000-unit input budget before counting output", async () => {
    await render({ prefix: "x".repeat(990), q: "café café café" });
    const ranges = collectThreadFindRanges(host, "café");
    expect(ranges.map(({ occurrence }) => occurrence)).toEqual([0, 1, 2]);
    expect(
      host
        .querySelector('[data-thread-find-text="tool-output"]')
        ?.contains(ranges[2]!.range.startContainer),
    ).toBe(true);
    await render({ prefix: "x".repeat(998), q: "😀 café" });
    expect(collectThreadFindRanges(host, "😀")).toHaveLength(0);
    expect(collectThreadFindRanges(host, "café").map(({ occurrence }) => occurrence)).toEqual([0]);
  });
});
