import { describe, expect, it } from "@effect/vitest";

import { previewSyntheticSecretsEnabled } from "./previewSecrets.ts";

describe("previewSyntheticSecretsEnabled", () => {
  it("stays disabled without the explicit preview flag", () => {
    expect(
      previewSyntheticSecretsEnabled({
        DEPLOYMENT_STAGE: "pr-123",
        ENVIRONMENT_ID: "cloud-preview-123",
      }),
    ).toBe(false);
  });

  it("cannot be enabled in production", () => {
    expect(
      previewSyntheticSecretsEnabled({
        DEPLOYMENT_STAGE: "production",
        ENVIRONMENT_ID: "cloud-preview-123",
        PREVIEW_SYNTHETIC_SECRETS: "1",
      }),
    ).toBe(false);
  });

  it("requires the stage and environment identity to match", () => {
    expect(
      previewSyntheticSecretsEnabled({
        DEPLOYMENT_STAGE: "pr-123",
        ENVIRONMENT_ID: "cloud-preview-124",
        PREVIEW_SYNTHETIC_SECRETS: "1",
      }),
    ).toBe(false);
  });

  it("enables synthetic secrets for an explicitly opted-in matching preview", () => {
    expect(
      previewSyntheticSecretsEnabled({
        DEPLOYMENT_STAGE: "pr-123",
        ENVIRONMENT_ID: "cloud-preview-123",
        PREVIEW_SYNTHETIC_SECRETS: "1",
      }),
    ).toBe(true);
  });
});
