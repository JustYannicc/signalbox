import * as NodeFSP from "node:fs/promises";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ProviderDriverKind } from "@t3tools/contracts";
import { syntheticAssets } from "./syntheticAssets.fixture.ts";
import { syntheticBundleInput } from "./syntheticBundle.fixture.ts";
import { dataForDriver } from "./runnerTurn.fixture.ts";
import { decodeBaseConfiguration } from "./fixture/configuration.schema.ts";
import { verifySeedConfiguration } from "./fixture/seedConfiguration.ts";

it.effect("runtime configuration rejects the old incomplete input and changed seed bytes", () =>
  Effect.gen(function* () {
    const data = yield* dataForDriver(ProviderDriverKind.make("claudeAgent"));
    yield* Effect.promise(async () => {
      const fixture = await syntheticAssets();
      try {
        const input = await syntheticBundleInput(fixture, data);
        const raw = JSON.parse(await NodeFSP.readFile(input.codex.configuration.path, "utf8"));
        expect(() =>
          decodeBaseConfiguration({
            schema: raw.schema,
            expectedRelease: raw.expectedRelease,
            commandRegistryHashes: [],
          }),
        ).toThrow();
        const decoded = decodeBaseConfiguration(raw);
        await expect(verifySeedConfiguration(decoded.seed)).resolves.toMatchObject({
          checkpoint: { checkpointId: decoded.seed.checkpointId },
        });
        await expect(
          verifySeedConfiguration({
            ...decoded.seed,
            files: decoded.seed.files.map((file) => ({ ...file, contentBase64: "Y2hhbmdlZA==" })),
          }),
        ).rejects.toThrow("DEPLOY3_SEED_FILE_BYTES_CHANGED");
        await expect(
          verifySeedConfiguration({ ...decoded.seed, manifestSha256: "a".repeat(64) }),
        ).rejects.toThrow("DEPLOY3_SEED_CHECKPOINT_MANIFEST_CHANGED");
      } finally {
        await fixture.dispose();
      }
    });
  }),
);
