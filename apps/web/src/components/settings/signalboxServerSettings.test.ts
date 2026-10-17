import { describe, expect, it } from "vite-plus/test";

import {
  acceptsServerSettings,
  acceptsServerSettingsPatch,
  serverSettingsWritable,
} from "./signalboxServerSettings";

const target = (serverSettingsWrite?: boolean) => ({
  serverConfig: {
    environment: {
      capabilities: serverSettingsWrite === undefined ? {} : { serverSettingsWrite },
    },
  },
});

describe("environments that don't save server settings", () => {
  const laptop = target();
  const cloud = target(false);
  const loading = { serverConfig: null };

  it("only an environment that says so is skipped", () => {
    expect(acceptsServerSettings(laptop)).toBe(true);
    expect(acceptsServerSettings(target(true))).toBe(true);
    expect(acceptsServerSettings(cloud)).toBe(false);
    expect(acceptsServerSettings(loading)).toBe(true);
  });

  it("hides server rows only when no selected environment saves them", () => {
    expect(serverSettingsWritable([laptop, cloud])).toBe(true);
    expect(serverSettingsWritable([cloud])).toBe(false);
    // Unknown until configs load or something connects.
    expect(serverSettingsWritable([loading])).toBe(true);
    expect(serverSettingsWritable([])).toBe(true);
  });
});

describe("model settings capability", () => {
  const modelOnlyCloud = {
    serverConfig: {
      environment: {
        capabilities: { serverSettingsWrite: false, modelSettingsWrite: true },
      },
    },
  };

  it("allows model patches without making unrelated server settings writable", () => {
    expect(acceptsServerSettingsPatch(modelOnlyCloud, ["defaultModelSelection"])).toBe(true);
    expect(
      acceptsServerSettingsPatch(modelOnlyCloud, ["setModelFavorites", "setModelsHidden"]),
    ).toBe(true);
    expect(acceptsServerSettingsPatch(modelOnlyCloud, ["providerInstances"])).toBe(false);
    expect(
      acceptsServerSettingsPatch(modelOnlyCloud, ["defaultModelSelection", "defaultRuntimeMode"]),
    ).toBe(false);
  });
});
