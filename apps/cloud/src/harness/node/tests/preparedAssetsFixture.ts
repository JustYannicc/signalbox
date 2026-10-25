import * as NodeAssert from "node:assert/strict";
import { loadHarnessRelease } from "../../HarnessReleaseLoader.ts";
import { claudeFixture } from "../../releaseLoader/tests/artifactFixtures.ts";
import type { GuestModule } from "./fixture.ts";

export const latinAsset = "/embedded/latin.txt";
export const latinText = "\u0000\u0080\u009f\u00e9\u00ff";
export const utf16Text = "\ufeffHi \ud83d\ude00\ud800";

export async function preparedAssetsFixture() {
  const fixture = await claudeFixture({
    assets: {
      [latinAsset]: { bytes: new Uint8Array([0, 128, 159, 233, 255]), loader: 13, encoding: 1 },
      "/embedded/utf16.txt": {
        bytes: new Uint8Array([255, 254, 72, 0, 105, 0, 32, 0, 61, 216, 0, 222, 0, 216]),
        loader: 13,
        encoding: 2,
      },
      "/embedded/encoding-zero.txt": { bytes: new Uint8Array([195, 169]), loader: 13, encoding: 0 },
      "/embedded/unsupported.bin": { bytes: new Uint8Array([1]), loader: 99, encoding: 0 },
    },
  });
  return { fixture, loaded: await loadHarnessRelease(fixture.options) };
}

export function assertPreparedAssets(module: GuestModule) {
  const require = module.createRequire("/$bunfs/root/main.js");
  NodeAssert.equal(require(latinAsset), latinText);
  NodeAssert.equal(require.resolve(latinAsset), latinAsset);
  NodeAssert.equal(require("embedded/latin.txt"), latinText);
  for (const referrer of [
    "/embedded/worker",
    "/worker.cjs",
    "/cli/worker.cjs",
    new URL("file:///worker.cjs"),
  ]) {
    const relative = module.createRequire(referrer);
    NodeAssert.equal(relative("./latin.txt"), latinText);
    NodeAssert.equal(relative.resolve("./latin.txt"), latinAsset);
    NodeAssert.equal(relative("./utf16.txt"), utf16Text);
    NodeAssert.equal(relative("./encoding-zero.txt"), "\u00c3\u00a9");
  }
  NodeAssert.equal(require("/help"), "/help");
  for (const specifier of [
    "/undeclared.txt",
    "/embedded/unsupported.bin",
    "/LATIN.txt",
    "/cli/assets/extra-0",
  ]) {
    NodeAssert.throws(() => require(specifier), {
      code: "ERR_NODE_PREPARED_MODULE_UNAVAILABLE",
      operation: "require",
      specifier,
    });
    NodeAssert.throws(() => require.resolve(specifier), {
      code: "ERR_NODE_PREPARED_MODULE_UNAVAILABLE",
      operation: "resolve",
      specifier,
    });
  }
}
