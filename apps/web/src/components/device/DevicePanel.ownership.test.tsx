// @vitest-environment jsdom

import {
  DeviceId,
  EnvironmentId,
  LOCAL_DEVICE_HOST_ID,
  ThreadId,
  type DeviceCloseInput,
  type DeviceOpenInput,
  type DeviceServiceState,
  type DeviceSession,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as actualCause from "effect/Cause";
import { act, StrictMode, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  snapshot: null as unknown,
  listeners: new Set<() => void>(),
  list: vi.fn(),
  open: vi.fn(),
  cancelOpen: vi.fn(),
  close: vi.fn(),
  resolveLateAdoption: null as (() => void) | null,
  delayExactOwnerSessionId: null as string | null,
  delayNextManualSelection: false,
  pendingManualSelections: new Map<string, () => void>(),
  streamReadOnlyValues: [] as boolean[],
}));

vi.mock("~/state/device", async () => {
  const React = await import("react");
  return {
    deviceEnvironment: {
      list: "device-list",
      open: "device-open",
      cancelOpen: "device-cancel",
      close: "device-close",
    },
    useDeviceState: () => ({
      state: React.useSyncExternalStore(
        (listener: () => void) => {
          fake.listeners.add(listener);
          return () => fake.listeners.delete(listener);
        },
        () => fake.snapshot,
        () => fake.snapshot,
      ),
      loaded: true,
    }),
    useDeviceAgentCommandFailure: () => null,
  };
});

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    ({
      "device-list": fake.list,
      "device-open": fake.open,
      "device-cancel": fake.cancelOpen,
      "device-close": fake.close,
    })[command],
}));

vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: () => "Device open failed" }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { browserAutoShowFloatingPreview: boolean }) => unknown) =>
    select({ browserAutoShowFloatingPreview: true }),
}));
vi.mock("./DeviceHostUpdates", () => ({ DeviceHostUpdates: () => null }));
vi.mock("./DeviceSetup", () => ({
  DeviceSetup: () => null,
  deviceHubReadiness: () => ({ ready: true, busy: false }),
}));
vi.mock("./DeviceLoadingView", () => ({ DeviceLoadingView: () => null }));
vi.mock("./DeviceAgentCommandFailureNotice", () => ({
  DeviceAgentCommandFailureNotice: () => null,
}));
vi.mock("./DeviceWorkspace", async () => {
  const React = await import("react");
  return {
    DeviceWorkspace: (props: { observer: boolean; onClose: () => void; onFloat: () => void }) =>
      React.createElement(
        "section",
        { "data-observer": String(props.observer) },
        React.createElement(
          "button",
          { type: "button", "aria-label": "Close device", onClick: props.onClose },
          "Close",
        ),
        React.createElement(
          "button",
          { type: "button", "aria-label": "Float device", onClick: props.onFloat },
          "Float",
        ),
      ),
  };
});
vi.mock("~/components/ui/discovery-list", async () => {
  const React = await import("react");
  return {
    DiscoveryList: (props: { children?: React.ReactNode }) =>
      React.createElement("div", null, props.children),
    DiscoveryListRow: (props: {
      title: string;
      disabled?: boolean;
      onClick?: () => void;
      "aria-label": string;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          "aria-label": props["aria-label"],
          disabled: props.disabled,
          onClick: props.onClick,
        },
        props.title,
      ),
  };
});
vi.mock("../preview/PreviewPanelShell", async () => {
  const React = await import("react");
  return {
    PreviewPanelShell: (props: { children?: React.ReactNode }) =>
      React.createElement("div", null, props.children),
  };
});
vi.mock("../chat/ChatCanvasContext", () => ({
  useChatCanvas: () => ({
    container: document.body,
    previewKey: "device:local:emulator-5554",
    layout: { frame: { x: 0, y: 0, width: 240, height: 420 } },
  }),
}));
vi.mock("../device/DeviceStreamView", () => ({
  DeviceStreamView: (props: { readonly readOnly: boolean }) => {
    fake.streamReadOnlyValues.push(props.readOnly);
    return null;
  },
}));
vi.mock("~/components/ui/button", async () => {
  const React = await import("react");
  return {
    Button: (props: {
      readonly children?: React.ReactNode;
      readonly "aria-label"?: string;
      readonly onClick?: () => void;
      readonly onPointerDown?: (event: unknown) => void;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          "aria-label": props["aria-label"],
          onClick: props.onClick,
          onPointerDown: props.onPointerDown,
        },
        props.children,
      ),
  };
});
vi.mock("~/components/ui/tooltip", async () => {
  const React = await import("react");
  return {
    Tooltip: (props: { readonly children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, props.children),
    TooltipTrigger: (props: {
      readonly render?: React.ReactNode;
      readonly children?: React.ReactNode;
    }) => props.render ?? props.children,
    TooltipPopup: () => null,
  };
});

import { useClosedViewStore } from "../../closedViewStore";
import {
  previewMiniPlayerSourceKey,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import type { ThreadPreviewState } from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { shouldRenderPreviewMiniPlayer } from "../ChatView.logic";
import { ThreadPreviewMiniPlayer } from "../preview/ThreadPreviewMiniPlayer";
import { useAgentOpenedPreviews } from "../preview/useAgentOpenedPreviews";
import { DevicePanel } from "./DevicePanel";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
const threadKey = scopedThreadKey(threadRef);
const selectedDevice = {
  hostId: LOCAL_DEVICE_HOST_ID,
  id: DeviceId.make("signalbox-pixel"),
  platform: "android",
  name: "Signalbox Pixel",
  version: "Android 15",
  booted: false,
  physical: false,
} as const;
const runtimeDevice = { ...selectedDevice, id: DeviceId.make("emulator-5554"), booted: true };
const previewState = { listLoaded: false, sessions: {} } as ThreadPreviewState;
const EMPTY_PANEL_STATE = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
} as const;

function initialState(): DeviceServiceState {
  return {
    hosts: [
      {
        id: LOCAL_DEVICE_HOST_ID,
        kind: "local",
        label: "Local",
        platforms: [{ platform: "android", available: true }],
        hubInstalled: true,
        agentDeviceInstalled: true,
      },
    ],
    hostStatus: "ready",
    hostStatuses: { local: { status: "ready" } },
    devices: [selectedDevice],
    sessions: [],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "",
    revision: 1,
  };
}

const owners = new Map<string, DeviceSession>();
const openInputs: DeviceOpenInput[] = [];
const closeInputs: DeviceCloseInput[] = [];
let exactAdoptionCalls = 0;

function publish(sessions: readonly DeviceSession[]) {
  const current = fake.snapshot as DeviceServiceState;
  fake.snapshot = { ...current, devices: [runtimeDevice], sessions: [...sessions] };
  for (const listener of fake.listeners) listener();
}

function success(session: DeviceSession) {
  return { _tag: "Success" as const, value: session };
}

function setupLeaseService() {
  owners.clear();
  openInputs.length = 0;
  closeInputs.length = 0;
  exactAdoptionCalls = 0;
  fake.resolveLateAdoption = null;
  fake.delayExactOwnerSessionId = null;
  fake.delayNextManualSelection = false;
  fake.pendingManualSelections.clear();
  fake.listeners.clear();
  fake.snapshot = initialState();
  fake.list.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  fake.cancelOpen.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  fake.open.mockReset().mockImplementation(async (request: unknown) => {
    const input = (request as { input: DeviceOpenInput }).input;
    openInputs.push(input);
    if (input.sessionId !== undefined && input.leaseId !== undefined) {
      const existing = owners.get(input.sessionId);
      if (!existing || existing.leaseId !== input.leaseId) {
        return {
          _tag: "Failure" as const,
          cause: actualCause.fail({ _tag: "DeviceOperationError", reason: "stale_session" }),
        };
      }
      exactAdoptionCalls++;
      if (input.sessionId === fake.delayExactOwnerSessionId && exactAdoptionCalls === 1) {
        return new Promise((resolve) => {
          fake.resolveLateAdoption = () => resolve(success(existing));
        });
      }
      return success(existing);
    }

    if (fake.delayNextManualSelection) {
      fake.delayNextManualSelection = false;
      const requestId = input.requestId;
      if (!requestId) throw new Error("Expected manual device opens to have a request id.");
      const session: DeviceSession = {
        sessionId: "cancelled-manual-observer",
        leaseId: "device-walk-1",
        requestId,
        ownerKind: "panel",
        observer: true,
        threadId: input.threadId,
        hostId: input.hostId ?? LOCAL_DEVICE_HOST_ID,
        deviceId: runtimeDevice.id,
        platform: input.platform,
        openedAt: "2026-10-18T00:00:00.000Z",
      };
      return new Promise((resolve) => {
        fake.pendingManualSelections.set(requestId, () => {
          owners.set(session.sessionId, session);
          publish([...owners.values()]);
          resolve(success(session));
        });
      });
    }

    const controller = [...owners.values()].find(
      (owner) =>
        owner.threadId === input.threadId && owner.ownerKind === "panel" && owner.observer !== true,
    );
    const session: DeviceSession = controller
      ? {
          sessionId: `panel-observer-${owners.size + 1}`,
          leaseId: controller.leaseId,
          requestId: input.requestId,
          ownerKind: "panel",
          observer: true,
          threadId: input.threadId,
          hostId: input.hostId ?? LOCAL_DEVICE_HOST_ID,
          deviceId: runtimeDevice.id,
          platform: input.platform,
          openedAt: "2026-10-18T00:00:00.000Z",
        }
      : {
          sessionId: "panel-controller",
          leaseId: "device-walk-1",
          requestId: input.requestId,
          ownerKind: "panel",
          observer: false,
          threadId: input.threadId,
          hostId: input.hostId ?? LOCAL_DEVICE_HOST_ID,
          deviceId: runtimeDevice.id,
          platform: input.platform,
          openedAt: "2026-10-18T00:00:00.000Z",
        };
    owners.set(session.sessionId, session);
    publish([...owners.values()]);
    return success(session);
  });
  fake.close.mockReset().mockImplementation(async (request: unknown) => {
    const input = (request as { input: DeviceCloseInput }).input;
    closeInputs.push(input);
    const current = owners.get(input.sessionId ?? "");
    if (current?.leaseId === input.leaseId && current.threadId === input.threadId)
      owners.delete(current.sessionId);
    publish([...owners.values()]);
    return { _tag: "Success" as const, value: undefined };
  });
}

function hasCanonicalSurface() {
  return useRightPanelStore
    .getState()
    .byThreadKey[threadKey]?.surfaces.some(
      (surface) => surface.kind === "device" && surface.id === "device:local:emulator-5554",
    );
}

function waitForCanonicalSurface() {
  if (hasCanonicalSurface()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = useRightPanelStore.subscribe(() => {
      if (!hasCanonicalSurface()) return;
      unsubscribe();
      resolve();
    });
  });
}

