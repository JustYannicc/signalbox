import {
  EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  showsEnvironmentUi as showsEnvironmentUiFor,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./entities", () => ({
  useEnvironmentServerConfig: () => null,
  useServerConfigs: () => new Map(),
}));
vi.mock("./use-remote-environment-registry", async () => {
  const { Atom } = await import("effect/reactivity");
  return { savedConnectionsByIdAtom: Atom.make({}) };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()) };
});

import { anyEnvironmentSupports, savedEnvironmentCapabilities } from "./environmentCapabilities";

function config(capabilities: Partial<ExecutionEnvironmentCapabilities>) {
  return { environment: { capabilities: capabilities as ExecutionEnvironmentCapabilities } };
}

describe("anyEnvironmentSupports", () => {
  it("shows the control until an environment reports in", () => {
    expect(anyEnvironmentSupports([], "scheduledTasks")).toBe(true);
  });

  it("shows it while any environment can do it", () => {
    expect(
      anyEnvironmentSupports([config({ scheduledTasks: false }), config({})], "scheduledTasks"),
    ).toBe(true);
  });

  it("hides it when every environment turns it off", () => {
    expect(anyEnvironmentSupports([config({ scheduledTasks: false })], "scheduledTasks")).toBe(
      false,
    );
  });
});

describe("showsEnvironmentUi over saved environments", () => {
  const showsEnvironmentUi = (
    saved: Parameters<typeof savedEnvironmentCapabilities>[0],
    configs: Parameters<typeof savedEnvironmentCapabilities>[1],
  ) => showsEnvironmentUiFor(savedEnvironmentCapabilities(saved, configs));

  const cloud = {
    environmentId: EnvironmentId.make("cloud"),
    httpBaseUrl: "https://app.signalbox.run",
  };
  const box = { environmentId: EnvironmentId.make("box"), httpBaseUrl: "http://192.168.1.4:3773" };

  it("shows environments with nothing saved, so sign-in and dev pairing keep working", () => {
    expect(showsEnvironmentUi([], new Map())).toBe(true);
  });

  it("hides them when the only environment says there are no others", () => {
    expect(
      showsEnvironmentUi(
        [box],
        new Map([[box.environmentId, config({ otherEnvironments: false })]]),
      ),
    ).toBe(false);
  });

  it("keeps them for servers that don't say (T3 Code, self-hosted, dev)", () => {
    expect(showsEnvironmentUi([box], new Map([[box.environmentId, config({})]]))).toBe(true);
  });

  it("treats Signalbox Cloud as the one environment before it reports, e.g. while offline", () => {
    expect(showsEnvironmentUi([cloud], new Map())).toBe(false);
    expect(
      showsEnvironmentUi([{ ...cloud, httpBaseUrl: "https://app.signalbox.run/" }], new Map()),
    ).toBe(false);
  });

  it("keeps them while another saved environment hasn't reported", () => {
    expect(
      showsEnvironmentUi(
        [cloud, box],
        new Map([[cloud.environmentId, config({ otherEnvironments: false })]]),
      ),
    ).toBe(true);
  });

  it("keeps them when the cloud URL hosts a server that allows others", () => {
    expect(showsEnvironmentUi([cloud], new Map([[cloud.environmentId, config({})]]))).toBe(true);
  });
});
