import { describe, expect, it, vi } from "vite-plus/test";

import {
  matchesThreadFindRequest,
  revealThreadFindGlyph,
  threadFindVerticalDelta,
  threadFindVisibleViewport,
  type ThreadFindMeasureNode,
  type ThreadFindViewport,
} from "./thread-find-geometry";
import type { ThreadFindRevealRequest } from "./thread-find-model";
import { threadFindRequestForSource } from "./thread-find-model";

const request: ThreadFindRevealRequest = {
  key: "open:7",
  requestId: "open",
  revision: "7",
  snapshotSequence: 7,
  threadKey: "environment:thread",
  query: "needle",
  occurrence: 2,
  target: { entryId: "message", runId: null },
};
const glyph = { x: 10, y: 0, width: 30, height: 12 };

function pending<T>() {
  let finish!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

function scrollScene() {
  let outerScroll = 0;
  let innerScroll = 0;
  const order: string[] = [];
  const root: ThreadFindMeasureNode = {
    measureInWindow: (callback) => callback(0, 700 - outerScroll - innerScroll, 300, 1000),
  };
  const inner: ThreadFindViewport = {
    measure: async () => ({
      rect: { x: 0, y: 500 - outerScroll, width: 300, height: 120 },
      scroll: innerScroll,
      insets: { top: 4, bottom: 8 },
    }),
    scrollTo: vi.fn(async (offset) => {
      order.push("inner");
      innerScroll = offset;
    }),
  };
  const outer: ThreadFindViewport = {
    measure: async () => ({
      rect: { x: 0, y: 40, width: 300, height: 400 },
      scroll: outerScroll,
      insets: { top: 60, bottom: 80 },
    }),
    scrollTo: vi.fn(async (offset) => {
      order.push("outer");
      outerScroll = offset;
    }),
  };
  return { rootRef: { current: root }, inner, outer, order };
}

describe("measured Find reveal", () => {
  it("uses viewport window origin, header/composer insets and signed exact deltas", () => {
    const visible = threadFindVisibleViewport(
      { x: 20, y: 40, width: 300, height: 500 },
      { top: 80, bottom: 100, left: 10, right: 5 },
    );
    expect(visible).toEqual({ x: 30, y: 120, width: 285, height: 320 });
    expect(threadFindVerticalDelta({ ...glyph, y: 105 }, visible!)).toBe(-15);
    expect(threadFindVerticalDelta({ ...glyph, y: 460 }, visible!)).toBe(32);
    expect(threadFindVerticalDelta({ ...glyph, y: 120 }, visible!)).toBe(0);
    expect(
      threadFindVisibleViewport({ x: 0, y: 0, width: 10, height: 20 }, { top: 15, bottom: 10 }),
    ).toBeNull();
  });

  it("reveals the nearest cap then outer feed, remeasuring after each actual scroll", async () => {
    const scene = scrollScene();
    expect(
      await revealThreadFindGlyph({
        rootRef: scene.rootRef,
        rects: [glyph],
        viewports: [scene.inner, scene.outer],
        isCurrent: () => true,
      }),
    ).toBe(true);
    expect(scene.order).toEqual(["inner", "outer"]);
    expect(scene.inner.scrollTo).toHaveBeenCalledExactlyOnceWith(100);
    expect(scene.outer.scrollTo).toHaveBeenCalledExactlyOnceWith(252);
  });

  it("adds the measured delta to the current offset, including a negative automatic-inset offset", async () => {
    let scroll = 10;
    const root: ThreadFindMeasureNode = {
      measureInWindow: (callback) => callback(20, 115 - scroll, 300, 100),
    };
    const viewport: ThreadFindViewport = {
      measure: async () => ({
        rect: { x: 20, y: 40, width: 300, height: 400 },
        scroll,
        insets: { top: 80, bottom: 100 },
      }),
      scrollTo: vi.fn(async (offset) => {
        scroll = offset;
      }),
    };
    expect(
      await revealThreadFindGlyph({
        rootRef: { current: root },
        rects: [glyph],
        viewports: [viewport],
        isCurrent: () => true,
      }),
    ).toBe(true);
    expect(viewport.scrollTo).toHaveBeenCalledExactlyOnceWith(-5);
  });

  it.each(["close", "next", "revision"])(
    "aborts a pending measurement after %s",
    async (change) => {
      const scene = scrollScene();
      const measurement = pending<Awaited<ReturnType<ThreadFindViewport["measure"]>>>();
      scene.inner.measure = () => measurement.promise;
      let active: ThreadFindRevealRequest | null = request;
      const result = revealThreadFindGlyph({
        rootRef: scene.rootRef,
        rects: [glyph],
        viewports: [scene.inner, scene.outer],
        isCurrent: () => matchesThreadFindRequest(active, request),
      });
      active =
        change === "close"
          ? null
          : change === "next"
            ? { ...request, requestId: "next" }
            : { ...request, revision: "8" };
      measurement.finish({
        rect: { x: 0, y: 500, width: 300, height: 120 },
        scroll: 0,
        insets: { top: 0, bottom: 0 },
      });
      expect(await result).toBe(false);
      expect(scene.order).toEqual([]);
    },
  );

  it("does not scroll the outer list when the source changes during the inner scroll", async () => {
    const scene = scrollScene();
    let sourceCurrent = true;
    const innerScroll = scene.inner.scrollTo;
    scene.inner.scrollTo = async (offset) => {
      await innerScroll(offset);
      sourceCurrent = false;
    };
    expect(
      await revealThreadFindGlyph({
        rootRef: scene.rootRef,
        rects: [glyph],
        viewports: [scene.inner, scene.outer],
        isCurrent: () => sourceCurrent,
      }),
    ).toBe(false);
    expect(scene.order).toEqual(["inner"]);
  });

  it("rejects a recycled native root and never acknowledges a clamped glyph outside the cap", async () => {
    const scene = scrollScene();
    scene.inner.scrollTo = async () => {};
    expect(
      await revealThreadFindGlyph({
        rootRef: scene.rootRef,
        rects: [glyph],
        viewports: [scene.inner],
        isCurrent: () => true,
      }),
    ).toBe(false);
    let activeNode: ThreadFindMeasureNode | null = scene.rootRef.current;
    const original = activeNode;
    activeNode = {
      measureInWindow(callback) {
        activeNode = original;
        callback(0, 100, 300, 1000);
      },
    };
    expect(
      await revealThreadFindGlyph({
        rootRef: {
          get current() {
            return activeNode;
          },
        },
        rects: [glyph],
        viewports: [scene.outer],
        isCurrent: () => true,
      }),
    ).toBe(false);
  });

  it("requires evidence for glyphs while old servers retain row navigation", () => {
    expect(threadFindRequestForSource(request, request.threadKey)).toBeNull();
    const evidenced = {
      ...request,
      evidence: { version: 1 as const, documentId: "digest", segmentIndex: 0, start: 0, end: 6 },
    };
    expect(threadFindRequestForSource(evidenced, request.threadKey)).toBe(evidenced);
    expect(threadFindRequestForSource(evidenced, "other-thread")).toBeNull();
  });
});
