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

import { useClosedViewStore } from "../../closedViewStore";
import { usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import { useRightPanelStore } from "../../rightPanelStore";
import type { ThreadPreviewState } from "../../previewStateStore";
import { DevicePanel } from "./DevicePanel";
import { useAgentOpenedPreviews } from "../preview/useAgentOpenedPreviews";

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
          cause: { _tag: "DeviceOperationError", reason: "stale_session" },
        };
      }
      exactAdoptionCalls++;
      if (exactAdoptionCalls === 1) {
        return new Promise((resolve) => {
          fake.resolveLateAdoption = () => resolve(success(existing));
        });
      }
      return success(existing);
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
    (state) =>
      state.byThreadKey[threadKey] ?? {
        isOpen: false,
        activeSurfaceId: null,
        surfaces: [],
      },
  );
  const panelSurfaces = panelState.surfaces;
  const miniPlayerSource = usePreviewMiniPlayerStore(
    (state) => state.byThreadKey[threadKey]?.source ?? null,
  );
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
  return surface?.kind === "device" ? (
    <DevicePanel
      key={surface.id}
      mode="embedded"
      threadRef={threadRef}
      surface={surface}
      visible={panelState.isOpen}
      onDismissSetup={() => undefined}
    />
  ) : null;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  setupLeaseService();
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({
    byThreadKey: {},
    pendingDeviceOpenByThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
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

  it("floats and reopens the same exact controller", async () => {
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

    await act(async () => {
      useRightPanelStore.getState().openDevice(threadRef, {
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: runtimeDevice.id,
        platform: "android",
        name: runtimeDevice.name,
        sessionId: "panel-controller",
        leaseId: "device-walk-1",
      });
    });
    expect(hasCanonicalSurface()).toBe(true);
    expect([...owners.values()]).toEqual([
      expect.objectContaining({ sessionId: "panel-controller", observer: false }),
    ]);
    expect(
      openInputs.every(
        (input) =>
          input.deviceId === selectedDevice.id ||
          (input.sessionId === "panel-controller" && input.leaseId === "device-walk-1"),
      ),
    ).toBe(true);
  });
});
