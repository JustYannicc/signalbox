// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadFindMeasureNode, ThreadFindViewport } from "./thread-find-geometry";
import type { ThreadFindRevealRequest } from "./thread-find-model";
import { ThreadFindRevealProvider, useThreadFindReveal } from "./thread-find-reveal-context";

const first: ThreadFindRevealRequest = {
  key: "first:7",
  requestId: "first",
  query: "needle",
  occurrence: 0,
  threadKey: "thread",
  target: { entryId: "entry", runId: null },
  snapshotSequence: 7,
  revision: "7",
};
const rootRef = {
  current: {
    measureInWindow: (callback) => callback(0, 100, 300, 100),
  } satisfies ThreadFindMeasureNode,
};
const report = {
  requestId: first.requestId,
  revision: first.revision,
  rootRef,
  rects: [{ x: 0, y: 0, width: 30, height: 12 }],
};

function pendingMeasurement() {
  let finish!: (value: Awaited<ReturnType<ThreadFindViewport["measure"]>>) => void;
  const promise = new Promise<Awaited<ReturnType<ThreadFindViewport["measure"]>>>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

describe("Find glyph reporting lifecycle", () => {
  let domRoot: Root;
  let host: HTMLDivElement;
  let reveal: ReturnType<typeof useThreadFindReveal>;
  const onRevealed = vi.fn();
  function Target({ entryId }: { entryId: string }) {
    const current = useThreadFindReveal(entryId);
    useLayoutEffect(() => {
      reveal = current;
    }, [current]);
    return null;
  }
  const viewport: ThreadFindViewport = {
    measure: async () => ({
      rect: { x: 0, y: 0, width: 320, height: 600 },
      scroll: 0,
      insets: { top: 60, bottom: 80 },
    }),
    scrollTo: vi.fn(async () => {}),
  };
  async function render(
    request: ThreadFindRevealRequest | null,
    entryId = "entry",
    sourceIdentity: unknown = "source",
    cap = viewport,
  ) {
    await act(async () => {
      domRoot.render(
        <ThreadFindRevealProvider
          request={request}
          viewport={cap}
          sourceIdentity={sourceIdentity}
          onRevealed={onRevealed}
        >
          <Target entryId={entryId} />
        </ThreadFindRevealProvider>,
      );
    });
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onRevealed.mockClear();
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

  it("only exposes the requested entry and acknowledges verified glyph geometry", async () => {
    await render(first, "another-entry");
    expect(reveal.request).toBeNull();
    expect(await reveal.reportGlyphRects(report)).toBe(false);
    await render(first);
    expect(reveal.request).toBe(first);
    expect(await reveal.reportGlyphRects(report)).toBe(true);
    expect(onRevealed).toHaveBeenCalledExactlyOnceWith(first.requestId);
  });

  it.each(["close", "next", "source", "recycle"])(
    "fences measurements across %s",
    async (change) => {
      const pending = pendingMeasurement();
      const cap = { ...viewport, measure: () => pending.promise };
      await render(first, "entry", "source", cap);
      const result = reveal.reportGlyphRects(report);
      await render(
        change === "close" ? null : change === "next" ? { ...first, requestId: "next" } : first,
        change === "recycle" ? "other-entry" : "entry",
        change === "source" ? "changed-source" : "source",
        cap,
      );
      pending.finish({
        rect: { x: 0, y: 0, width: 320, height: 600 },
        scroll: 0,
        insets: { top: 60, bottom: 80 },
      });
      expect(await result).toBe(false);
      expect(onRevealed).not.toHaveBeenCalled();
    },
  );

  it("aborts a source revision predicate that becomes false during native measurement", async () => {
    const pending = pendingMeasurement();
    const cap = { ...viewport, measure: () => pending.promise };
    let current = true;
    await render(first, "entry", "source", cap);
    const result = reveal.reportGlyphRects({ ...report, isCurrent: () => current });
    current = false;
    pending.finish({
      rect: { x: 0, y: 0, width: 320, height: 600 },
      scroll: 0,
      insets: { top: 60, bottom: 80 },
    });
    expect(await result).toBe(false);
    expect(onRevealed).not.toHaveBeenCalled();
  });

  it("supersedes an earlier native layout report for the same request", async () => {
    const pending = pendingMeasurement();
    const cap = {
      ...viewport,
      measure: vi.fn().mockReturnValueOnce(pending.promise).mockImplementation(viewport.measure),
    };
    await render(first, "entry", "source", cap);
    const earlier = reveal.reportGlyphRects(report);
    expect(
      await reveal.reportGlyphRects({ ...report, rects: [{ x: 0, y: 20, width: 30, height: 12 }] }),
    ).toBe(true);
    pending.finish({
      rect: { x: 0, y: 0, width: 320, height: 600 },
      scroll: 0,
      insets: { top: 60, bottom: 80 },
    });
    expect(await earlier).toBe(false);
    expect(onRevealed).toHaveBeenCalledExactlyOnceWith(first.requestId);
  });
});
