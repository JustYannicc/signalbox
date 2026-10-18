// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const session = {
    ownerKey: "capture-owner" as string | null,
    pendingRecordingOwnerKey: null as string | null,
    start: vi.fn(async () => undefined),
    cancel: vi.fn(),
  };
  const global = {
    ownerKey: "capture-owner" as string | null,
    state: { phase: "recording", error: null, errorAction: null },
    isAvailable: true,
    isBusy: true,
    audioLevels: [],
    elapsedSeconds: 1,
    setOwnerFocused: vi.fn(),
    session,
    stop: vi.fn(async () => undefined),
    cancel: vi.fn(),
  };
  return { global, session };
});

vi.mock("@react-navigation/native", () => ({ useFocusEffect: () => undefined }));
vi.mock("./VoiceInputProvider", () => ({ useGlobalVoiceInput: () => mocks.global }));
vi.mock("./voiceInputSession", () => ({
  createVoiceInputTarget: (ownerKey: string) => ({ ownerKey }),
}));

import { useVoiceInputController } from "./useVoiceInputController";

describe("voice input controller ownership", () => {
  let root: Root | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.global.ownerKey = "capture-owner";
    mocks.global.state = { phase: "recording", error: null, errorAction: null };
    mocks.global.isBusy = true;
    mocks.global.stop.mockClear();
    mocks.session.ownerKey = "capture-owner";
    mocks.session.pendingRecordingOwnerKey = null;
    mocks.session.cancel.mockClear();
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
  });

  function renderController() {
    let current: ReturnType<typeof useVoiceInputController> | null = null;
    function Harness() {
      const result = useVoiceInputController({
        ownerKey: "capture-owner",
        label: "Capture",
        readDraftMessage: () => "",
        subscribeToDraftChanges: () => () => undefined,
        selection: { start: 0, end: 0 },
        onChangeDraftMessage: () => undefined,
        onChangeSelection: () => undefined,
      });
      useLayoutEffect(() => {
        current = result;
      }, [result]);
      return null;
    }
    act(() => root!.render(<Harness />));
    return {
      get current() {
        if (!current) throw new Error("controller has not rendered");
        return current;
      },
    };
  }

  it("does not stop a new owner's recording when the prior owner's callback runs", async () => {
    const controller = renderController();
    mocks.global.ownerKey = "another-owner";
    mocks.session.ownerKey = "another-owner";

    await act(async () => controller.current.stop());

    expect(mocks.global.stop).not.toHaveBeenCalled();
  });

  it("cancels only the pending recording owned by this controller", () => {
    const controller = renderController();
    mocks.session.ownerKey = "another-owner";
    mocks.session.pendingRecordingOwnerKey = "another-owner";
    expect(controller.current.hasPendingRecording()).toBe(false);
    controller.current.cancelOwned();
    controller.current.cancelPendingRecording();
    expect(mocks.session.cancel).not.toHaveBeenCalled();

    mocks.session.ownerKey = "capture-owner";
    mocks.session.pendingRecordingOwnerKey = "capture-owner";
    expect(controller.current.hasPendingRecording()).toBe(true);
    controller.current.cancelPendingRecording();
    expect(mocks.session.cancel).toHaveBeenCalledWith("capture-owner");
  });
});
