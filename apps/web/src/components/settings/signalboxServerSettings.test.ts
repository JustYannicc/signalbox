import { describe, expect, it } from "vite-plus/test";

import { acceptsServerSettings, serverSettingsWritable } from "./signalboxServerSettings";

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
