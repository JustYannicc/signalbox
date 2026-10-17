import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as NativeArtifactCache from "./native-artifact-cache.ts";
import * as NativeArtifactLock from "./native-artifact-lock.ts";

type TestRequirements = FileSystem.FileSystem | Path.Path | Crypto.Crypto;
type TestErrors = PlatformError.PlatformError | NativeArtifactCache.NativeArtifactCacheError;
const LockOwnerSchema = Schema.Struct({ pid: Schema.Number, startTime: Schema.String });
const encodeLockOwner = Schema.encodeSync(Schema.fromJsonString(LockOwnerSchema));

const identity = (
  overrides: Partial<NativeArtifactCache.NativeArtifactIdentity> = {},
): NativeArtifactCache.NativeArtifactIdentity =>
  ({
    schemaVersion: 1,
    platform: "ios",
    fingerprint: "a".repeat(40),
    expoPlatforms: ["ios"],
    target: { runtime: "iOS-27-0", architecture: "arm64" },
    toolchain: { host: "darwin", xcode: "Xcode 27.0 build 18A123", simulatorSdk: "27.0" },
    sources: [
      {
        type: "file",
        filePath: "app.json",
        reasons: ["expoConfig"],
        hash: "f".repeat(40),
      },
    ],
    artifactKind: "app",
    ...overrides,
  }) satisfies NativeArtifactCache.NativeArtifactIdentity;

const processProbe = (pid: number): NativeArtifactLock.ProcessIdentityProbe<never, never> => ({
  current: Effect.succeed({ pid, startTime: `process-${pid}` }),
  observe: (observedPid) => Effect.succeed({ _tag: "alive", startTime: `process-${observedPid}` }),
});

const writeArtifact = (
  buildIdentity: NativeArtifactCache.NativeArtifactIdentity,
  artifactPath: string,
  contents: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (buildIdentity.artifactKind === "app") {
      yield* fs.makeDirectory(artifactPath);
      yield* fs.writeFileString(`${artifactPath}/Info.plist`, contents);
    } else {
      yield* fs.writeFileString(artifactPath, contents);
    }
  });

const makeClient = (input: {
  readonly cacheRoot: string;
  readonly worktree: string;
  readonly device: string;
  readonly identity: NativeArtifactCache.NativeArtifactIdentity;
  readonly build: (artifactPath: string) => Effect.Effect<void, TestErrors, TestRequirements>;
  readonly waitForLock?: () => Effect.Effect<void, TestErrors, TestRequirements>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const installedPath = path.join(input.cacheRoot, "installed", `${input.device}.native`);
    return {
      cacheRoot: path.join(input.cacheRoot, "artifacts"),
      identity: input.identity,
      currentIdentity: () => Effect.succeed(input.identity),
      process: processProbe(input.device.length + 100),
      build: input.build,
      install: (artifactPath: string) =>
        Effect.gen(function* () {
          yield* fs.remove(installedPath, { recursive: true, force: true });
          yield* fs.copy(artifactPath, installedPath);
        }),
      installedBinary: () =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(installedPath))) return null;
          return yield* NativeArtifactCache.hashArtifact(installedPath);
        }),
      expectedInstalledBinary: (artifactPath: string) =>
        NativeArtifactCache.hashArtifact(artifactPath),
      ...(input.waitForLock ? { waitForLock: input.waitForLock } : {}),
    } satisfies NativeArtifactCache.EnsureNativeArtifactOptions<
      TestErrors,
      TestRequirements,
      TestErrors
    >;
  });

