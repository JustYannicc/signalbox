import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";

import { machineSettings } from "./machineBackends.ts";

const boatEnv = {
  MACHINE_BACKEND: "boat",
  CLOUD_URL: "https://cloud.test",
  MODEL_GATEWAY_URL: "https://gateway.test",
};

describe("Boat machine settings", () => {
  it.each([
    { BOAT_RUNNER_API_KEY: " runner-key ", BOAT_API_KEY: "legacy-key", expected: "runner-key" },
    { BOAT_RUNNER_API_KEY: "runner-key", expected: "runner-key" },
    { BOAT_API_KEY: " legacy-key ", expected: "legacy-key" },
    { BOAT_RUNNER_API_KEY: "  ", BOAT_API_KEY: "legacy-key", expected: "legacy-key" },
  ])("uses the runner key with the legacy key as fallback: $expected", ({ expected, ...keys }) => {
    const settings = machineSettings({ ...boatEnv, ...keys });
    if (settings?.kind !== "boat") throw new Error("Boat settings were not configured.");
    expect(Redacted.value(settings.apiKey)).toBe(expected);
  });

  it("trims snapshot and environment names and preserves legacy defaults", () => {
    const legacy = machineSettings({ ...boatEnv, BOAT_API_KEY: "legacy-key" });
    expect(legacy).toMatchObject({
      kind: "boat",
      apiUrl: "https://boat.dev/api/v1",
      machineType: "small",
      ttlSeconds: 7200,
    });
    expect(legacy).not.toHaveProperty("snapshot");
    expect(legacy).not.toHaveProperty("environment");

    const prepared = machineSettings({
      ...boatEnv,
      BOAT_RUNNER_API_KEY: "runner-key",
      BOAT_RUNNER_SNAPSHOT: " signalbox-runner-v1 ",
      BOAT_RUNNER_ENVIRONMENT: " signalbox-runner ",
    });
    expect(prepared).toMatchObject({
      snapshot: "signalbox-runner-v1",
      environment: "signalbox-runner",
    });
    const blank = machineSettings({
      ...boatEnv,
      BOAT_API_KEY: "legacy-key",
      BOAT_RUNNER_SNAPSHOT: " ",
      BOAT_RUNNER_ENVIRONMENT: " ",
    });
    expect(blank).not.toHaveProperty("snapshot");
    expect(blank).not.toHaveProperty("environment");
  });

  it("requires a usable API key, cloud origin and model gateway", () => {
    expect(machineSettings(boatEnv)).toBeNull();
    expect(machineSettings({ ...boatEnv, BOAT_RUNNER_API_KEY: " " })).toBeNull();
    expect(machineSettings({ ...boatEnv, BOAT_RUNNER_API_KEY: "key", CLOUD_URL: " " })).toBeNull();
    expect(
      machineSettings({ ...boatEnv, BOAT_RUNNER_API_KEY: "key", MODEL_GATEWAY_URL: " " }),
    ).toBeNull();
  });
});
