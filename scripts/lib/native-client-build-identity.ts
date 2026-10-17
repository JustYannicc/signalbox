import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as NativeArtifactCache from "./native-artifact-cache.ts";
import * as NativeClientFingerprint from "./native-client-fingerprint.ts";
import type { NativeBuildCommand } from "./native-client-build-host.ts";

export const decodeExpoFingerprint = NativeClientFingerprint.decodeExpoFingerprint;
export type ExpoFingerprintSnapshot = NativeClientFingerprint.ExpoFingerprintSnapshot;

export type NativeDeviceTarget =
  | { readonly platform: "ios"; readonly runtime: string; readonly architecture: string }
  | { readonly platform: "android"; readonly abi: string; readonly apiLevel: string };

const readDirectoryOrEmpty = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readDirectory(directory).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([] as Array<string>),
    ),
  );
});

const resolveAndroidSdkRoot = (
  environment: Record<string, string | undefined>,
  platform: string,
  path: Path.Path,
) => {
  const configured = environment.ANDROID_HOME ?? environment.ANDROID_SDK_ROOT;
  if (configured) return configured;
  const home = environment.HOME ?? environment.USERPROFILE ?? "";
  if (platform === "darwin") return path.join(home, "Library/Android/sdk");
  if (platform === "win32") return path.join(environment.LOCALAPPDATA ?? home, "Android/Sdk");
  return path.join(home, "Android/Sdk");
};

/** Capture the complete build identity, keeping target and installed toolchain out of Expo's hash. */
export const nativeArtifactIdentity = <E, R>(input: {
  readonly snapshot: ExpoFingerprintSnapshot;
  readonly target: NativeDeviceTarget;
  readonly repositoryRoot: string;
  readonly command: NativeBuildCommand<E, R>;
}) =>
  Effect.gen(function* () {
    const environment = yield* HostProcess.Environment;
    const host = yield* HostProcess.Platform;
    const hostArchitecture = yield* HostProcess.Architecture;
    const path = yield* Path.Path;
    const mobile = path.join(input.repositoryRoot, "apps/mobile");
    const expoTemplateHash = yield* NativeArtifactCache.hashArtifact(
      path.join(mobile, "node_modules/expo/template.tgz"),
    );
    if (input.target.platform === "ios") {
      const xcode = yield* input.command("xcodebuild", ["-version"]);
      const simulatorSdk = yield* input.command("xcrun", [
        "--sdk",
        "iphonesimulator",
        "--show-sdk-version",
      ]);
      const cocoapods = yield* input.command("pod", ["--version"]);
      return {
        schemaVersion: 1,
        platform: "ios",
        fingerprint: input.snapshot.hash,
        expoPlatforms: ["ios"],
        sources: input.snapshot.sources,
        target: {
          runtime: input.target.runtime,
          architecture: input.target.architecture,
          scheme: "SignalboxDev",
          configuration: "Debug",
          sdk: "iphonesimulator",
        },
        toolchain: {
          host,
          hostArchitecture,
          node: process.version,
          expoTemplateHash,
          xcode,
          simulatorSdk,
          cocoapods,
        },
        artifactKind: "app",
      } satisfies NativeArtifactCache.NativeArtifactIdentity;
    }

    const java = environment.JAVA_HOME
      ? path.join(environment.JAVA_HOME, "bin", host === "win32" ? "java.exe" : "java")
      : "java";
    const javaVersion = yield* input.command(java, ["-version"], false, undefined, true);
    const sdkRoot = resolveAndroidSdkRoot(environment, host, path);
    const [buildTools, platforms, ndks] = yield* Effect.all([
      readDirectoryOrEmpty(path.join(sdkRoot, "build-tools")),
      readDirectoryOrEmpty(path.join(sdkRoot, "platforms")),
      readDirectoryOrEmpty(path.join(sdkRoot, "ndk")),
    ]);
    return {
      schemaVersion: 1,
      platform: "android",
      fingerprint: input.snapshot.hash,
      expoPlatforms: ["android"],
      sources: input.snapshot.sources,
      target: {
        abi: input.target.abi,
        apiLevel: input.target.apiLevel,
        variant: "debug",
        appId: "com.justyannicc.signalbox.dev",
      },
      toolchain: {
        host,
        hostArchitecture,
        node: process.version,
        expoTemplateHash,
        javaVersion,
        androidSdkBuildTools: buildTools.sort(),
        androidSdkPlatforms: platforms.sort(),
        androidNdkVersions: ndks.sort(),
      },
      artifactKind: "apk",
    } satisfies NativeArtifactCache.NativeArtifactIdentity;
  });
