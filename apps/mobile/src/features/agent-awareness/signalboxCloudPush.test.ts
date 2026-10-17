import { EnvironmentId } from "@t3tools/contracts";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  getSignalboxCloudPushStatus,
  registerWithSignalboxClouds,
  resetSignalboxCloudPushStatus,
} from "./signalboxCloudPush";

const state = vi.hoisted(() => ({
  connections: {} as Record<string, { bearerToken: string; httpBaseUrl: string }>,
  configs: new Map<string, { environment: { capabilities: { signalboxCloud?: boolean } } }>(),
}));

vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
const configAtom = vi.hoisted(() => ({}));
const connectionsAtom = vi.hoisted(() => ({}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: configAtom }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  savedConnectionsByIdAtom: connectionsAtom,
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => (atom === configAtom ? state.configs : state.connections),
  },
}));
vi.mock("@t3tools/client-runtime/state/signalboxPush", () => ({
  createSignalboxPushAtoms: () => ({ registerDevice: {} }),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: vi.fn() }));

const request: RelayDeviceRegistrationRequest = {
  deviceId: "phone",
  platform: "ios",
  iosMajorVersion: 26,
  label: "Phone",
  pushToken: "apns-token",
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnFailure: true,
    notifyOnCompletion: true,
  },
};

describe("cloud push registration", () => {
  beforeEach(() => {
    state.configs.clear();
    state.connections = {};
    resetSignalboxCloudPushStatus();
    vi.mocked(runAtomCommand).mockReset();
    vi.mocked(runAtomCommand).mockResolvedValue(AsyncResult.success(undefined));
  });

  it("leaves self-hosted registration to Connect", async () => {
    state.configs.set("self-hosted", { environment: { capabilities: {} } });
    await registerWithSignalboxClouds(request);
    expect(getSignalboxCloudPushStatus()).toBe("unknown");
    expect(runAtomCommand).not.toHaveBeenCalled();
  });

  it("waits for cloud acceptance before reporting that the phone is registered", async () => {
    state.configs.set("cloud", { environment: { capabilities: { signalboxCloud: true } } });
    let accept = () => {};
    vi.mocked(runAtomCommand).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = () => resolve(AsyncResult.success(undefined));
        }),
    );
    let confirmed = false;
    const registration = registerWithSignalboxClouds(request).then((result) => {
      confirmed = true;
      return result;
    });
    await Promise.resolve();
    expect(confirmed).toBe(false);
    expect(getSignalboxCloudPushStatus()).toBe("pending");
    accept();
    await registration;
    expect(getSignalboxCloudPushStatus()).toBe("registered");
    expect(runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { environmentId: EnvironmentId.make("cloud"), input: request },
      { reportFailure: false },
    );
  });

  it("does not confirm partial registration and still attempts the other clouds", async () => {
    state.configs.set("one", { environment: { capabilities: { signalboxCloud: true } } });
    state.configs.set("two", { environment: { capabilities: { signalboxCloud: true } } });
    vi.mocked(runAtomCommand).mockResolvedValueOnce(AsyncResult.fail("not connected"));
    await registerWithSignalboxClouds(request);
    expect(getSignalboxCloudPushStatus()).toBe("failed");
    expect(runAtomCommand).toHaveBeenCalledTimes(2);
  });
  it("does not reuse a registration after the cloud account changes", async () => {
    state.configs.set("cloud", { environment: { capabilities: { signalboxCloud: true } } });
    state.connections = {
      cloud: { bearerToken: "first-session", httpBaseUrl: "https://cloud.test" },
    };
    await registerWithSignalboxClouds(request);
    expect(getSignalboxCloudPushStatus()).toBe("registered");
    state.connections = {
      cloud: { bearerToken: "second-session", httpBaseUrl: "https://cloud.test" },
    };
    expect(getSignalboxCloudPushStatus()).toBe("unknown");
    await registerWithSignalboxClouds(request);
    expect(getSignalboxCloudPushStatus()).toBe("registered");
    expect(runAtomCommand).toHaveBeenCalledTimes(2);
  });

  it("confirms removal rather than claiming notifications are enabled without a token", async () => {
    state.configs.set("cloud", { environment: { capabilities: { signalboxCloud: true } } });
    const { pushToken: _, ...withoutToken } = request;
    await registerWithSignalboxClouds(withoutToken);
    expect(getSignalboxCloudPushStatus()).toBe("disabled");
  });

  it("discards an old acceptance after a newer token registration fails", async () => {
    state.configs.set("cloud", { environment: { capabilities: { signalboxCloud: true } } });
    let accept = () => {};
    vi.mocked(runAtomCommand).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = () => resolve(AsyncResult.success(undefined));
        }),
    );
    const old = registerWithSignalboxClouds(request);
    vi.mocked(runAtomCommand).mockResolvedValueOnce(AsyncResult.fail("offline"));
    await registerWithSignalboxClouds({ ...request, pushToken: "rotated-token" });
    accept();
    await old;
    expect(getSignalboxCloudPushStatus()).toBe("failed");
  });
});
