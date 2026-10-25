import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as NativeArtifactCache from "./native-artifact-cache.ts";
import * as NativeArtifactLock from "./native-artifact-lock.ts";

export type NativeBuildCommand<E, R> = (
  program: string,
  args: Array<string>,
  inherit?: boolean,
  cwd?: string,
  includeStderr?: boolean,
  environment?: Record<string, string>,
) => Effect.Effect<string, E, R>;

export type NativeBuildErrors<E> =
  | E
  | NativeArtifactCache.NativeArtifactCacheError
  | NativeArtifactLock.NativeArtifactLockError
  | PlatformError.PlatformError;

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

export const readProcessStartIdentity = <E, R>(
  pid: number,
  platform: string,
  command: NativeBuildCommand<E, R>,
) =>
  Effect.gen(function* () {
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
      return yield* command("ps", ["-p", String(pid), "-o", "lstart="], false, undefined, false, {
        TZ: "UTC",
        LC_ALL: "C",
      }).pipe(
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

export const nativeProcessIdentityProbe = <E, R>(
  command: NativeBuildCommand<E, R>,
  platformOverride?: string,
): NativeArtifactLock.ProcessIdentityProbe<
  NativeBuildErrors<E>,
  R | FileSystem.FileSystem | Path.Path
> => ({
  current: Effect.gen(function* () {
    const platform = platformOverride ?? (yield* HostProcess.Platform);
    const startTime = yield* readProcessStartIdentity(process.pid, platform, command);
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
      const platform = platformOverride ?? (yield* HostProcess.Platform);
      const startTime = yield* readProcessStartIdentity(pid, platform, command).pipe(
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

const digest = Effect.fn("nativeClientBuildHost.digest")(function* (value: string) {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export const hashAndroidApk = <E, R>(input: {
  readonly host: string;
  readonly artifactPath: string;
  readonly command: NativeBuildCommand<E, R>;
}): Effect.Effect<string, NativeBuildErrors<E>, R | Crypto.Crypto> =>
  Effect.gen(function* () {
    const hashCommand =
      input.host === "darwin"
        ? { program: "shasum", args: ["-a", "256", input.artifactPath] }
        : input.host === "win32"
          ? {
              program: "powershell.exe",
              args: [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `(Get-FileHash -Algorithm SHA256 -LiteralPath '${input.artifactPath.replace(/'/g, "''")}').Hash`,
              ],
            }
          : input.host === "linux"
            ? { program: "sha256sum", args: ["-b", input.artifactPath] }
            : null;
    if (hashCommand === null)
      return yield* new NativeArtifactCache.NativeArtifactCacheError({
        message: `Android APK hashing is unsupported on ${input.host}.`,
      });

    const output = yield* input.command(hashCommand.program, hashCommand.args);
    const binaryHash = output.match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
    if (!binaryHash)
      return yield* new NativeArtifactCache.NativeArtifactCacheError({
        message: "Could not hash the built Android APK.",
      });
    return yield* digest(binaryHash);
  });
