// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ViewInstance } from "react-native";
import type { RefObject } from "react";
import type { MarkdownSourceSelection } from "react-native-enriched-markdown";
import type { SelectableMarkdownTextProps } from "../../../native/SelectableMarkdownText.types";
import type { useThreadFindReveal } from "./thread-find-reveal-context";
import { useThreadFindNativeReveal } from "./use-thread-find-native-reveal";

type Reveal = ReturnType<typeof useThreadFindReveal>;
const request: NonNullable<Reveal["request"]> = {
  key: "find:7",
  requestId: "find",
  revision: "7",
  snapshotSequence: 7,
  query: "needle",
  occurrence: 0,
  threadKey: "thread",
  target: { entryId: "entry", runId: null },
};
const selection: MarkdownSourceSelection = {
  version: 1,
  revision: "source:1",
  requestId: "find",
  sourceMarkdown: "needle",
  ranges: [{ start: 0, end: 6 }],
};
const result = {
  version: 1 as const,
  revision: "source:1",
  requestId: "find",
  status: "applied" as const,
  rects: [{ x: 0, y: 0, width: 30, height: 12 }],
};
const rootRef: RefObject<ViewInstance | null> = { current: null };
let domRoot: Root;
let host: HTMLDivElement;
let callback: NonNullable<SelectableMarkdownTextProps["onSourceSelection"]>;
const report = vi.fn<Reveal["reportGlyphRects"]>(async () => true);
function Target({
  activeRequest = request,
  selected = selection,
}: {
  activeRequest?: Reveal["request"];
  selected?: MarkdownSourceSelection | null;
}) {
  const current = useThreadFindNativeReveal(
    { request: activeRequest, reportGlyphRects: report },
    selected?.revision ?? "cleared",
    selected,
  );
  useLayoutEffect(() => {
    callback = current;
  }, [current]);
  return null;
}
async function render(
  activeRequest: Reveal["request"] = request,
  selected: MarkdownSourceSelection | null = selection,
) {
  await act(async () => {
    domRoot.render(<Target activeRequest={activeRequest} selected={selected} />);
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  report.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  domRoot = createRoot(host);
});
afterEach(async () => {
  await act(async () => {
    domRoot.unmount();
  });
  host.remove();
  vi.unstubAllGlobals();
});

it("rejects old native responses and forwards only the current source revision", async () => {
  await render();
  callback({ ...result, revision: "source:0" }, rootRef);
  callback({ ...result, requestId: "previous" }, rootRef);
  callback({ ...result, status: "rejected" }, rootRef);
  expect(report).not.toHaveBeenCalled();
  callback(result, rootRef);
  expect(report).toHaveBeenCalledOnce();
  expect(report.mock.calls[0]![0]).toMatchObject({
    requestId: "find",
    revision: "7",
    sourceRevision: "source:1",
  });
});

it("invalidates in-flight geometry when the same request gets a new source", async () => {
  await render();
  callback(result, rootRef);
  const pending = report.mock.calls[0]![0];
  expect(pending.isCurrent?.()).toBe(true);
  await render(request, { ...selection, revision: "source:2", sourceMarkdown: "noodle" });
  expect(pending.isCurrent?.()).toBe(false);
  callback(result, rootRef);
  expect(report).toHaveBeenCalledOnce();
});

it("invalidates reports on next occurrence, close, and component recycling", async () => {
  await render();
  callback(result, rootRef);
  const first = report.mock.calls[0]![0];
  await render(
    { ...request, requestId: "next", occurrence: 1 },
    { ...selection, requestId: "next" },
  );
  expect(first.isCurrent?.()).toBe(false);
  callback({ ...result, requestId: "next" }, rootRef);
  const next = report.mock.calls[1]![0];
  expect(next.isCurrent?.()).toBe(true);
  await render(null, null);
  expect(next.isCurrent?.()).toBe(false);
  callback({ ...result, requestId: "next" }, rootRef);
  expect(report).toHaveBeenCalledTimes(2);
  await render();
  callback(result, rootRef);
  const last = report.mock.calls[2]![0];
  await act(async () => {
    domRoot.render(null);
  });
  expect(last.isCurrent?.()).toBe(false);
  callback(result, rootRef);
  expect(report).toHaveBeenCalledTimes(3);
});

it("replaces in-flight geometry when the same Find request receives a newer result revision", async () => {
  await render();
  callback(result, rootRef);
  const old = report.mock.calls[0]![0];
  await render(
    { ...request, revision: "8", snapshotSequence: 8 },
    { ...selection, revision: "source:2" },
  );
  expect(old.isCurrent?.()).toBe(false);
  callback(result, rootRef);
  expect(report).toHaveBeenCalledOnce();
  callback({ ...result, revision: "source:2" }, rootRef);
  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.calls[1]![0]).toMatchObject({
    requestId: "find",
    revision: "8",
    sourceRevision: "source:2",
  });
  expect(report.mock.calls[1]![0].isCurrent?.()).toBe(true);
});
