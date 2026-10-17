/**
 * Whether quick capture is open. The sidebar New button, the `capture.open`
 * keybinding and the command palette open it; `QuickCaptureHost`, mounted once
 * with the app shell, shows it.
 */
import { create } from "zustand";

import type { CaptureDestination } from "./captureDestinations";

/** What a reopened capture starts with, when saving it failed. */
export interface CaptureRestore {
  readonly text: string;
  readonly destination: CaptureDestination | null;
}

/** `openCount` tells each opening apart, so the form starts fresh every time. */
export const useQuickCaptureStore = create<{
  readonly open: boolean;
  readonly openCount: number;
  readonly restore: CaptureRestore | null;
}>(() => ({ open: false, openCount: 0, restore: null }));

/** A no-op while it's open: reopening would remount it and drop what's typed. */
export const openQuickCapture = (restore: CaptureRestore | null = null) =>
  useQuickCaptureStore.setState((state) =>
    state.open ? state : { open: true, openCount: state.openCount + 1, restore },
  );

export const closeQuickCapture = () => useQuickCaptureStore.setState({ open: false });

/** For app-wide shortcut handlers, which stand down while it's open. */
export const isQuickCaptureOpen = () => useQuickCaptureStore.getState().open;
