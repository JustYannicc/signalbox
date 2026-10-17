import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { settingsFromEnv } from "../thread/testing.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("PostHog EU migration gate", () => {
  it.each([undefined, "", "false"])(
    "credentials cannot enable sends with switch %s",
    async (enabled) => {
      vi.stubEnv("SENTRY_DSN", "");
      vi.stubEnv("POSTHOG_API_KEY", "phc_test");
      vi.stubEnv("POSTHOG_HOST", "https://eu.i.posthog.com");
      vi.stubEnv("SIGNALBOX_POSTHOG_ENABLED", enabled);
      const { default: config } = await import("../../evlog.config.ts");
      expect(config.drain).toBeUndefined();
      expect(
        settingsFromEnv({
          SIGNALBOX_POSTHOG_ENABLED: enabled,
          SIGNALBOX_POSTHOG_KEY: "phc_test",
          SIGNALBOX_POSTHOG_HOST: "https://eu.i.posthog.com",
        }),
      ).toBeNull();
    },
  );

  it("enables both senders explicitly after migration and respects the telemetry opt-out", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("POSTHOG_API_KEY", "phc_test");
    vi.stubEnv("POSTHOG_HOST", "https://eu.i.posthog.com");
    vi.stubEnv("SIGNALBOX_POSTHOG_ENABLED", "true");
    vi.stubEnv("T3CODE_TELEMETRY_ENABLED", "true");
    const env = {
      SIGNALBOX_POSTHOG_ENABLED: "true",
      SIGNALBOX_POSTHOG_KEY: "phc_test",
      SIGNALBOX_POSTHOG_HOST: "https://eu.i.posthog.com",
    };
    expect((await import("../../evlog.config.ts")).default.drain).toBeTypeOf("function");
    expect(settingsFromEnv(env)).toEqual({ key: "phc_test", host: "https://eu.i.posthog.com" });
    expect(settingsFromEnv({ ...env, SIGNALBOX_POSTHOG_HOST: "" })).toBeNull();
    vi.stubEnv("T3CODE_TELEMETRY_ENABLED", "false");
    vi.resetModules();
    expect((await import("../../evlog.config.ts")).default.drain).toBeUndefined();
    expect(settingsFromEnv({ ...env, T3CODE_TELEMETRY_ENABLED: "false" })).toBeNull();
  });
});
