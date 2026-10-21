import { describe, expect, it } from "vite-plus/test";
import { createHarnessPreparedAssets } from "./HarnessPreparedAssets.ts";
import { createNodeModule } from "../isolate/NodeModule.ts";
import { createNodeEnvironmentResolver } from "../isolate/NodeEnvironment.ts";
import {
  assertPreparedAssets,
  latinAsset,
  latinText,
  preparedAssetsFixture,
} from "./node/tests/preparedAssetsFixture.ts";
import { loadHarnessRelease } from "./HarnessReleaseLoader.ts";

describe("verified prepared assets", () => {
  it("exports Bun text and file loaders through public createRequire and resolve", async () => {
    const { loaded } = await preparedAssetsFixture();
    const assets = createHarnessPreparedAssets(loaded);
    const resolver = createNodeEnvironmentResolver({
      packages: {},
      addons: [],
      prepared: assets.prepared,
    });
    const module = createNodeModule(
      {
        require: () => {
          throw new Error("Unexpected builtin");
        },
      },
      resolver,
      assets.resolvePrepared,
    );
    assertPreparedAssets(module);
    loaded.payloads.get("cli/assets/extra-0")!.fill(65);
    expect(module.createRequire("/entry.js")(latinAsset)).toBe(latinText);
  });

  it("cannot expose bytes that fail artifact verification", async () => {
    const { fixture } = await preparedAssetsFixture();
    fixture.files.get("cli/assets/extra-0")!.fill(65);
    await expect(loadHarnessRelease(fixture.options)).rejects.toThrow();
  });

  it("refuses missing verified payloads before constructing the resolver", async () => {
    const { loaded } = await preparedAssetsFixture();
    const payloads = new Map(loaded.payloads);
    payloads.delete("cli/assets/extra-0");
    expect(() => createHarnessPreparedAssets({ ...loaded, payloads })).toThrow(
      "Missing verified prepared asset payload",
    );
  });
});
