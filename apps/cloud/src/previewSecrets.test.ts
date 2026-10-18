import { describe, expect, it } from "@effect/vitest";

import { previewSyntheticSecretsEnabled } from "./previewSecrets.ts";

describe("previewSyntheticSecretsEnabled", () => {
  it.each([
    { stage: "pr-123", legacy: "production", enabled: true },
    { stage: "production", legacy: "pr-123", enabled: false },
    { stage: "pr-124", legacy: "pr-123", enabled: false },
    { stage: undefined, legacy: "pr-123", enabled: false },
  ])(
    "uses only the canonical stage when the retained binding disagrees: $stage",
    ({ stage, legacy, enabled }) => {
      const env = {
        ...(stage === undefined ? {} : { SIGNALBOX_STAGE: stage }),
        DEPLOYMENT_STAGE: legacy,
        ENVIRONMENT_ID: "cloud-preview-123",
        PREVIEW_SYNTHETIC_SECRETS: "1",
      };
      expect(previewSyntheticSecretsEnabled(env)).toBe(enabled);
    },
  );

  it.each([undefined, "", "0", "true", "pr-123"])(
    "stays disabled without the exact preview flag: %s",
    (flag) => {
      expect(
        previewSyntheticSecretsEnabled({
          SIGNALBOX_STAGE: "pr-123",
          ENVIRONMENT_ID: "cloud-preview-123",
          ...(flag === undefined ? {} : { PREVIEW_SYNTHETIC_SECRETS: flag }),
        }),
      ).toBe(false);
    },
  );

  it.each([undefined, "", "pr-0", "pr-0123", "pr-123-extra", "development"])(
    "fails closed without a valid preview stage: %s",
    (stage) => {
      expect(
        previewSyntheticSecretsEnabled({
          ...(stage === undefined ? {} : { SIGNALBOX_STAGE: stage }),
          ENVIRONMENT_ID: "cloud-preview-123",
          PREVIEW_SYNTHETIC_SECRETS: "1",
        }),
      ).toBe(false);
    },
  );

  it("cannot be enabled in production", () => {
    expect(
      previewSyntheticSecretsEnabled({
        SIGNALBOX_STAGE: "production",
        ENVIRONMENT_ID: "cloud-preview-123",
        PREVIEW_SYNTHETIC_SECRETS: "1",
      }),
    ).toBe(false);
  });

  it.each([undefined, "", "cloud-preview-124", "production"])(
    "requires the stage and environment identity to match: %s",
    (environmentId) => {
      expect(
        previewSyntheticSecretsEnabled({
          SIGNALBOX_STAGE: "pr-123",
          ...(environmentId === undefined ? {} : { ENVIRONMENT_ID: environmentId }),
          PREVIEW_SYNTHETIC_SECRETS: "1",
        }),
      ).toBe(false);
    },
  );

  it("enables synthetic secrets for an explicitly opted-in matching preview", () => {
    expect(
      previewSyntheticSecretsEnabled({
        SIGNALBOX_STAGE: "pr-123",
        ENVIRONMENT_ID: "cloud-preview-123",
        PREVIEW_SYNTHETIC_SECRETS: "1",
      }),
    ).toBe(true);
  });
});
