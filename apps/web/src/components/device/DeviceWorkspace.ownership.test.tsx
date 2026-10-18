// @vitest-environment jsdom

import { EnvironmentId, LOCAL_DEVICE_HOST_ID, type DeviceSummary } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const controls = vi.hoisted(() => ({
  act: vi.fn(async () => undefined),
  toolsAct: undefined as undefined | ((input: unknown) => Promise<unknown>),
  railOnTools: undefined as undefined | (() => void),
}));

vi.mock("~/state/device", () => ({
  refreshDeviceHubAccess: vi.fn(),
  useDeviceHubAccess: () => ({ token: "device-access" }),
}));
vi.mock("./useDeviceControls", () => ({
  useDeviceControls: () => ({
    detail: { settings: {}, foregroundApp: null },
    pending: false,
    error: null,
    foregroundApp: null,
    disabled: false,
    act: controls.act,
  }),
}));
vi.mock("./DeviceStreamView", async () => {
  const React = await import("react");
  return {
    DeviceStreamView: (props: { renderControls?: (view: unknown) => React.ReactNode }) =>
      React.createElement("div", null, props.renderControls?.({})),
  };
});
vi.mock("./DeviceControlsRail", async () => {
  const React = await import("react");
  return {
    DeviceControlsRail: (props: { onTools: () => void }) => {
      controls.railOnTools = props.onTools;
      return React.createElement(
        "button",
        { type: "button", "aria-label": "Open tools", onClick: props.onTools },
        "Tools",
      );
    },
  };
});
vi.mock("./DeviceToolsPanel", async () => {
  const React = await import("react");
  return {
    DeviceToolsPanel: (props: { controls: { act: (input: unknown) => Promise<unknown> } }) => {
      controls.toolsAct = props.controls.act;
      return React.createElement(
        "button",
        {
          type: "button",
          "aria-label": "Launch app",
          onClick: () => void props.controls.act({ type: "launchApp", appId: "com.example.app" }),
        },
        "Launch",
      );
    },
  };
});

import { DeviceWorkspace } from "./DeviceWorkspace";

const device: DeviceSummary = {
  hostId: LOCAL_DEVICE_HOST_ID,
  id: "emulator-5554" as DeviceSummary["id"],
  platform: "android",
  name: "Pixel API 35",
  version: "Android 15",
  booted: true,
  physical: false,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  controls.act.mockClear();
  controls.toolsAct = undefined;
  controls.railOnTools = undefined;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("DeviceWorkspace ownership", () => {
  it("closes Tools on takeover and rejects callbacks retained from the owner view", async () => {
    const props = {
      environmentId: EnvironmentId.make("environment-1"),
      device,
      hostLabel: "Local",
      hostDiagnostics: undefined,
      visible: true,
      observer: false,
      onFloat: vi.fn(),
      onClose: vi.fn(),
      onPowerOff: vi.fn(),
    };

    await act(async () => root.render(<DeviceWorkspace {...props} />));
    const openTools = container.querySelector<HTMLButtonElement>('[aria-label="Open tools"]');
    if (!openTools) throw new Error("Expected the owner controls rail.");
    await act(async () => openTools.click());
    const launch = container.querySelector<HTMLButtonElement>('[aria-label="Launch app"]');
    if (!launch || !controls.toolsAct || !controls.railOnTools)
      throw new Error("Expected the Tools drawer and its actions.");
    const staleLaunch = controls.toolsAct;
    const staleOpenTools = controls.railOnTools;

    await act(async () => root.render(<DeviceWorkspace {...props} observer />));
    expect(container.querySelector('[aria-label="Launch app"]')).toBeNull();
    await act(async () => {
      await staleLaunch({ type: "launchApp", appId: "com.example.app" });
      staleOpenTools();
    });
    expect(controls.act).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Launch app"]')).toBeNull();
  });
});
