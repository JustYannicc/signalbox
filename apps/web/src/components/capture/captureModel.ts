import type { CaptureToken } from "./captureTokens";

/**
 * Who opened the bar. The in-app New button starts a chat (no destination
 * chip); "resume" reopens the saved draft as it was; anything else (the
 * hotkey, the palette, other buttons) preselects the assistant chip.
 */
export type OpenQuickCaptureSource = "new-button" | "hotkey" | "resume" | "elsewhere";

export interface OpenQuickCaptureOptions {
  /** Pre-filled `#section` / `#project` chips, e.g. from a Home "+" button; these skip the assistant chip. */
  readonly tokens?: ReadonlyArray<CaptureToken>;
  /** Default "elsewhere". */
  readonly source?: OpenQuickCaptureSource;
}

// Tiny window event bus so the New button, a keybinding, or a Home "+" can
// open the New bar without owning its state (same shape as commandPaletteBus).
const QUICK_CAPTURE_OPEN_EVENT = "t3code:open-quick-capture";

export function openQuickCapture(options: OpenQuickCaptureOptions = {}): void {
  window.dispatchEvent(
    new CustomEvent<OpenQuickCaptureOptions>(QUICK_CAPTURE_OPEN_EVENT, { detail: options }),
  );
}

export function onOpenQuickCapture(
  listener: (options: OpenQuickCaptureOptions) => void,
): () => void {
  const handle = (event: Event) => {
    listener((event as CustomEvent<OpenQuickCaptureOptions | null>).detail ?? {});
  };
  window.addEventListener(QUICK_CAPTURE_OPEN_EVENT, handle);
  return () => window.removeEventListener(QUICK_CAPTURE_OPEN_EVENT, handle);
}

/** mod+Enter inside the New bar: open what you typed as a full chat. */
export function isOpenFullChatShortcut(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  isMac: boolean,
): boolean {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && !event.shiftKey && event.key === "Enter";
}
