import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  type DesktopCaptureEvent,
  type DesktopCaptureState,
  type DesktopPendingCapture,
} from "@t3tools/contracts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import type { DesktopCaptureBridge } from "./desktopCaptureBridge";
import { DesktopCapturePanel } from "./DesktopCapturePanel";
import {
  createDesktopPanelDraftStorage,
  desktopPanelDraftStorage,
  type DesktopPanelDraft,
} from "./desktopPanelDraft";

const bridge = vi.hoisted(() => ({
  getCaptureState: vi.fn<() => Promise<DesktopCaptureState>>(),
  hideCapture: vi.fn<() => Promise<void>>(),
  completeCaptureFlush: vi.fn<DesktopCaptureBridge["completeCaptureFlush"]>(),
  submitCapture: vi.fn<DesktopCaptureBridge["submitCapture"]>(),
  retryCaptureAtOwnerTop: vi.fn<DesktopCaptureBridge["retryCaptureAtOwnerTop"]>(),
  onCaptureEvent: vi.fn<(listener: (event: DesktopCaptureEvent) => void) => () => void>(),
}));
vi.mock("./desktopCaptureBridge", () => ({ getDesktopCaptureBridge: () => bridge }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => undefined }));

const destination = {
  key: "account:top",
  environmentId: EnvironmentId.make("environment"),
  ownerProjectId: ProjectId.make("account"),
  folderId: null,
  label: "Top level",
  detail: null,
  inPlace: "at the top level",
};
const emptyState: DesktopCaptureState = {
  destinations: [],
  pending: [],
  shortcut: {
    enabled: true,
    shortcut: {
      key: " ",
      modKey: false,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    },
    registered: true,
    message: null,
  },
};
const saved: DesktopPanelDraft = {
  id: "aabbcc",
  capture: { text: "Unread capture", destination, files: [] },
};
function pending(destinationKey: string, id = saved.id): DesktopPendingCapture {
  return {
    id,
    destinationKey,
    text: saved.capture.text,
    files: [],
    owner: { environmentId: destination.environmentId, ownerProjectId: destination.ownerProjectId },
    source: "quick-capture",
    capturedAt: 0,
    open: false,
    deliveryError: "Couldn't deliver",
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let root: Root;
let container: HTMLDivElement;
let emit: (event: DesktopCaptureEvent) => void;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  bridge.getCaptureState.mockReset().mockResolvedValue(emptyState);
  bridge.hideCapture.mockReset().mockResolvedValue(undefined);
  bridge.completeCaptureFlush.mockReset().mockResolvedValue(undefined);
  bridge.submitCapture.mockReset().mockResolvedValue(pending(destination.key));
  bridge.retryCaptureAtOwnerTop.mockReset().mockResolvedValue(pending(destination.key));
  bridge.onCaptureEvent.mockImplementation((listener) => {
    emit = listener;
    return () => undefined;
  });
  await desktopPanelDraftStorage().write(saved);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
  await desktopPanelDraftStorage().write(null);
  container.remove();
  vi.unstubAllGlobals();
});

const readPersisted = () => createDesktopPanelDraftStorage(indexedDB).read();
const render = () => act(() => root.render(<DesktopCapturePanel />));

