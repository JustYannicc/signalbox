import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { createClaudeToolObservation } from "../ClaudeToolObservation.ts";
import { loadHarnessRelease } from "../HarnessReleaseLoader.ts";
import {
  claudeProductHooksConfigured,
  selectProductClaudeRelease,
  type ProductClaudeHookSignals,
} from "../ProductClaudeReleaseSelection.ts";
import { productLoadedPreparedRelease } from "../ProductHarnessProcessRelease.ts";
import { claudeFixture } from "../releaseLoader/tests/artifactFixtures.ts";
import {
  claudeReleaseArtifact,
  claudeReleaseVariantsForArtifact,
} from "./productHost/releaseVariants.fixture.ts";

async function selection(hookSignals: ProductClaudeHookSignals) {
  const release = await claudeFixture();
  const baseline = claudeReleaseArtifact(release.options.identity, "baseline");
  const releaseVariants = claudeReleaseVariantsForArtifact(baseline);
  return {
    release,
    releaseVariants,
    selected: selectProductClaudeRelease({
      release: release.options,
      releaseVariants,
      hookSignals,
    }),
  };
}

it("selects the hooks artifact when SDK callbacks are installed", async () => {
  const observation = createClaudeToolObservation(() => undefined);
  const hookSignals = { sdkCallbacks: observation };
  expect(claudeProductHooksConfigured(hookSignals)).toBe(true);
  const result = await selection(hookSignals);
  expect(result.selected.artifact.releaseId).toBe("baseline-hooks");
  expect(result.selected.release.identity.artifactHash).toBe("0".repeat(64));
});

it("selects the hooks artifact when settings register a Claude hook", async () => {
  const settingsHooks = [{ id: "before-command", event: "pre-tool-use" as const }];
  const hookSignals = { settingsHooks };
  expect(claudeProductHooksConfigured(hookSignals)).toBe(true);
  const result = await selection(hookSignals);
  expect(result.selected.artifact.releaseId).toBe("baseline-hooks");
});

it("selects baseline for a session with no hook registrations", async () => {
  expect(claudeProductHooksConfigured({})).toBe(false);
  const result = await selection({});
  expect(result.selected.artifact.releaseId).toBe("baseline");
  expect(result.selected.release.identity).toEqual(result.release.options.identity);
});

it("fails closed when either catalog entry or its ledger record is missing", async () => {
  const release = await claudeFixture();
  const baseline = claudeReleaseArtifact(release.options.identity, "baseline");
  const releaseVariants = claudeReleaseVariantsForArtifact(baseline);
  const catalog = releaseVariants.catalog as { readonly baseline: unknown };
  expect(() =>
    selectProductClaudeRelease({
      release: release.options,
      releaseVariants: {
        ...releaseVariants,
        catalog: { baseline: catalog.baseline },
      },
      hookSignals: { settingsHooks: [{ id: "hook", event: "pre-tool-use" }] },
    }),
  ).toThrow();
  expect(() =>
    selectProductClaudeRelease({
      release: release.options,
      releaseVariants: { ...releaseVariants, ledger: { getArtifact: () => null } },
      hookSignals: { settingsHooks: [{ id: "hook", event: "pre-tool-use" }] },
    }),
  ).toThrow("CLAUDE_VARIANTS_LEDGER_RECORD_MISMATCH");
});

it("rejects a loaded baseline identity when the catalog selected hooks", async () => {
  const release = await claudeFixture();
  const baseline = claudeReleaseArtifact(release.options.identity, "baseline");
  const releaseVariants = claudeReleaseVariantsForArtifact(baseline);
  const selected = selectProductClaudeRelease({
    release: release.options,
    releaseVariants,
    hookSignals: { settingsHooks: [{ id: "hook", event: "pre-tool-use" }] },
  });
  const loaded = await loadHarnessRelease(release.options);
  expect(() => productLoadedPreparedRelease("claude-code", selected.artifact, loaded)).toThrow(
    "The verified product load does not match the selected artifact identity.",
  );
});

it("fails when a pinned process-resume artifact differs from hook selection", async () => {
  const release = await claudeFixture();
  const baseline = claudeReleaseArtifact(release.options.identity, "baseline");
  const releaseVariants = claudeReleaseVariantsForArtifact(baseline);
  expect(() =>
    selectProductClaudeRelease({
      release: release.options,
      releaseVariants,
      hookSignals: { settingsHooks: [{ id: "hook", event: "pre-tool-use" }] },
      processResumeArtifact: baseline,
    }),
  ).toThrow("CLAUDE_PRODUCT_RELEASE_RESUME_VARIANT_MISMATCH");
});
