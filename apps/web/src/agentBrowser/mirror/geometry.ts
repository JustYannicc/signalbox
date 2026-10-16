export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Where the mirrored page sits in the frame: scaled down to fit, never up, and centered. */
export interface Fit {
  readonly scale: number;
  readonly left: number;
  readonly top: number;
}

export function fitPage(frame: Size, page: Size): Fit {
  if (!(page.width > 0 && page.height > 0 && frame.width > 0 && frame.height > 0)) {
    return { scale: 1, left: 0, top: 0 };
  }
  const scale = Math.min(1, frame.width / page.width, frame.height / page.height);
  return {
    scale,
    left: (frame.width - page.width * scale) / 2,
    top: (frame.height - page.height * scale) / 2,
  };
}

/**
 * A point in the frame as the page's CSS pixels. Outside the page it's null,
 * unless `clamp` pins it to the nearest edge (a drag that leaves the page).
 */
export function toPagePoint(
  clientX: number,
  clientY: number,
  fit: Fit,
  page: Size,
  clamp: boolean,
): { readonly x: number; readonly y: number } | null {
  const x = (clientX - fit.left) / fit.scale;
  const y = (clientY - fit.top) / fit.scale;
  const inside = x >= 0 && y >= 0 && x <= page.width && y <= page.height;
  if (!inside && !clamp) return null;
  return {
    x: Math.min(Math.max(x, 0), page.width),
    y: Math.min(Math.max(y, 0), page.height),
  };
}

const WHEEL_LINE_PX = 16;

/** A wheel delta in pixels, whatever unit the device reported it in. */
export function wheelDeltaPx(delta: number, deltaMode: number, pageHeight: number): number {
  // 1 is DOM_DELTA_LINE, 2 is DOM_DELTA_PAGE.
  return deltaMode === 1 ? delta * WHEEL_LINE_PX : deltaMode === 2 ? delta * pageHeight : delta;
}

/**
 * CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. Same as client-runtime's
 * `previewStreamModifiers`; importing that module would pull the contracts
 * barrel (~440 kB) into this page.
 */
export function inputModifiers(event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/**
 * The text a key types, as CDP wants it: printable keys without Ctrl or Meta,
 * and Enter as "\r" so forms submit and textareas break lines.
 */
export function keyText(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): string | undefined {
  if (event.ctrlKey || event.metaKey) return undefined;
  if ([...event.key].length === 1) return event.key;
  return event.key === "Enter" ? "\r" : undefined;
}