function PanelHost() {
  const deviceState = useSyncExternalStore(
    (listener) => {
      fake.listeners.add(listener);
      return () => fake.listeners.delete(listener);
    },
    () => fake.snapshot as DeviceServiceState,
    () => fake.snapshot as DeviceServiceState,
  );
  const panelState = useRightPanelStore(
    (state) => state.byThreadKey[threadKey] ?? EMPTY_PANEL_STATE,
  );
  const panelSurfaces = panelState.surfaces;
  const miniPlayer = usePreviewMiniPlayerStore((state) => state.byThreadKey[threadKey] ?? null);
  const miniPlayerSource = miniPlayer?.source ?? null;
  useAgentOpenedPreviews({
    threadRef,
    deviceState,
    deviceStateLoaded: true,
    previewState,
    serverBrowserAvailable: false,
    panelSurfaces,
    miniPlayerSource,
    sheetLayout: false,
  });
  const surface = panelState.surfaces.find((entry) => entry.id === panelState.activeSurfaceId);
  const renderedSurface = panelState.isOpen ? (surface ?? null) : null;
  const miniPlayerVisible = shouldRenderPreviewMiniPlayer(miniPlayerSource, renderedSurface);
  return (
    <>
      {surface?.kind === "device" ? (
        <DevicePanel
          key={surface.id}
          mode="embedded"
          threadRef={threadRef}
          surface={surface}
          visible={panelState.isOpen}
          onDismissSetup={() => undefined}
        />
      ) : null}
      {miniPlayer && miniPlayerVisible ? (
        <ThreadPreviewMiniPlayer threadRef={threadRef} miniPlayer={miniPlayer} />
      ) : null}
    </>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  setupLeaseService();
  fake.streamReadOnlyValues.length = 0;
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({
    byThreadKey: {},
    pendingDeviceOpensByThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function startSelectedDevice() {
  useRightPanelStore.getState().open(threadRef, "device");
  await act(async () =>
    root.render(
      <StrictMode>
        <PanelHost />
      </StrictMode>,
    ),
  );
  const start = container.querySelector<HTMLButtonElement>('[aria-label="Start Signalbox Pixel"]');
  if (!start) throw new Error("Expected the stopped Pixel row.");
  const canonicalSurface = waitForCanonicalSurface();
  fake.delayExactOwnerSessionId = "panel-controller";
  await act(async () => {
    start.click();
    await canonicalSurface;
  });
  const finishLateAdoption = fake.resolveLateAdoption;
  if (!finishLateAdoption) throw new Error("Expected StrictMode to leave one adoption in flight.");
  await act(async () => {
    finishLateAdoption();
    await Promise.resolve();
  });
}

describe("DevicePanel lease ownership", () => {
  it("keeps one controller when a stopped AVD becomes its canonical surface", async () => {
    await startSelectedDevice();

    const surface = useRightPanelStore
      .getState()
      .byThreadKey[threadKey]?.surfaces.find((entry) => entry.id === "device:local:emulator-5554");
    expect(surface).toMatchObject({
      target: {
        deviceId: runtimeDevice.id,
        sessionId: "panel-controller",
        leaseId: "device-walk-1",
      },
    });
    expect(container.querySelector('[data-observer="false"]')).not.toBeNull();
    expect([...owners.values()]).toEqual([
      expect.objectContaining({
        sessionId: "panel-controller",
        leaseId: "device-walk-1",
        observer: false,
      }),
    ]);
    expect(openInputs[0]).toMatchObject({ deviceId: selectedDevice.id });
    const canonicalRequests = openInputs.filter((input) => input.deviceId === runtimeDevice.id);
    expect(canonicalRequests.length).toBeGreaterThan(0);
    expect(
      canonicalRequests.every(
        (input) => input.sessionId === "panel-controller" && input.leaseId === "device-walk-1",
      ),
    ).toBe(true);
    expect(usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]).toBeUndefined();
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("releases the exact adopted controller when the panel closes", async () => {
    await startSelectedDevice();
    const closeButton = container.querySelector<HTMLButtonElement>('[aria-label="Close device"]');
    if (!closeButton) throw new Error("Expected the open device panel.");

    await act(async () => {
      closeButton.click();
      await Promise.resolve();
    });

    expect([...owners.values()]).toEqual([]);
    expect(closeInputs).toEqual([
      expect.objectContaining({
        threadId: threadRef.threadId,
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: runtimeDevice.id,
        sessionId: "panel-controller",
        leaseId: "device-walk-1",
      }),
    ]);
  });

  it("stores a replacement owner before the same tab remounts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    useRightPanelStore.getState().openDevice(threadRef, {
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: runtimeDevice.id,
      platform: "android",
      name: runtimeDevice.name,
      sessionId: "stale-panel-owner",
      leaseId: "stale-walk",
    });
    useRightPanelStore
      .getState()
      .renameDevice(threadRef, "device:local:emulator-5554", "Android recovery tab");

    await act(async () =>
      root.render(
        <StrictMode>
          <PanelHost />
        </StrictMode>,
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    const tab = useRightPanelStore
      .getState()
      .byThreadKey[threadKey]?.surfaces.find(
        (surface) => surface.id === "device:local:emulator-5554",
      );
    expect(tab).toMatchObject({
      title: "Android recovery tab",
      target: { sessionId: "panel-controller", leaseId: "device-walk-1" },
    });
    expect([...owners.values()]).toEqual([
      expect.objectContaining({ sessionId: "panel-controller", observer: false }),
    ]);
    expect(openInputs[0]).toMatchObject({
      sessionId: "stale-panel-owner",
      leaseId: "stale-walk",
    });
    expect(openInputs.some((input) => input.sessionId === undefined)).toBe(true);

    await act(async () => {
      root.render(
        <StrictMode>
          <PanelHost key="reacquired-owner-remount" />
        </StrictMode>,
      );
      await Promise.resolve();
    });

    expect([...owners.values()]).toEqual([
      expect.objectContaining({ sessionId: "panel-controller", observer: false }),
    ]);
    expect(closeInputs).toEqual([]);
    expect(
      openInputs
        .filter((input) => input.deviceId === runtimeDevice.id)
        .every(
          (input) =>
            (input.sessionId === "stale-panel-owner" && input.leaseId === "stale-walk") ||
            (input.sessionId === "panel-controller" && input.leaseId === "device-walk-1") ||
            input.sessionId === undefined,
        ),
    ).toBe(true);

    const closeButton = container.querySelector<HTMLButtonElement>('[aria-label="Close device"]');
    if (!closeButton) throw new Error("Expected the reacquired device panel close control.");
    await act(async () => {
      closeButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect([...owners.values()]).toEqual([]);
    expect(closeInputs).toEqual([
      expect.objectContaining({
        sessionId: "panel-controller",
        leaseId: "device-walk-1",
      }),
    ]);
  });

  it("floats the exact panel owner into an existing hidden same-device source", async () => {
    const unrelatedRef = scopeThreadRef(
      EnvironmentId.make("environment-2"),
      ThreadId.make("other-thread"),
    );
    const unrelatedSource = {
      kind: "device" as const,
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: runtimeDevice.id,
      platform: runtimeDevice.platform,
      name: runtimeDevice.name,
      sessionId: "other-environment-owner",
      leaseId: "other-environment-walk",
    };
    usePreviewMiniPlayerStore.getState().open(unrelatedRef, unrelatedSource);
    await startSelectedDevice();
    const externalObserver: DeviceSession = {
      sessionId: "other-client-observer",
      leaseId: "device-walk-1",
      requestId: "other-client-open",
      ownerKind: "panel",
      observer: true,
      threadId: threadRef.threadId,
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: runtimeDevice.id,
      platform: runtimeDevice.platform,
      openedAt: "2026-10-18T00:02:00.000Z",
    };
    await act(async () => {
      owners.set(externalObserver.sessionId, externalObserver);
      publish([...owners.values()]);
    });

    const existingSource = usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source;
    expect(existingSource).toMatchObject({
      kind: "device",
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: runtimeDevice.id,
    });
    expect(existingSource).not.toHaveProperty("sessionId");
    expect(existingSource).not.toHaveProperty("leaseId");
    expect(container.querySelector('[aria-label="Floating device preview"]')).toBeNull();
    if (!existingSource || existingSource.kind !== "device")
      throw new Error("Expected the hidden same-device mini-player source.");
    const sourceKey = previewMiniPlayerSourceKey(existingSource);
    await act(async () => {
      usePreviewMiniPlayerStore.getState().resize(threadRef, sourceKey, 480, { x: 36, y: 52 });
    });

    const floatButton = container.querySelector<HTMLButtonElement>('[aria-label="Float device"]');
    if (!floatButton) throw new Error("Expected the active device float control.");
    fake.streamReadOnlyValues.length = 0;
    await act(async () => floatButton.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]).toMatchObject({
      source: {
        kind: "device",
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: runtimeDevice.id,
        sessionId: "panel-controller",
        leaseId: "device-walk-1",
      },
      position: { x: 36, y: 52 },
      width: 480,
      lastInteraction: "resize",
    });
    expect(container.querySelector('[aria-label="Floating device preview"]')).not.toBeNull();
    expect(fake.streamReadOnlyValues.at(-1)).toBe(false);
    expect([...owners.values()]).toEqual([
      expect.objectContaining({ sessionId: "panel-controller", observer: false }),
      externalObserver,
    ]);
    expect(openInputs.filter((input) => input.sessionId === undefined)).toHaveLength(1);

    const closeButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Close floating preview"]',
    );
    if (!closeButton) throw new Error("Expected the floating preview close control.");
    await act(async () => {
      closeButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect([...owners.values()]).toEqual([externalObserver]);
    expect(
      usePreviewMiniPlayerStore.getState().byThreadKey[scopedThreadKey(unrelatedRef)]?.source,
    ).toEqual(unrelatedSource);
    expect(closeInputs).toEqual([
      expect.objectContaining({
        sessionId: "panel-controller",
        leaseId: "device-walk-1",
      }),
    ]);
  });

  it("floats and maximizes through the real mini-player and panel lifecycle", async () => {
    await startSelectedDevice();
    const floatButton = container.querySelector<HTMLButtonElement>('[aria-label="Float device"]');
    if (!floatButton) throw new Error("Expected the open device panel.");

    await act(async () => floatButton.click());
    expect(usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source).toMatchObject({
      kind: "device",
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: runtimeDevice.id,
      sessionId: "panel-controller",
      leaseId: "device-walk-1",
    });
    expect([...owners.values()]).toHaveLength(1);
    const maximizeButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open preview in right panel"]',
    );
    if (!maximizeButton) throw new Error("Expected the mini-player maximize control.");
    await act(async () => {
      maximizeButton.click();
      await Promise.resolve();
    });

    expect(hasCanonicalSurface()).toBe(true);
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.isOpen).toBe(true);
    expect(container.querySelector('[data-observer="false"]')).not.toBeNull();
    expect([...owners.values()]).toEqual([
      expect.objectContaining({ sessionId: "panel-controller", observer: false }),
    ]);
    expect(closeInputs).toEqual([]);
    expect(
      openInputs.every(
        (input) =>
          input.deviceId === selectedDevice.id ||
          (input.sessionId === "panel-controller" && input.leaseId === "device-walk-1"),
      ),
    ).toBe(true);
  });

  it("keeps a cancelled overlapping selection out of previews and releases its late owner", async () => {
    useRightPanelStore.getState().open(threadRef, "device");
    await act(async () =>
      root.render(
        <StrictMode>
          <PanelHost />
        </StrictMode>,
      ),
    );
    const start = container.querySelector<HTMLButtonElement>(
      '[aria-label="Start Signalbox Pixel"]',
    );
    if (!start) throw new Error("Expected the stopped Pixel row.");
    fake.delayNextManualSelection = true;
    await act(async () => start.click());
    const [cancelledRequestId, completeCancelledSelection] =
      [...fake.pendingManualSelections.entries()][0] ?? [];
    if (!cancelledRequestId || !completeCancelledSelection)
      throw new Error("Expected the first selection to remain in flight.");

    await act(async () => {
      root.render(
        <StrictMode>
          <PanelHost key="selection-remount" />
        </StrictMode>,
      );
      await Promise.resolve();
    });

    const replacementStart = container.querySelector<HTMLButtonElement>(
      '[aria-label="Start Signalbox Pixel"]',
    );
    if (!replacementStart) throw new Error("Expected the remounted device selector.");
    const canonicalSurface = waitForCanonicalSurface();
    await act(async () => {
      replacementStart.click();
      await canonicalSurface;
    });

    const manualInputs = openInputs.filter((input) => input.deviceId === selectedDevice.id);
    expect(manualInputs).toHaveLength(2);
    const activeRequestId = manualInputs.find(
      (input) => input.requestId !== cancelledRequestId,
    )?.requestId;
    if (!activeRequestId) throw new Error("Expected the second selection to become active.");
    expect(useRightPanelStore.getState().pendingDeviceOpensByThreadKey[threadKey]).toEqual([
      { requestId: cancelledRequestId, hostId: LOCAL_DEVICE_HOST_ID },
    ]);
    expect(
      fake.cancelOpen.mock.calls.some(
        ([request]) =>
          (request as { input?: { requestId?: string } }).input?.requestId === cancelledRequestId,
      ),
    ).toBe(true);

    await act(async () => {
      completeCancelledSelection();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect([...owners.values()]).toEqual([
      expect.objectContaining({ sessionId: "panel-controller", observer: false }),
    ]);
    expect(closeInputs).toEqual([
      expect.objectContaining({ sessionId: "cancelled-manual-observer", leaseId: "device-walk-1" }),
    ]);
    expect(usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]).toBeUndefined();
    expect(useRightPanelStore.getState().pendingDeviceOpensByThreadKey[threadKey]).toBeUndefined();
    expect(
      useRightPanelStore
        .getState()
        .byThreadKey[threadKey]?.surfaces.find(
          (surface) => surface.id === "device:local:emulator-5554",
        ),
    ).toMatchObject({
      target: { sessionId: "panel-controller", leaseId: "device-walk-1" },
    });
    expect(activeRequestId).not.toBe(cancelledRequestId);
  });
});
