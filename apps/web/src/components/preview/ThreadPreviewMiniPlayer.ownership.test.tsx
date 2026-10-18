// @vitest-environment jsdom

import {
  DeviceId,
  EnvironmentId,
  LOCAL_DEVICE_HOST_ID,
  ThreadId,
  type DeviceOpenInput,
  type DeviceServiceState,
  type DeviceSession,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  snapshot: null as unknown,
  open: vi.fn(),
  cancelOpen: vi.fn(),
  close: vi.fn(),
}));

vi.mock("~/state/device", () => ({
  deviceEnvironment: {
    open: "device-open",
    cancelOpen: "device-cancel",
    close: "device-close",
  },
  useDeviceState: () => ({ state: fake.snapshot, loaded: true }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    ({
      "device-open": fake.open,
      "device-cancel": fake.cancelOpen,
      "device-close": fake.close,
    })[command],
}));
vi.mock("../chat/ChatCanvasContext", () => ({
  useChatCanvas: () => ({
    container: document.body,
    previewKey: "device:local:emulator-5554",
    layout: { frame: { x: 0, y: 0, width: 240, height: 420 } },
  }),
}));
vi.mock("../device/DeviceStreamView", () => ({ DeviceStreamView: () => null }));
vi.mock("~/components/ui/button", async () => {
  const React = await import("react");
  return {
    Button: (props: {
      readonly children?: ReactNode;
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
    Tooltip: (props: { readonly children?: ReactNode }) =>
      React.createElement(React.Fragment, null, props.children),
    TooltipTrigger: (props: { readonly render?: ReactNode; readonly children?: ReactNode }) =>
      props.render ?? props.children,
    TooltipPopup: () => null,
  };
});

import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import { useRightPanelStore, selectThreadRightPanelState } from "../../rightPanelStore";
import { ThreadPreviewMiniPlayer } from "./ThreadPreviewMiniPlayer";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
const threadKey = scopedThreadKey(threadRef);
const device = {
  hostId: LOCAL_DEVICE_HOST_ID,
  id: DeviceId.make("emulator-5554"),
  platform: "android",
  name: "Signalbox Pixel",
  version: "Android 15",
  booted: true,
  physical: false,
} as const;
const owner: DeviceSession = {
  sessionId: "panel-controller",
  leaseId: "device-walk-1",
  ownerKind: "panel",
  observer: false,
  threadId: threadRef.threadId,
  hostId: LOCAL_DEVICE_HOST_ID,
  deviceId: device.id,
  platform: "android",
  openedAt: "2026-10-18T00:00:00.000Z",
};
const source = {
  kind: "device" as const,
  hostId: LOCAL_DEVICE_HOST_ID,
  deviceId: device.id,
  platform: "android" as const,
  name: device.name,
  sessionId: owner.sessionId,
  leaseId: owner.leaseId,
};
const replacementOwner: DeviceSession = {
  ...owner,
  sessionId: "panel-controller-replacement",
  leaseId: "device-walk-2",
  openedAt: "2026-10-18T00:01:00.000Z",
};
const deviceState: DeviceServiceState = {
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
  devices: [device],
  sessions: [owner],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "",
  revision: 1,
};

function MiniPlayerHost() {
  const miniPlayer = usePreviewMiniPlayerStore((state) => state.byThreadKey[threadKey] ?? null);
  return miniPlayer ? (
    <ThreadPreviewMiniPlayer threadRef={threadRef} miniPlayer={miniPlayer} />
  ) : null;
}

let root: Root;
let container: HTMLDivElement;
let rootMounted = true;
const lateOpenResolvers: Array<(result: { _tag: "Success"; value: DeviceSession }) => void> = [];
const openInputs: DeviceOpenInput[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  rootMounted = true;
  lateOpenResolvers.length = 0;
  openInputs.length = 0;
  fake.snapshot = deviceState;
  fake.open.mockReset().mockImplementation((request: unknown) => {
    openInputs.push((request as { input: DeviceOpenInput }).input);
    return new Promise<{ _tag: "Success"; value: DeviceSession }>((resolve) =>
      lateOpenResolvers.push(resolve),
    );
  });
  fake.cancelOpen.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  fake.close.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
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
  if (rootMounted) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ThreadPreviewMiniPlayer device ownership", () => {
  it("maximizes an unverified source lease without dropping its exact identity", async () => {
    useRightPanelStore.getState().openDevice(threadRef, {
      hostId: source.hostId,
      deviceId: source.deviceId,
      platform: source.platform,
      name: source.name,
    });
    usePreviewMiniPlayerStore.getState().open(threadRef, source);
    if (!selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, threadRef))
      throw new Error("Expected the device mini-player.");

    await act(async () =>
      root.render(
        <StrictMode>
          <MiniPlayerHost />
        </StrictMode>,
      ),
    );
    expect(openInputs.length).toBeGreaterThan(0);
    expect(
      openInputs.every(
        (input) => input.sessionId === owner.sessionId && input.leaseId === owner.leaseId,
      ),
    ).toBe(true);

    const maximize = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open preview in right panel"]',
    );
    if (!maximize) throw new Error("Expected the maximize control.");
    await act(async () => maximize.click());

    const surface = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    ).surfaces.find((entry) => entry.id === "device:local:emulator-5554");
    expect(surface).toMatchObject({
      target: {
        sessionId: owner.sessionId,
        leaseId: owner.leaseId,
      },
    });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, threadRef),
    ).toBeNull();

    await act(async () => root.unmount());
    rootMounted = false;
    await act(async () => {
      for (const resolve of lateOpenResolvers) resolve({ _tag: "Success", value: owner });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("stores a reacquired owner before the mini-player remounts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fake.snapshot = { ...deviceState, sessions: [replacementOwner] };
    const owners = new Map([[replacementOwner.sessionId, replacementOwner]]);
    fake.open.mockReset().mockImplementation((request: unknown) => {
      const input = (request as { input: DeviceOpenInput }).input;
      openInputs.push(input);
      if (input.sessionId === owner.sessionId && input.leaseId === owner.leaseId)
        return Promise.resolve({
          _tag: "Failure" as const,
          cause: { _tag: "DeviceOperationError", reason: "stale_session" },
        });
      owners.set(replacementOwner.sessionId, replacementOwner);
      return Promise.resolve({ _tag: "Success" as const, value: replacementOwner });
    });
    fake.close.mockReset().mockImplementation((request: unknown) => {
      const input = (request as { input: { sessionId?: string; leaseId?: string } }).input;
      const current = owners.get(input.sessionId ?? "");
      if (current?.leaseId === input.leaseId) owners.delete(current.sessionId);
      return Promise.resolve({ _tag: "Success" as const, value: undefined });
    });
    usePreviewMiniPlayerStore.getState().open(threadRef, source);

    await act(async () =>
      root.render(
        <StrictMode>
          <MiniPlayerHost />
        </StrictMode>,
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source).toMatchObject({
      sessionId: replacementOwner.sessionId,
      leaseId: replacementOwner.leaseId,
    });
    expect([...owners.values()]).toEqual([replacementOwner]);
    expect(openInputs.some((input) => input.sessionId === undefined)).toBe(true);

    await act(async () => {
      root.unmount();
      rootMounted = false;
      root = createRoot(container);
      rootMounted = true;
      root.render(
        <StrictMode>
          <MiniPlayerHost />
        </StrictMode>,
      );
      await Promise.resolve();
    });

    expect([...owners.values()]).toEqual([replacementOwner]);
    expect(fake.close).not.toHaveBeenCalled();
    expect(
      openInputs
        .filter((input) => input.deviceId === device.id)
        .every(
          (input) =>
            input.sessionId === owner.sessionId ||
            (input.sessionId === replacementOwner.sessionId &&
              input.leaseId === replacementOwner.leaseId) ||
            input.sessionId === undefined,
        ),
    ).toBe(true);
  });
});
