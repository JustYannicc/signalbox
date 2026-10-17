import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as NativeArtifactCache from "./native-artifact-cache.ts";
import * as NativeArtifactLock from "./native-artifact-lock.ts";
import type { NativeDeviceTarget } from "./native-client-build-identity.ts";

export type NativePlatform = "ios" | "android";

type NativeBuildCommand<E, R> = (
  program: string,
  args: Array<string>,
  inherit?: boolean,
  cwd?: string,
  includeStderr?: boolean,
) => Effect.Effect<string, E, R>;

type BuilderErrors<E> =
  | E
  | NativeArtifactCache.NativeArtifactCacheError
  | NativeArtifactLock.NativeArtifactLockError
  | PlatformError.PlatformError;
type BuilderRequirements<R> = R | FileSystem.FileSystem | Path.Path | Crypto.Crypto;

export interface EnsureNativeClientArtifactOptions<E, R> {
  readonly cacheRoot: string;
  readonly platform: NativePlatform;
  readonly device: string;
  readonly target: NativeDeviceTarget;
  readonly identity: NativeArtifactCache.NativeArtifactIdentity;
  readonly repositoryRoot: string;
  readonly mobileRoot: string;
  readonly command: NativeBuildCommand<E, R>;
  readonly currentIdentity: () => Effect.Effect<NativeArtifactCache.NativeArtifactIdentity, E, R>;
  readonly installedBinary: () => Effect.Effect<string | null, E, R>;
  readonly waitForWorktreeLock?: () => Effect.Effect<void, E, R>;
}

type ProcessPresence = "alive" | "dead" | "unknown";

const processPresence = (pid: number): Effect.Effect<ProcessPresence> =>
  Effect.sync(() => {
    try {
      // Signal 0 checks this exact PID and does not terminate it.
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return "dead";
      }
      return "unknown";
    }
  });

const readProcessStartIdentity = <E, R>(pid: number, command: NativeBuildCommand<E, R>) =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    if (platform === "linux") {
      const fs = yield* FileSystem.FileSystem;
      const stat = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
      if (stat === null) return null;
      const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      return fields[19] ?? null;
    }
    if (platform === "darwin") {
      return yield* command("ps", ["-p", String(pid), "-o", "lstart="]).pipe(
        Effect.map((value) => value || null),
        Effect.orElseSucceed(() => null),
      );
    }
    if (platform === "win32") {
      return yield* command("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ]).pipe(
        Effect.map((value) => value || null),
        Effect.orElseSucceed(() => null),
      );
    }
    return null;
  });

const processProbe = <E, R>(
  command: NativeBuildCommand<E, R>,
): NativeArtifactLock.ProcessIdentityProbe<
  BuilderErrors<E>,
  R | FileSystem.FileSystem | Path.Path
> => ({
  current: Effect.gen(function* () {
    const startTime = yield* readProcessStartIdentity(process.pid, command);
    if (startTime === null)
      return yield* new NativeArtifactLock.NativeArtifactLockError({
        message: "Could not determine this process start identity for the native cache lock.",
      });
    return { pid: process.pid, startTime };
  }),
  observe: (pid: number) =>
    Effect.gen(function* () {
      const presence = yield* processPresence(pid);
      if (presence === "dead") return { _tag: "dead" } as const;
      if (presence === "unknown") return { _tag: "unknown" } as const;
      const startTime = yield* readProcessStartIdentity(pid, command).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (startTime === null) {
        return (yield* processPresence(pid)) === "dead"
          ? ({ _tag: "dead" } as const)
          : ({ _tag: "unknown" } as const);
      }
      return { _tag: "alive", startTime } as const;
    }),
});

