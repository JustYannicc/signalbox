import type { ThreadFindRevealRequest } from "./thread-find-model";

export interface ThreadFindRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ThreadFindInsets {
  readonly top: number;
  readonly bottom: number;
  readonly left?: number;
  readonly right?: number;
}

export interface ThreadFindMeasureNode {
  measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
}

export interface ThreadFindViewport {
  measure(): Promise<{
    readonly rect: ThreadFindRect;
    readonly scroll: number;
    readonly insets: ThreadFindInsets;
  } | null>;
  scrollTo(offset: number): Promise<void>;
}

export function measureThreadFindNode(node: ThreadFindMeasureNode): Promise<ThreadFindRect | null> {
  return new Promise((resolve) => {
    node.measureInWindow((x, y, width, height) => {
      const rect = { x, y, width, height };
      resolve(validThreadFindRect(rect) ? rect : null);
    });
  });
}

function validThreadFindRect(rect: ThreadFindRect): boolean {
  return (
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

export function threadFindVisibleViewport(rect: ThreadFindRect, insets: ThreadFindInsets) {
  if (
    !validThreadFindRect(rect) ||
    ![insets.top, insets.bottom, insets.left ?? 0, insets.right ?? 0].every(Number.isFinite)
  ) {
    return null;
  }
  const visible = {
    x: rect.x + Math.max(0, insets.left ?? 0),
    y: rect.y + Math.max(0, insets.top),
    width: rect.width - Math.max(0, insets.left ?? 0) - Math.max(0, insets.right ?? 0),
    height: rect.height - Math.max(0, insets.top) - Math.max(0, insets.bottom),
  };
  return validThreadFindRect(visible) ? visible : null;
}

const PIXEL_TOLERANCE = 1;

/** Both rectangles use window coordinates. Positive delta scrolls content upward. */
export function threadFindVerticalDelta(glyph: ThreadFindRect, viewport: ThreadFindRect) {
  if (!validThreadFindRect(glyph) || !validThreadFindRect(viewport)) return null;
  if (glyph.y < viewport.y - PIXEL_TOLERANCE) return glyph.y - viewport.y;
  const bottomDelta = glyph.y + glyph.height - viewport.y - viewport.height;
  return bottomDelta > PIXEL_TOLERANCE ? bottomDelta : 0;
}

function glyphIsVisible(glyph: ThreadFindRect, viewport: ThreadFindRect) {
  return (
    threadFindVerticalDelta(glyph, viewport) === 0 &&
    glyph.x >= viewport.x - PIXEL_TOLERANCE &&
    glyph.x + glyph.width <= viewport.x + viewport.width + PIXEL_TOLERANCE
  );
}

export function matchesThreadFindRequest(
  active: ThreadFindRevealRequest | null,
  request: Pick<ThreadFindRevealRequest, "requestId" | "revision" | "target">,
) {
  return (
    active !== null &&
    active.requestId === request.requestId &&
    active.revision === request.revision &&
    active.target.entryId === request.target.entryId
  );
}

/** Native layout supplies the glyph; row/string estimates never enter this path. */
export async function revealThreadFindGlyph(input: {
  readonly rootRef: { readonly current: ThreadFindMeasureNode | null };
  readonly rects: ReadonlyArray<ThreadFindRect>;
  readonly viewports: ReadonlyArray<ThreadFindViewport>;
  readonly isCurrent: () => boolean;
}): Promise<boolean> {
  const node = input.rootRef.current;
  const glyph = input.rects[0];
  if (!node || !glyph || !input.rects.every(validThreadFindRect) || input.viewports.length === 0) {
    return false;
  }
  const current = () => input.isCurrent() && input.rootRef.current === node;
  const measureGlyph = async () => {
    if (!current()) return null;
    const root = await measureThreadFindNode(node);
    return current() && root ? { ...glyph, x: root.x + glyph.x, y: root.y + glyph.y } : null;
  };
  // Reveal the nearest cap first. Its scroll changes the glyph's window position.
  for (const viewport of input.viewports) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!current()) return false;
      const measured = await viewport.measure();
      if (!current() || !measured || !Number.isFinite(measured.scroll)) return false;
      const visible = threadFindVisibleViewport(measured.rect, measured.insets);
      const rect = await measureGlyph();
      if (!visible || !rect || !current()) return false;
      const delta = threadFindVerticalDelta(rect, visible);
      if (delta === null || rect.height > visible.height + PIXEL_TOLERANCE) return false;
      if (delta === 0) break;
      if (!current()) return false;
      await viewport.scrollTo(measured.scroll + delta);
      if (!current()) return false;
    }
  }
  // Promises can resolve after clamping or a superseding layout. Only native
  // remeasurement proves the selected glyph survived every viewport.
  for (const viewport of input.viewports) {
    if (!current()) return false;
    const measured = await viewport.measure();
    if (!current()) return false;
    const rect = await measureGlyph();
    if (!current() || !measured || !rect) return false;
    const visible = threadFindVisibleViewport(measured.rect, measured.insets);
    if (!visible || !glyphIsVisible(rect, visible)) return false;
  }
  return current();
}