it.layer(NodeServices.layer)("native artifact cache", (it) => {
  it.effect("reuses one verified artifact across worktrees and installs it per device", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-artifact-cross-worktree-" });
      const buildIdentity = identity({
        sources: [
          {
            type: "file",
            filePath: "app.json",
            reasons: ["expoConfig"],
            hash: "f".repeat(40),
          },
          {
            type: "file",
            filePath: "app.config.ts",
            reasons: ["expoConfigPlugins"],
            hash: "e".repeat(40),
          },
        ],
      });
      const reorderedSourcesIdentity = identity({
        sources: buildIdentity.sources.toReversed(),
      });
      let buildCount = 0;

      const request = (
        worktree: string,
        device: string,
        requestIdentity: NativeArtifactCache.NativeArtifactIdentity,
      ) =>
        makeClient({
          cacheRoot: root,
          worktree,
          device,
          identity: requestIdentity,
          build: (artifactPath) =>
            Effect.gen(function* () {
              buildCount += 1;
              yield* writeArtifact(requestIdentity, artifactPath, `built by ${worktree}`);
            }),
        }).pipe(Effect.flatMap((options) => NativeArtifactCache.ensureNativeArtifact(options)));

      const first = yield* request("worktree-a", "simulator-a", buildIdentity);
      const second = yield* request("worktree-b", "simulator-b", reorderedSourcesIdentity);

      assert.equal(buildCount, 1);
      assert.isTrue(first.built);
      assert.isFalse(first.cacheHit);
      assert.isFalse(second.built);
      assert.isTrue(second.cacheHit);
      assert.equal(
        yield* fs.readFileString(path.join(root, "installed/simulator-a.native/Info.plist")),
        "built by worktree-a",
      );
      assert.equal(
        yield* fs.readFileString(path.join(root, "installed/simulator-b.native/Info.plist")),
        "built by worktree-a",
      );
      const manifest = yield* fs.readFileString(
        path.join(path.dirname(first.artifactPath), "manifest.json"),
      );
      assert.isTrue(manifest.includes('"expoPlatforms":["ios"]'));
      assert.isTrue(manifest.includes('"filePath":"app.json"'));
      assert.isTrue(manifest.includes(`"hash":"${"f".repeat(40)}"`));
      assert.isTrue(manifest.includes("Xcode 27.0 build 18A123"));
      assert.isTrue(manifest.includes('"manifestDigest":"'));
    }),
  );

  it.effect("serializes concurrent callers so one build serves both devices", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-artifact-concurrent-" });
      const buildIdentity = identity({
        platform: "android",
        expoPlatforms: ["android"],
        target: { abi: "arm64-v8a", apiLevel: "35" },
        artifactKind: "apk",
      });
      let releaseBuild!: () => void;
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      let builds = 0;

      const request = (device: string, pid: number) =>
        NativeArtifactCache.ensureNativeArtifact({
          cacheRoot: root,
          identity: buildIdentity,
          currentIdentity: () => Effect.succeed(buildIdentity),
          process: processProbe(pid),
          waitForLock: () => Effect.sync(releaseBuild).pipe(Effect.andThen(Effect.yieldNow)),
          build: (artifactPath) =>
            Effect.gen(function* () {
              builds += 1;
              yield* Effect.promise(() => buildGate);
              yield* writeArtifact(buildIdentity, artifactPath, "one-debug-apk");
            }),
          install: (artifactPath) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              yield* fs.copy(artifactPath, path.join(root, `${device}.apk`));
            }),
          installedBinary: () =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const installedPath = path.join(root, `${device}.apk`);
              return (yield* fs.exists(installedPath))
                ? yield* NativeArtifactCache.hashArtifact(installedPath)
                : null;
            }),
          expectedInstalledBinary: (artifactPath) => NativeArtifactCache.hashArtifact(artifactPath),
        });

      const results = yield* Effect.all([request("emulator-a", 201), request("emulator-b", 202)], {
        concurrency: "unbounded",
      });
      assert.equal(builds, 1);
      assert.deepEqual(results.map((result) => result.cacheHit).sort(), [false, true]);
    }),
  );

  it.effect("separates fingerprint and Xcode toolchain identities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-artifact-identities-" });
      const base = identity();
      const toolchainChanged = identity({
        toolchain: { host: "darwin", xcode: "Xcode 26.5 build 17F80", simulatorSdk: "26.5" },
      });
      const fingerprintChanged = identity({ fingerprint: "b".repeat(40) });
      let builds = 0;

      for (const [index, buildIdentity] of [base, toolchainChanged, fingerprintChanged].entries()) {
        const request = yield* makeClient({
          cacheRoot: root,
          worktree: `worktree-${index}`,
          device: `simulator-${index}`,
          identity: buildIdentity,
          build: (artifactPath) =>
            Effect.gen(function* () {
              builds += 1;
              yield* writeArtifact(buildIdentity, artifactPath, `artifact-${index}`);
            }),
        });
        yield* NativeArtifactCache.ensureNativeArtifact(request);
      }

      assert.equal(builds, 3);
    }),
  );

  it.effect("rejects a cached artifact whose verified bytes changed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-artifact-tamper-" });
      const buildIdentity = identity();
      let builds = 0;
      const request = yield* makeClient({
        cacheRoot: root,
        worktree: "worktree-a",
        device: "simulator-a",
        identity: buildIdentity,
        build: (artifactPath) =>
          Effect.gen(function* () {
            builds += 1;
            yield* writeArtifact(buildIdentity, artifactPath, `build-${builds}`);
          }),
      });

      const first = yield* NativeArtifactCache.ensureNativeArtifact(request);
      yield* fs.writeFileString(path.join(first.artifactPath, "Info.plist"), "tampered");
      const second = yield* NativeArtifactCache.ensureNativeArtifact(request);

      assert.equal(builds, 2);
      assert.isTrue(second.built);
      assert.isFalse(second.cacheHit);
      assert.equal(
        yield* fs.readFileString(path.join(second.artifactPath, "Info.plist")),
        "build-2",
      );
    }),
  );

  it.effect("does not reuse an artifact when retained Expo source hashes disagree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-artifact-provenance-" });
      const original = identity();
      const changedSources = identity({
        sources: [
          {
            type: "file",
            filePath: "app.json",
            reasons: ["expoConfig"],
            hash: "0".repeat(40),
          },
        ],
      });
      let builds = 0;

      const request = (device: string, buildIdentity: NativeArtifactCache.NativeArtifactIdentity) =>
        makeClient({
          cacheRoot: root,
          worktree: `worktree-${device}`,
          device,
          identity: buildIdentity,
          build: (artifactPath) =>
            Effect.gen(function* () {
              builds += 1;
              yield* writeArtifact(buildIdentity, artifactPath, `build-${builds}`);
            }),
        }).pipe(Effect.flatMap((options) => NativeArtifactCache.ensureNativeArtifact(options)));

      const first = yield* request("simulator-a", original);
      const second = yield* request("simulator-b", changedSources);

      assert.equal(builds, 2);
      assert.isTrue(first.built);
      assert.isTrue(second.built);
      assert.equal(yield* fs.readFileString(`${second.artifactPath}/Info.plist`), "build-2");
    }),
  );

  it.effect("rejects a device install whose installed binary hash differs from the artifact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "native-artifact-install-mismatch-",
      });
      const buildIdentity = identity();
      const client = yield* makeClient({
        cacheRoot: root,
        worktree: "worktree-a",
        device: "simulator-a",
        identity: buildIdentity,
        build: (artifactPath) => writeArtifact(buildIdentity, artifactPath, "verified-artifact"),
      });
      const mismatched = { ...client, installedBinary: () => Effect.succeed("different-binary") };
      const exit = yield* NativeArtifactCache.ensureNativeArtifact(mismatched).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("does not publish a failed or input-drifted build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-artifact-no-poison-" });
      const buildIdentity = identity();
      const cacheKey = yield* NativeArtifactCache.nativeArtifactCacheKey(buildIdentity);
      let builds = 0;
      const failedRequest = yield* makeClient({
        cacheRoot: root,
        worktree: "failed-worktree",
        device: "simulator-failed",
        identity: buildIdentity,
        build: (artifactPath) =>
          Effect.gen(function* () {
            builds += 1;
            yield* writeArtifact(buildIdentity, artifactPath, "partial");
            return yield* new NativeArtifactCache.NativeArtifactCacheError({
              message: "simulated build failure",
            });
          }),
      });
      const failed = yield* NativeArtifactCache.ensureNativeArtifact(failedRequest).pipe(
        Effect.exit,
      );
      const entryPath = path.join(root, "artifacts", "ios", cacheKey);
      assert.isTrue(Exit.isFailure(failed));
      assert.isFalse(yield* fs.exists(entryPath));

      const interruptedRequest = {
        ...failedRequest,
        device: "simulator-interrupted",
        build: (artifactPath: string) =>
          Effect.gen(function* () {
            builds += 1;
            yield* writeArtifact(buildIdentity, artifactPath, "partial-before-interrupt");
            return yield* Effect.interrupt;
          }),
      };
      const interrupted = yield* NativeArtifactCache.ensureNativeArtifact(interruptedRequest).pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(interrupted));
      assert.isFalse(yield* fs.exists(entryPath));

      let buildFinished = false;
      const changedIdentity = identity({
        sources: [
          { type: "file", filePath: "app.json", reasons: ["expoConfig"], hash: "0".repeat(40) },
        ],
      });
      const driftingRequest = {
        ...failedRequest,
        currentIdentity: () => Effect.succeed(buildFinished ? changedIdentity : buildIdentity),
        build: (artifactPath: string) =>
          Effect.gen(function* () {
            builds += 1;
            yield* writeArtifact(buildIdentity, artifactPath, "built-before-drift");
            buildFinished = true;
          }),
      };
      const drifted = yield* NativeArtifactCache.ensureNativeArtifact(driftingRequest).pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(drifted));
      assert.isFalse(yield* fs.exists(entryPath));
    }),
  );

  it.effect("reclaims a dead lock owner and leaves a live owner untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-artifact-lock-" });
      const lockPath = path.join(root, "dead.lock");
      const deadOwner = { pid: 301, startTime: "old-process" };
      yield* fs.makeDirectory(lockPath);
      const deadOwnerText = encodeLockOwner(deadOwner);
      yield* fs.writeFileString(path.join(lockPath, "owner.json"), deadOwnerText);

      const reclaimed = yield* NativeArtifactLock.withNativeArtifactLock(
        {
          lockPath,
          process: {
            current: Effect.succeed({ pid: 302, startTime: "new-process" }),
            observe: () => Effect.succeed({ _tag: "dead" }),
          },
        },
        Effect.succeed("acquired"),
      );
      assert.equal(reclaimed, "acquired");

      const recycledPath = path.join(root, "recycled.lock");
      yield* fs.makeDirectory(recycledPath);
      yield* fs.writeFileString(
        path.join(recycledPath, "owner.json"),
        encodeLockOwner({ pid: 305, startTime: "previous-process" }),
      );
      const recycled = yield* NativeArtifactLock.withNativeArtifactLock(
        {
          lockPath: recycledPath,
          process: {
            current: Effect.succeed({ pid: 306, startTime: "new-process" }),
            observe: () => Effect.succeed({ _tag: "alive", startTime: "recycled-process" }),
          },
        },
        Effect.succeed("reclaimed recycled PID"),
      );
      assert.equal(recycled, "reclaimed recycled PID");

      const livePath = path.join(root, "live.lock");
      const liveOwner = { pid: 303, startTime: "still-running" };
      yield* fs.makeDirectory(livePath);
      const liveOwnerText = encodeLockOwner(liveOwner);
      yield* fs.writeFileString(path.join(livePath, "owner.json"), liveOwnerText);
      const stopped = yield* NativeArtifactLock.withNativeArtifactLock(
        {
          lockPath: livePath,
          process: {
            current: Effect.succeed({ pid: 304, startTime: "contender" }),
            observe: () => Effect.succeed({ _tag: "alive", startTime: "still-running" }),
          },
          wait: () =>
            Effect.fail(
              new NativeArtifactLock.NativeArtifactLockError({
                message: "bounded live-lock check",
              }),
            ),
        },
        Effect.void,
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(stopped));
      assert.isTrue(yield* fs.exists(livePath));
      assert.equal(yield* fs.readFileString(path.join(livePath, "owner.json")), liveOwnerText);

      const unknownPath = path.join(root, "unknown.lock");
      const unknownOwner = { pid: 305, startTime: "unverifiable" };
      const unknownOwnerText = encodeLockOwner(unknownOwner);
      yield* fs.makeDirectory(unknownPath);
      yield* fs.writeFileString(path.join(unknownPath, "owner.json"), unknownOwnerText);
      const unverifiable = yield* NativeArtifactLock.withNativeArtifactLock(
        {
          lockPath: unknownPath,
          process: {
            current: Effect.succeed({ pid: 306, startTime: "contender" }),
            observe: () => Effect.succeed({ _tag: "unknown" }),
          },
        },
        Effect.void,
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(unverifiable));
      assert.isTrue(yield* fs.exists(unknownPath));
      assert.equal(
        yield* fs.readFileString(path.join(unknownPath, "owner.json")),
        unknownOwnerText,
      );
    }),
  );
});