const digest = Effect.fn("nativeClientArtifactBuilder.digest")(function* (value: string) {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export const ensureNativeClientArtifact = <E, R>(
  options: EnsureNativeClientArtifactOptions<E, R>,
): Effect.Effect<
  { readonly binary: string; readonly built: boolean; readonly cacheHit: boolean },
  BuilderErrors<E>,
  BuilderRequirements<R>
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (options.target.platform !== options.platform) {
      return yield* new NativeArtifactCache.NativeArtifactCacheError({
        message: "Native build target does not match the requested platform.",
      });
    }
    const process = processProbe(options.command);
    const cache = yield* NativeArtifactCache.ensureNativeArtifact({
      cacheRoot: options.cacheRoot,
      identity: options.identity,
      currentIdentity: options.currentIdentity,
      process,
      build: (artifactPath) =>
        Effect.gen(function* () {
          const worktreeKey = yield* digest(`${options.repositoryRoot}\n${options.platform}`);
          const worktreeLock = path.join(
            options.cacheRoot,
            "locks/worktrees",
            `${worktreeKey}.lock`,
          );
          yield* NativeArtifactLock.withNativeArtifactLock(
            {
              lockPath: worktreeLock,
              process,
              ...(options.waitForWorktreeLock ? { wait: options.waitForWorktreeLock } : {}),
            },
            Effect.gen(function* () {
              const tracked = yield* options.command(
                "git",
                ["ls-files", `apps/mobile/${options.platform}`],
                false,
                options.repositoryRoot,
              );
              if (tracked)
                return yield* new NativeArtifactCache.NativeArtifactCacheError({
                  message:
                    "Native directory contains tracked files; clean prebuild would overwrite them.",
                });
              yield* options.command(
                "vp",
                [
                  "exec",
                  "expo",
                  "prebuild",
                  "--clean",
                  "--platform",
                  options.platform,
                  "--no-install",
                ],
                true,
              );

              if (options.target.platform === "ios") {
                const derivedData = path.join(path.dirname(artifactPath), "derived-data");
                yield* options.command(
                  "pod",
                  ["install"],
                  true,
                  path.join(options.mobileRoot, "ios"),
                );
                yield* options.command(
                  "xcodebuild",
                  [
                    "-workspace",
                    path.join(options.mobileRoot, "ios/SignalboxDev.xcworkspace"),
                    "-scheme",
                    "SignalboxDev",
                    "-configuration",
                    "Debug",
                    "-sdk",
                    "iphonesimulator",
                    "-destination",
                    "generic/platform=iOS Simulator",
                    "-derivedDataPath",
                    derivedData,
                    "-quiet",
                    `ARCHS=${options.target.architecture}`,
                    "ONLY_ACTIVE_ARCH=YES",
                    "build",
                  ],
                  true,
                );
                const builtApp = path.join(
                  derivedData,
                  "Build/Products/Debug-iphonesimulator/SignalboxDev.app",
                );
                if (!(yield* fs.exists(builtApp)))
                  return yield* new NativeArtifactCache.NativeArtifactCacheError({
                    message: "Xcode finished without producing the simulator app bundle.",
                  });
                yield* fs.rename(builtApp, artifactPath);
                yield* fs.remove(derivedData, { recursive: true, force: true });
              } else {
                const android = path.join(options.mobileRoot, "android");
                const gradle = path.join(
                  android,
                  (yield* HostProcess.Platform) === "win32" ? "gradlew.bat" : "gradlew",
                );
                yield* options.command(
                  gradle,
                  ["app:assembleDebug", `-PreactNativeArchitectures=${options.target.abi}`],
                  true,
                  android,
                );
                const builtApk = path.join(android, "app/build/outputs/apk/debug/app-debug.apk");
                if (!(yield* fs.exists(builtApk)))
                  return yield* new NativeArtifactCache.NativeArtifactCacheError({
                    message: "Gradle finished without producing the debug APK.",
                  });
                yield* fs.copyFile(builtApk, artifactPath);
              }
            }),
          );
        }),
      install: (artifactPath) =>
        (options.platform === "ios"
          ? options.command("xcrun", ["simctl", "install", options.device, artifactPath], true)
          : options.command("adb", ["-s", options.device, "install", "-r", artifactPath], true)
        ).pipe(Effect.asVoid),
      installedBinary: options.installedBinary,
      expectedInstalledBinary: (artifactPath) =>
        Effect.gen(function* () {
          const artifactHash = yield* NativeArtifactCache.hashArtifact(artifactPath);
          if (options.target.platform === "ios") return artifactHash;
          const host = yield* HostProcess.Platform;
          const output =
            host === "darwin"
              ? yield* options.command("shasum", ["-a", "256", artifactPath])
              : host === "win32"
                ? yield* options.command("powershell.exe", [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    `(Get-FileHash -Algorithm SHA256 -LiteralPath '${artifactPath.replace(/'/g, "''")}').Hash`,
                  ])
                : yield* options.command("sha256sum", ["-b", artifactPath]);
          const binaryHash = output.match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
          if (!binaryHash)
            return yield* new NativeArtifactCache.NativeArtifactCacheError({
              message: "Could not hash the built Android APK.",
            });
          return yield* digest(binaryHash);
        }),
    });
    return {
      binary: cache.verifiedBinaryHash,
      built: cache.built,
      cacheHit: cache.cacheHit,
    };
  });
