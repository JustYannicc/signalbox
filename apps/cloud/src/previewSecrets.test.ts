import { describe, expect, it } from "@effect/vitest";

import { previewSyntheticSecretsEnabled } from "./previewSecrets.ts";

describe("previewSyntheticSecretsEnabled", () => {
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
