import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DeviceId,
  EnvironmentId,
  LOCAL_DEVICE_HOST_ID,
  ProviderSessionId,
  ThreadId,
  type DeviceServiceState,
  type DeviceSession,
} from "@t3tools/contracts";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { browserAutoShowFloatingPreview: boolean }) => unknown) =>
    select({ browserAutoShowFloatingPreview: true }),
}));

import { usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { useAgentOpenedPreviews } from "./useAgentOpenedPreviews";
import type { ThreadPreviewState } from "../../previewStateStore";

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
const baseState: DeviceServiceState = {
  hosts: [
    {
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "Local",
      platforms: [
        { platform: "android", available: true },
        { platform: "ios", available: true },
      ],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: { local: { status: "ready" } },
  devices: [device],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "",
  revision: 1,
};
const previewState = { listLoaded: false, sessions: {} } as ThreadPreviewState;

function Probe({ deviceState }: { readonly deviceState: DeviceServiceState }) {
  const panelSurfaces = useRightPanelStore((state) => state.byThreadKey[threadKey]?.surfaces ?? []);
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
  return null;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
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

async function render(deviceState: DeviceServiceState) {
  await act(async () =>
    root.render(
      <StrictMode>
        <Probe deviceState={deviceState} />
      </StrictMode>,
    ),
  );
}

describe("useAgentOpenedPreviews device ownership", () => {
  it("still floats a genuinely agent-owned device for read-only observation", async () => {
    await render(baseState);
    const agentSession: DeviceSession = {
      sessionId: "agent-owner",
      leaseId: "walk-2",
      ownerKind: "agent",
      providerSessionId: ProviderSessionId.make("provider-session-1"),
      threadId: threadRef.threadId,
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: device.id,
      platform: "android",
      openedAt: "2026-10-18T00:00:00.000Z",
    };
    await render({ ...baseState, sessions: [agentSession] });

    expect(usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source).toEqual({
      kind: "device",
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: device.id,
      platform: "android",
      name: device.name,
    });
  });
});
