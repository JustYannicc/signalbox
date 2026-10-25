import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as NativeArtifactCache from "./lib/native-artifact-cache.ts";
import { ensureClient } from "./mobile-native-client.ts";

const context = {
  identity: {
    schemaVersion: 1,
    platform: "ios",
    fingerprint: "a".repeat(40),
    expoPlatforms: ["ios"],
    target: { runtime: "iOS-27-0", architecture: "arm64" },
    toolchain: { xcode: "Xcode 27.0 build 18A123" },
    sources: [],
    artifactKind: "app",
  } satisfies NativeArtifactCache.NativeArtifactIdentity,
  cacheKey: "c".repeat(64),
};

it.layer(NodeServices.layer)("mobile native client ensure", (it) => {
  it.effect("does not record an artifact when the installed binary hash differs", () =>
    Effect.gen(function* () {
      let savedRecord: { fingerprint: string; cacheKey: string; binary: string } | null = null;
      let buildCount = 0;
      const exit = yield* ensureClient({
        buildContext: Effect.succeed(context),
        currentBuildContext: () => Effect.succeed(context),
        installedBinary: Effect.succeed("installed-hash"),
        readRecord: Effect.succeed(null),
        buildAndInstall: () =>
          Effect.sync(() => {
            buildCount += 1;
            return { binary: "manifest-hash", built: false, cacheHit: true };
          }),
        saveRecord: (record) => Effect.sync(() => (savedRecord = record)),
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.equal(buildCount, 1);
      assert.equal(savedRecord, null);
    }),
  );

  it.effect("does not record a verified build when Expo inputs drift before the record", () =>
    Effect.gen(function* () {
      let fingerprintReads = 0;
      let buildCount = 0;
      let savedRecord: { fingerprint: string; cacheKey: string; binary: string } | null = null;
      const exit = yield* ensureClient({
        buildContext: Effect.succeed(context),
        currentBuildContext: () =>
          Effect.sync(() => {
            fingerprintReads += 1;
            return fingerprintReads === 1 ? context : { ...context, cacheKey: "d".repeat(64) };
          }),
        installedBinary: Effect.succeed("verified-hash"),
        readRecord: Effect.succeed(null),
        buildAndInstall: () =>
          Effect.sync(() => {
            buildCount += 1;
            return { binary: "verified-hash", built: true, cacheHit: false };
          }),
        saveRecord: (record) => Effect.sync(() => (savedRecord = record)),
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.equal(buildCount, 1);
      assert.equal(savedRecord, null);
    }),
  );

  it.effect("reports a local device record without rebuilding when it is already compatible", () =>
    Effect.gen(function* () {
      let buildCount = 0;
      const result = yield* ensureClient({
        buildContext: Effect.succeed(context),
        currentBuildContext: () => Effect.succeed(context),
        installedBinary: Effect.succeed("installed-hash"),
        readRecord: Effect.succeed({
          fingerprint: context.identity.fingerprint,
          cacheKey: context.cacheKey,
          binary: "installed-hash",
        }),
        buildAndInstall: () =>
          Effect.sync(() => {
            buildCount += 1;
            return { binary: "installed-hash", built: false, cacheHit: false };
          }),
        saveRecord: () => Effect.void,
      });

      assert.equal(buildCount, 0);
      assert.equal(result.status, "compatible");
      assert.isFalse(result.rebuilt);
      assert.isFalse(result.cacheHit);
    }),
  );
});
