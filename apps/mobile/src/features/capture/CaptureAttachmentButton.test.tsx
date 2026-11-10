// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DraftComposerAttachment } from "../../lib/composerImages";

type PickResult = {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly error: string | null;
};

const mocks = vi.hoisted(() => ({
  menuAction: null as null | ((event: { nativeEvent: { event: string } }) => void),
  pickMedia: vi.fn<() => Promise<PickResult>>(),
}));

vi.mock("@t3tools/contracts", () => ({
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS: 5,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES: 10_000_000,
}));
vi.mock("react-native", () => ({ Pressable: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: { onPressAction: (event: { nativeEvent: { event: string } }) => void }) => {
    mocks.menuAction = props.onPressAction;
    return null;
  },
}));
vi.mock("../../lib/composerImages", () => ({
  convertPastedImagesToAttachments: vi.fn(),
  persistComposerAttachmentFile: vi.fn(),
  pickComposerFiles: vi.fn(),
  pickComposerMedia: mocks.pickMedia,
}));
vi.mock("../../lib/foreground-handoff", () => ({ beginForegroundHandoff: () => () => undefined }));

import { CaptureAttachmentButton } from "./CaptureAttachmentButton";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const attachment: DraftComposerAttachment = {
  id: "accepted-image",
  type: "image",
  name: "accepted.png",
  mimeType: "image/png",
  sizeBytes: 3,
  previewUri: "file:///accepted.png",
  dataUrl: "data:image/png;base64,YWJj",
};

describe("capture attachment picker", () => {
  let root: Root | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.menuAction = null;
    mocks.pickMedia.mockReset();
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
  });

  it("uses the current destination callback and reports partial errors after appending", async () => {
    const pickerResult = deferred<PickResult>();
    mocks.pickMedia.mockReturnValueOnce(pickerResult.promise);
    const calls: string[] = [];
    const addAtA = vi.fn(() => {
      calls.push("destination-a");
      return 0;
    });
    const addAtB = vi.fn((attachments: ReadonlyArray<DraftComposerAttachment>) => {
      calls.push(`append:${attachments[0]?.id}`);
      return 0;
    });
    const onError = vi.fn((message: string) => calls.push(`error:${message}`));
    const renderButton = (onAddAttachments: typeof addAtA | typeof addAtB) => {
      act(() =>
        root!.render(
          <CaptureAttachmentButton
            disabled={false}
            existingCount={0}
            supportsFiles
            onAddAttachments={onAddAttachments}
            onError={onError}
          />,
        ),
      );
    };

    renderButton(addAtA);
    act(() => mocks.menuAction?.({ nativeEvent: { event: "photos" } }));
    renderButton(addAtB);

    await act(async () => {
      pickerResult.resolve({
        attachments: [attachment],
        error: "One selected image was too large.",
      });
      await pickerResult.promise;
    });

    expect(addAtA).not.toHaveBeenCalled();
    expect(addAtB).toHaveBeenCalledWith([attachment]);
    expect(calls).toEqual(["append:accepted-image", "error:One selected image was too large."]);
  });
});
