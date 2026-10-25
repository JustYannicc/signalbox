import { describe, expect, it } from "@effect/vitest";

import { trustedEnvironment } from "./testEnvironment.ts";

describe("trustedEnvironment", () => {
  it.each([
    ["production stage", "production", "cloud-prod", undefined, undefined],
    [
      "preview stage with a different environment",
      "pr-921",
      "cloud-preview-922",
      undefined,
      undefined,
    ],
    ["dev without the local workerd flag", "dev", "cloud-dev", undefined, undefined],
    ["dev with the wrong local workerd flag", "dev", "cloud-dev", "0", undefined],
    ["dev with another environment", "dev", "cloud-preview-1", "1", undefined],
    ["zero preview number", "pr-0", "cloud-preview-0", undefined, undefined],
    ["leading zero preview number", "pr-0921", "cloud-preview-921", undefined, undefined],
    ["matching preview", "pr-921", "cloud-preview-921", undefined, "cloud-preview-921"],
    ["local dev", "dev", "cloud-dev", "1", "cloud-dev"],
  ] as const)("checks %s", (_name, stage, environmentId, localWorkerd, expected) => {
    expect(trustedEnvironment(stage, environmentId, localWorkerd)).toBe(expected);
  });
});
