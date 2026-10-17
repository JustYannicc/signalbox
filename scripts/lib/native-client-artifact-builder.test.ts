import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as NativeArtifactCache from "./native-artifact-cache.ts";
import * as NativeClientArtifactBuilder from "./native-client-artifact-builder.ts";
import * as NativeClientBuildHost from "./native-client-build-host.ts";
import * as NativeClientBuildIdentity from "./native-client-build-identity.ts";

const makeIdentity = (abi: string): NativeArtifactCache.NativeArtifactIdentity =>
  ({
    schemaVersion: 1,
    platform: "android",
    fingerprint: "a".repeat(40),
    expoPlatforms: ["android"],
    target: { abi, apiLevel: "35", variant: "debug", appId: "com.justyannicc.signalbox.dev" },
    toolchain: { java: "17", gradle: "8.13", sdk: "35" },
    sources: [
      {
        type: "file",
        filePath: "app.json",
        reasons: ["expoConfig"],
        hash: "b".repeat(40),
      },
    ],
    artifactKind: "apk",
  }) satisfies NativeArtifactCache.NativeArtifactIdentity;

it.layer(NodeServices.layer)("native client artifact builder", (it) => {
  it.effect("uses UTC and C locale for macOS process start identities", () =>
    Effect.gen(function* () {
      const readWithEnvironment = (ambient: Record<string, string>) =>
        NativeClientBuildHost.readProcessStartIdentity(
          55,
          "darwin",
          (program, args, _inherit, _cwd, _includeStderr, overrides) => {
            assert.equal(program, "ps");
            assert.deepEqual(args, ["-p", "55", "-o", "lstart="]);
            const environment = { ...ambient, ...overrides };
            return Effect.succeed(`${environment.TZ}/${environment.LC_ALL}`);
          },
        );
      const [utc, zurich] = yield* Effect.all([
        readWithEnvironment({ TZ: "UTC", LC_ALL: "C" }),
        readWithEnvironment({ TZ: "Europe/Zurich", LC_ALL: "de_CH.UTF-8" }),
      ]);

      assert.equal(utc, "UTC/C");
      assert.equal(zurich, "UTC/C");
    }),
  );

  it.effect("keeps a live process observation unknown when its start time cannot be read", () =>
    Effect.gen(function* () {
      const probe = NativeClientBuildHost.nativeProcessIdentityProbe(
        () => Effect.succeed(""),
        "darwin",
      );

      assert.deepEqual(yield* probe.observe(process.pid), { _tag: "unknown" });
    }),
  );

  it.effect("uses sha256sum for Linux APK verification", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-builder-linux-hash-" });
      const artifactPath = path.join(root, "app-debug.apk");
      const contents = "linux-apk-content";
      yield* fs.writeFileString(artifactPath, contents);
      const rawBytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(contents));
      const rawHash = Array.from(rawBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const calls: Array<{ program: string; args: Array<string> }> = [];
      const verifiedHash = yield* NativeClientBuildHost.hashAndroidApk({
        host: "linux",
        artifactPath,
        command: (program, args) => {
          calls.push({ program, args });
          return Effect.succeed(`${rawHash} *${artifactPath}`);
        },
      });
      const wrappedBytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(rawHash));
      const expected = Array.from(wrappedBytes, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );

      assert.deepEqual(calls, [{ program: "sha256sum", args: ["-b", artifactPath] }]);
      assert.equal(verifiedHash, expected);
    }),
  );

  it.effect("serializes different target builds that share one worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-builder-worktree-lock-" });
      const repositoryRoot = path.join(root, "checkout");
      const mobileRoot = path.join(repositoryRoot, "apps/mobile");
      const cacheRoot = path.join(root, "cache");
      const apkPath = path.join(mobileRoot, "android/app/build/outputs/apk/debug/app-debug.apk");
      let buildCount = 0;
      let activeBuilds = 0;
      let maximumActiveBuilds = 0;
      let releaseFirstBuild!: () => void;
      const firstBuild = new Promise<void>((resolve) => {
        releaseFirstBuild = resolve;
      });

      const command = (program: string, args: Array<string>) =>
        Effect.gen(function* () {
          if (program === "ps") return "test-process-start";
          if (program === "git") return "";
          if (program === "vp") return "prebuild complete";
          if (program.endsWith("gradlew")) {
            buildCount += 1;
            activeBuilds += 1;
            maximumActiveBuilds = Math.max(maximumActiveBuilds, activeBuilds);
            const first = buildCount === 1;
            if (first) yield* Effect.promise(() => firstBuild);
            else releaseFirstBuild();
            yield* fs.makeDirectory(path.dirname(apkPath), { recursive: true });
            yield* fs.writeFileString(apkPath, args.at(-1) ?? `build-${buildCount}`);
            return "BUILD SUCCESSFUL";
          }
          if (program === "adb" && args.includes("install")) {
            yield* fs.copyFile(args.at(-1)!, path.join(root, `${args[1]}.apk`));
            return "Success";
          }
          if (program === "shasum" || program === "sha256sum") {
            const contents = yield* fs.readFileString(args.at(-1)!);
            const bytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(contents));
            return `${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}  ${args.at(-1)}`;
          }
          return "";
        }).pipe(
          Effect.ensuring(
            program.endsWith("gradlew")
              ? Effect.sync(() => (activeBuilds = Math.max(0, activeBuilds - 1)))
              : Effect.void,
          ),
        );

      const request = (abi: string, device: string) => {
        const identity = makeIdentity(abi);
        const target: NativeClientBuildIdentity.NativeDeviceTarget = {
          platform: "android",
          abi,
          apiLevel: "35",
        };
        return NativeClientArtifactBuilder.ensureNativeClientArtifact({
          cacheRoot,
          platform: "android",
          device,
          target,
          identity,
          repositoryRoot,
          mobileRoot,
          command,
          currentIdentity: () => Effect.succeed(identity),
          installedBinary: () =>
            Effect.gen(function* () {
              const installedPath = path.join(root, `${device}.apk`);
              if (!(yield* fs.exists(installedPath))) return null;
              const contents = yield* fs.readFileString(installedPath);
              const bytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(contents));
              const rawHash = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
                "",
              );
              const wrappedHash = yield* crypto.digest(
                "SHA-256",
                new TextEncoder().encode(rawHash),
              );
              return Array.from(wrappedHash, (byte) => byte.toString(16).padStart(2, "0")).join("");
            }),
          waitForWorktreeLock: () =>
            Effect.sync(releaseFirstBuild).pipe(Effect.andThen(Effect.yieldNow)),
        });
      };

      const results = yield* Effect.all(
        [request("arm64-v8a", "emulator-arm"), request("x86_64", "emulator-x86")],
        { concurrency: "unbounded" },
      );

      assert.equal(buildCount, 2);
      assert.equal(maximumActiveBuilds, 1);
      assert.deepEqual(
        results.map((result) => result.built),
        [true, true],
      );
      assert.equal(
        yield* fs.readFileString(path.join(root, "emulator-arm.apk")),
        "-PreactNativeArchitectures=arm64-v8a",
      );
      assert.equal(
        yield* fs.readFileString(path.join(root, "emulator-x86.apk")),
        "-PreactNativeArchitectures=x86_64",
      );
    }),
  );
});
