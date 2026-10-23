import { describe, expect, it } from "vite-plus/test";
import { CLAUDE_MEMORY_ENV } from "@t3tools/contracts/harnessMemorySettings";
import { claudeHostEnvironment } from "../ClaudeHostConfig.ts";

describe("Claude host memory defaults", () => {
  it("pins absent values without replacing the SDK's explicit environment", () => {
    const input = { BASH_MAX_OUTPUT_LENGTH: "12000", CALLER_VALUE: "kept" };
    expect(claudeHostEnvironment(input)).toEqual({
      ...CLAUDE_MEMORY_ENV,
      BASH_MAX_OUTPUT_LENGTH: "12000",
      CALLER_VALUE: "kept",
    });
    expect(input).toEqual({ BASH_MAX_OUTPUT_LENGTH: "12000", CALLER_VALUE: "kept" });
  });

  it("retains an explicit unset env value for the package's own fallback", () => {
    expect(claudeHostEnvironment({ BASH_MAX_OUTPUT_LENGTH: undefined })).toEqual({
      ...CLAUDE_MEMORY_ENV,
      BASH_MAX_OUTPUT_LENGTH: undefined,
    });
  });
});
