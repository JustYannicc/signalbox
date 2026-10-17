import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  closeQuickCapture,
  openQuickCapture,
  restoreQuickCapture,
  useQuickCaptureStore,
  type CaptureRestore,
} from "./quickCaptureStore";

const failed = (text: string): CaptureRestore => ({ text, files: [], destination: null });

describe("quickCaptureStore", () => {
  beforeEach(() => {
    useQuickCaptureStore.setState({ open: false, openCount: 0, restore: null, waiting: [] });
  });

  it("doesn't remount an open capture, which would drop what's typed", () => {
    openQuickCapture();
    openQuickCapture();
    expect(useQuickCaptureStore.getState()).toMatchObject({ open: true, openCount: 1 });
  });

  it("reopens a failed save at once when nothing is open", () => {
    restoreQuickCapture(failed("buy milk"));
    expect(useQuickCaptureStore.getState()).toMatchObject({
      open: true,
      openCount: 1,
      restore: { text: "buy milk" },
    });
  });

  it("holds failed saves while another capture is open and reopens each in turn", () => {
    openQuickCapture();
    restoreQuickCapture(failed("first"));
    restoreQuickCapture(failed("second"));
    expect(useQuickCaptureStore.getState()).toMatchObject({ openCount: 1, restore: null });

    closeQuickCapture();
    expect(useQuickCaptureStore.getState()).toMatchObject({
      open: true,
      openCount: 2,
      restore: { text: "first" },
    });

    closeQuickCapture();
    expect(useQuickCaptureStore.getState()).toMatchObject({
      openCount: 3,
      restore: { text: "second" },
    });

    closeQuickCapture();
    expect(useQuickCaptureStore.getState().open).toBe(false);
  });

  it("starts a plain opening empty, even after a restored one", () => {
    restoreQuickCapture(failed("old"));
    closeQuickCapture();
    openQuickCapture();
    expect(useQuickCaptureStore.getState().restore).toBeNull();
  });
});
