import { BUNDLED_CLAUDE_MODEL_CATALOG } from "./provider/ClaudeModelCatalog.ts";
import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { compileClaudeModelSelection } from "@signalbox/provider-claude/claudeModelOptions";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection", () => {
  it("compiles context, effort, and settings together", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-4-6", [
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ]),
        BUNDLED_CLAUDE_MODEL_CATALOG,
      ),
    ).toMatchObject({
      apiModelId: "claude-opus-4-6[1m]",
      effort: "max",
      settings: { fastMode: true },
    });
  });

  it("compiles fast mode only for models that expose it", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-4-6", [{ id: "fastMode", value: true }]),
        BUNDLED_CLAUDE_MODEL_CATALOG,
      ).settings,
    ).toEqual({ fastMode: true });
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-4-6", [{ id: "fastMode", value: false }]),
        BUNDLED_CLAUDE_MODEL_CATALOG,
      ).settings,
    ).toEqual({ fastMode: false });
  });

  it("uses the model default SDK effort alongside prompt-injected effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "effort", value: "ultrathink" }]),
        BUNDLED_CLAUDE_MODEL_CATALOG,
      ),
    ).toMatchObject({ effort: "high", promptEffort: "ultrathink" });
  });

  it("keeps explicit effort for models missing from the local catalog", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-pool-model-not-in-catalog", [{ id: "effort", value: "max" }]),
        BUNDLED_CLAUDE_MODEL_CATALOG,
      ).effort,
    ).toBe("max");
    expect(
      compileClaudeModelSelection(
        selection("claude-pool-model-not-in-catalog", []),
        BUNDLED_CLAUDE_MODEL_CATALOG,
      ).effort,
    ).toBeUndefined();
  });

  it("omits unsupported effort for models missing from the local catalog", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-pool-model-not-in-catalog", [{ id: "effort", value: "brutal" }]),
        BUNDLED_CLAUDE_MODEL_CATALOG,
      ).effort,
    ).toBeUndefined();
  });

  it("compiles the thinking toggle for models that expose it", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-haiku-4-5", [{ id: "thinking", value: false }]),
        BUNDLED_CLAUDE_MODEL_CATALOG,
      ).settings,
    ).toEqual({ alwaysThinkingEnabled: false });
  });
});
