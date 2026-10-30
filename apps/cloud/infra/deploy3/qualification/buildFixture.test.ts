import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProviderDriverKind } from "@t3tools/contracts";
import { dataForDriver } from "../../../src/harness/adapter/tests/data.ts";
import { buildCombinedFixture } from "./buildFixture.ts";
import { fixtureHash, syntheticAssets } from "./syntheticAssets.fixture.ts";
import { syntheticBundleInput } from "./syntheticBundle.fixture.ts";

it.effect(
  "combined bundle contains both product facets and pins their compiled source",
  () =>
    Effect.gen(function* () {
      const { turn } = yield* dataForDriver(ProviderDriverKind.make("claudeAgent"));
      yield* Effect.promise(async () => {
        const f = await syntheticAssets();
        try {
          const input = await syntheticBundleInput(f, turn);
          const result = await buildCombinedFixture(input);
          expect(result.classification).toBe("synthetic");
          expect(result.nativeStarted).toBe(false);
          expect(result.qualification).toBe("not-run");
          expect(result.deploymentReady).toBe(false);
          expect(result.outputs.map((pin) => pin.path)).toEqual([
            "qualifier-implementation.mjs",
            "qualifier-claude-implementation.mjs",
            "qualifier-worker.mjs",
            "qualifier-claude-workflow.mjs",
          ]);
          for (const pin of result.outputs) {
            const bytes = await NodeFSP.readFile(NodePath.join(input.outputDirectory, pin.path));
            expect(fixtureHash(bytes)).toBe(pin.sha256);
          }
          const config = JSON.parse(
            await NodeFSP.readFile(
              NodePath.join(input.outputDirectory, "assets/qualifier/config.json"),
              "utf8",
            ),
          );
          expect(config.claude.runtime.assets.assets.purpose).toBe("qualification");
          expect(config.claude.expected.baseline.artifact.releaseId).toBe("baseline");
          expect(config.claude.expected.hooks.artifact.releaseId).toBe("hooks");
          expect(
            Object.keys(result.sources).some((path) =>
              path.endsWith("ProductClaudeHarnessSessionHost.ts"),
            ),
          ).toBe(true);
          expect(
            Object.keys(result.sources).some((path) =>
              path.endsWith("ProductCodexHarnessSessionHost.ts"),
            ),
          ).toBe(true);
          expect(
            Object.keys(result.sources).every((path) => !path.includes("/.codex/artifacts/")),
          ).toBe(true);
        } finally {
          await f.dispose();
        }
      });
    }),
  30_000,
);

it.effect("changed engine or qualification purpose is refused before an output is created", () =>
  Effect.gen(function* () {
    const { turn } = yield* dataForDriver(ProviderDriverKind.make("claudeAgent"));
    yield* Effect.promise(async () => {
      const f = await syntheticAssets();
      try {
        const input = await syntheticBundleInput(f, turn);
        await expect(
          buildCombinedFixture({
            ...input,
            claude: { ...input.claude, assets: { ...input.claude.assets, purpose: "release" } },
          }),
        ).rejects.toThrow("QUALIFICATION_ASSETS_REQUIRED");
        const changed = structuredClone(input);
        changed.codex.engine.sha256 = "e".repeat(64);
        await expect(buildCombinedFixture(changed)).rejects.toThrow("ENGINE_IDENTITY_MISMATCH");
        const wrongPrompt = structuredClone(input);
        const unexpected = JSON.parse(wrongPrompt.claudeRuntime.turnJson.baseline[1]!);
        unexpected.message.text = "Another workload";
        wrongPrompt.claudeRuntime.turnJson.baseline[1] = JSON.stringify(unexpected);
        await expect(buildCombinedFixture(wrongPrompt)).rejects.toThrow("TURN_IDENTITY_MISMATCH");
        const duplicate = structuredClone(input);
        const repeated = JSON.parse(duplicate.claudeRuntime.turnJson.baseline[1]!);
        repeated.runId = JSON.parse(duplicate.claudeRuntime.turnJson.baseline[0]!).runId;
        duplicate.claudeRuntime.turnJson.baseline[1] = JSON.stringify(repeated);
        await expect(buildCombinedFixture(duplicate)).rejects.toThrow("TURN_IDENTITY_REUSED");
        await expect(NodeFSP.stat(input.outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await f.dispose();
      }
    });
  }),
);
