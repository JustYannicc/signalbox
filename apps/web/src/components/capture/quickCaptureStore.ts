/**
 * Whether quick capture is open. The sidebar New button, the `capture.open`
 * keybinding and the command palette open it; `QuickCaptureHost`, mounted once
 * with the app shell, shows it.
 */
import { create } from "zustand";

import type { CaptureFile } from "./captureAttachments";
import type { CaptureDestination } from "./captureDestinations";

/** A capture whose save failed, reopened as it was. */
export interface CaptureRestore {
  readonly text: string;
  readonly files: ReadonlyArray<CaptureFile>;
  readonly destination: CaptureDestination | null;
}

/** `openCount` tells each opening apart, so the form starts fresh every time. */
export const useQuickCaptureStore = create<{
  readonly open: boolean;
  readonly openCount: number;
  /** What the current opening starts with. */
  readonly restore: CaptureRestore | null;
  /** Failed saves that came back while another capture was open. */
  readonly waiting: ReadonlyArray<CaptureRestore>;
}>(() => ({ open: false, openCount: 0, restore: null, waiting: [] }));

/** A no-op while it's open: reopening would remount it and drop what's typed. */
export const openQuickCapture = () =>
  useQuickCaptureStore.setState((state) =>
    state.open ? state : { open: true, openCount: state.openCount + 1, restore: null },
  );

/** Reopens a failed save now, or right after the capture that's open closes. */
export const restoreQuickCapture = (restore: CaptureRestore) =>
  useQuickCaptureStore.setState((state) =>
    state.open
      ? { waiting: [...state.waiting, restore] }
      : { open: true, openCount: state.openCount + 1, restore },
  );

/** `openCount`: close only that opening, a no-op once another has replaced it or it's closed. */
export const closeQuickCapture = (openCount?: number) =>
  useQuickCaptureStore.setState((state) => {
    if (!state.open || (openCount !== undefined && openCount !== state.openCount)) return state;
    const [next, ...rest] = state.waiting;
    return next === undefined
      ? { open: false }
      : { openCount: state.openCount + 1, restore: next, waiting: rest };
  });

/** For app-wide shortcut handlers, which stand down while it's open. */
export const isQuickCaptureOpen = () => useQuickCaptureStore.getState().open;
