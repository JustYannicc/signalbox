export interface PostHogEnv {
  readonly SIGNALBOX_POSTHOG_ENABLED?: string;
  readonly T3CODE_TELEMETRY_ENABLED?: string;
}

/** Keep every cloud PostHog sender off until the EU migration (#358) lands. */
export const postHogEnabled = (env: PostHogEnv) =>
  env.SIGNALBOX_POSTHOG_ENABLED?.trim().toLowerCase() === "true" &&
  !["false", "no", "off", "0", "n"].includes(
    env.T3CODE_TELEMETRY_ENABLED?.trim().toLowerCase() ?? "",
  );