describe("desktop capture restoration", () => {
  it("hides without deleting unread content while restoration is pending", async () => {
    const read = deferred<DesktopPanelDraft | null>();
    vi.spyOn(desktopPanelDraftStorage(), "read").mockReturnValueOnce(read.promise);
    await render();
    expect(container.querySelector("textarea")).toBeNull();
    await act(() => {
      emit({ type: "dismiss-requested" });
    });
    expect(bridge.hideCapture).toHaveBeenCalledOnce();
    expect(await readPersisted()).toEqual(saved);
    await act(async () => {
      read.resolve(saved);
      await read.promise;
    });
    expect(container.querySelector("textarea")?.value).toBe(saved.capture.text);
  });

  it("keeps the restored draft when the bridge cannot load its state", async () => {
    bridge.getCaptureState.mockRejectedValueOnce(new Error("bridge unavailable"));
    const read = deferred<DesktopPanelDraft | null>();
    vi.spyOn(desktopPanelDraftStorage(), "read").mockReturnValueOnce(read.promise);
    await render();
    await act(async () => {
      read.resolve(saved);
      await read.promise;
    });
    expect(container.textContent).toContain("bridge unavailable");
    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(bridge.hideCapture).toHaveBeenCalledOnce();
    expect(await readPersisted()).toEqual(saved);
    await act(() => {
      emit({ type: "shown" });
    });
    expect(container.querySelector("textarea")?.value).toBe(saved.capture.text);
  });

  it("retries a failed read on reopening while continuing to refresh bridge state", async () => {
    const read = deferred<DesktopPanelDraft | null>();
    const retry = deferred<DesktopPanelDraft | null>();
    const readSpy = vi
      .spyOn(desktopPanelDraftStorage(), "read")
      .mockReturnValueOnce(read.promise)
      .mockReturnValueOnce(retry.promise);
    await render();
    await act(async () => {
      read.reject(new Error("storage unavailable"));
      await read.promise.catch(() => undefined);
    });
    expect(container.textContent).toContain("storage unavailable");
    expect(container.querySelector("textarea")).toBeNull();
    await act(() => {
      emit({ type: "dismiss-requested" });
    });
    expect(await readPersisted()).toEqual(saved);
    await act(() => {
      emit({ type: "shown" });
    });
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(bridge.getCaptureState).toHaveBeenCalledTimes(2);
    await act(async () => {
      retry.resolve(saved);
      await retry.promise;
    });
    expect(container.querySelector("textarea")?.value).toBe(saved.capture.text);
    expect(container.textContent).not.toContain("storage unavailable");
  });
});

describe("desktop capture completion", () => {
  it("hides after native submission even when draft deletion fails, and still acknowledges quit", async () => {
    bridge.getCaptureState.mockResolvedValue({ ...emptyState, destinations: [destination] });
    const restored = deferred<DesktopPanelDraft | null>();
    vi.spyOn(desktopPanelDraftStorage(), "read").mockReturnValueOnce(restored.promise);
    await render();
    await act(async () => {
      restored.resolve(saved);
      await restored.promise;
    });
    await act(() => desktopPanelDraftStorage().flush());
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(() => {
      throw new Error("delete failed");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hidden = deferred<void>();
    bridge.hideCapture.mockImplementation(async () => {
      hidden.resolve();
    });
    await act(() => {
      emit({ type: "dismiss-requested" });
    });
    await act(async () => {
      await hidden.promise;
    });
    expect(bridge.submitCapture).toHaveBeenCalledWith(
      expect.objectContaining({ id: saved.id, text: saved.capture.text }),
    );
    expect(log).toHaveBeenCalledWith(
      "Couldn't remove the submitted capture draft.",
      expect.any(Error),
    );
    expect((await readPersisted())?.id).toBe(saved.id);
    const flushed = deferred<void>();
    bridge.completeCaptureFlush.mockImplementation(async () => {
      flushed.resolve();
    });
    await act(async () => {
      emit({ type: "flush-requested", requestId: "quit" });
      await flushed.promise;
    });
    expect(bridge.completeCaptureFlush).toHaveBeenCalledWith({ requestId: "quit", error: null });
  });

  it("offers moving to the owner top only for a missing original folder", async () => {
    const folder = { ...destination, key: "account:folder", folderId: FolderId.make("folder") };
    bridge.getCaptureState.mockResolvedValue({
      ...emptyState,
      destinations: [destination, folder],
      pending: [
        pending("account:missing", "a"),
        pending(destination.key, "b"),
        pending(folder.key, "c"),
      ],
    });
    const restored = deferred<DesktopPanelDraft | null>();
    vi.spyOn(desktopPanelDraftStorage(), "read").mockReturnValueOnce(restored.promise);
    await render();
    await act(async () => {
      restored.resolve(null);
      await restored.promise;
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const retries = buttons.filter((button) => button.textContent === "Retry at top level");
    expect(retries).toHaveLength(1);
    expect(buttons.some((button) => button.textContent === "Open Signalbox to retry")).toBe(true);
    await act(() => retries[0]!.click());
    expect(bridge.retryCaptureAtOwnerTop).toHaveBeenCalledWith("a");
  });
});
