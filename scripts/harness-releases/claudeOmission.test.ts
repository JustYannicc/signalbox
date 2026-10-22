import { describe, expect, it } from "vite-plus/test";
import { readClaudeOmission } from "./claudeOmission.ts";

describe("Claude release omission configuration", () => {
  it("returns the product configuration without settings", async () => {
    const omission = await readClaudeOmission({ enabled: true });
    expect(omission?.configuration).toEqual({ name: "product", env: {} });
  });

  it("keeps qualification as the selected configuration name", async () => {
    const omission = await readClaudeOmission({
      enabled: true,
      configurationName: "qualification",
    });
    expect(omission?.configuration.name).toBe("qualification");
    expect(omission?.configuration).not.toHaveProperty("settings");
    expect(omission?.configuration.env).toMatchObject({
      ANTHROPIC_API_KEY: "mock-only-dummy-key",
      ANTHROPIC_BASE_URL: "http://mock.anthropic.invalid",
    });
  });

  it("rejects unknown configuration names", async () => {
    await expect(
      readClaudeOmission({ enabled: true, configurationName: "unknown" }),
    ).rejects.toThrow("CLAUDE_HOST_CONFIGURATION_INVALID");
  });

  it("requires omission to be enabled before selecting a configuration", async () => {
    await expect(
      readClaudeOmission({ enabled: false, configurationName: "qualification" }),
    ).rejects.toThrow("CLAUDE_OMISSION_NOT_ENABLED");
  });

  it("rejects a coverage corpus when omission is disabled", async () => {
    await expect(
      readClaudeOmission({ enabled: false, corpusPath: "/fixture-not-read.json" }),
    ).rejects.toThrow("CLAUDE_OMISSION_NOT_ENABLED");
  });
});
