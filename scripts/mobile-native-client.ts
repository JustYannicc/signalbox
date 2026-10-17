import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NativeArtifactCache from "./lib/native-artifact-cache.ts";
import * as NativeClientArtifactBuilder from "./lib/native-client-artifact-builder.ts";
import * as NativeClientBuildIdentity from "./lib/native-client-build-identity.ts";

export type NativePlatform = "ios" | "android";
const NativeClientRecord = Schema.Struct({
  fingerprint: Schema.String,
  cacheKey: Schema.String,
  binary: Schema.String,
});
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(NativeClientRecord));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeClientRecord));
const encodeOutput = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSimulators = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      devices: Schema.Record(
        Schema.String,
        Schema.Array(Schema.Struct({ udid: Schema.String, state: Schema.String })),
      ),
    }),
  ),
);
export type NativeClientRecord = typeof NativeClientRecord.Type;
export type NativeClientStatus = "compatible" | "missing" | "unknown" | "stale";
export interface NativeClientAssessment {
  readonly status: NativeClientStatus;
  readonly reason: string | null;
}
interface NativeClientBuildContext {
  readonly identity: NativeArtifactCache.NativeArtifactIdentity;
  readonly cacheKey: string;
}
export class NativeClientError extends Schema.TaggedError<NativeClientError>()(
  "NativeClientError",
  { message: Schema.String },
) {}

export function clientStatus(
  fingerprint: string,
  binary: string | null,
  record: NativeClientRecord | null,
  cacheKey: string,
): NativeClientAssessment {
  if (binary === null) return { status: "missing", reason: "installed binary is missing" };
  if (!record) return { status: "unknown", reason: "no verified per-device build record" };
  if (record.binary !== binary)
    return { status: "unknown", reason: "installed binary differs from the verified build" };
  if (record.fingerprint !== fingerprint)
    return { status: "stale", reason: "Expo native fingerprint changed" };
  if (record.cacheKey !== cacheKey)
    return { status: "stale", reason: "native source or toolchain identity changed" };
  return { status: "compatible", reason: null };
}

/** Keep Expo inputs stable during build, installation, and record publication. */
export const ensureClient = Effect.fn("ensureClient")(function* <
  E,
  R,
  E2,
  R2,
  EBuild,
  RBuild,
>(operations: {
  buildContext: Effect.Effect<NativeClientBuildContext, E, R>;
  currentBuildContext: () => Effect.Effect<NativeClientBuildContext, E, R>;
  installedBinary: Effect.Effect<string | null, E, R>;
  readRecord: Effect.Effect<NativeClientRecord | null, E, R>;
  buildAndInstall: (
    context: NativeClientBuildContext,
  ) => Effect.Effect<{ binary: string; built: boolean; cacheHit: boolean }, EBuild, RBuild>;
  saveRecord: (record: NativeClientRecord) => Effect.Effect<void, E2, R2>;
}) {
  const context = yield* operations.buildContext;
  const fingerprint = context.identity.fingerprint;
  const assessment = clientStatus(
    fingerprint,
    yield* operations.installedBinary,
    yield* operations.readRecord,
    context.cacheKey,
  );
  const verifyInputs = Effect.gen(function* () {
    if ((yield* operations.currentBuildContext()).cacheKey !== context.cacheKey) {
      return yield* new NativeClientError({
        message: "Native source or toolchain changed during ensure; this build was not recorded.",
      });
    }
  });
  yield* verifyInputs;
  if (assessment.status === "compatible") {
    return {
      status: assessment.status,
      reason: assessment.reason,
      rebuilt: false,
      cacheHit: false,
      fingerprint,
    };
  }
  const build = yield* operations.buildAndInstall(context);
  const binary = yield* operations.installedBinary;
  if (binary === null || binary !== build.binary)
    return yield* new NativeClientError({
      message: "Installed development client does not match the verified native artifact.",
    });
  yield* verifyInputs;
  yield* operations.saveRecord({ fingerprint, cacheKey: context.cacheKey, binary });
  return {
    status: "compatible" as const,
    reason: assessment.reason,
    rebuilt: build.built,
    cacheHit: build.cacheHit,
    fingerprint,
  };
});

const digest = Effect.fn("nativeClient.digest")(function* (value: string | Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.digest(
    "SHA-256",
    typeof value === "string" ? new TextEncoder().encode(value) : value,
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export const hashBundle = NativeArtifactCache.hashArtifact;

const bundleId = "com.justyannicc.signalbox.dev";
const roots = Effect.gen(function* () {
  const path = yield* Path.Path;
  const repo = yield* path.fromFileUrl(new URL("../", import.meta.url));
  return { repo, mobile: path.join(repo, "apps/mobile") };
});
const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (a, b) => a + b,
    ),
  );
export const resolveAdb = Effect.gen(function* () {
  if (yield* isCommandAvailable("adb")) return "adb";
  const environment = yield* HostProcess.Environment;
  const path = yield* Path.Path;
  const executable = (yield* HostProcess.Platform) === "win32" ? "adb.exe" : "adb";
  for (const sdk of [environment.ANDROID_SDK_ROOT, environment.ANDROID_HOME]) {
    if (!sdk) continue;
    const candidate = path.join(sdk, "platform-tools", executable);
    if (yield* isCommandAvailable(candidate)) return candidate;
  }
  return yield* new NativeClientError({
    message:
      "adb was not found on PATH or in ANDROID_SDK_ROOT/ANDROID_HOME. Install Android SDK platform-tools.",
  });
});

const command = Effect.fn("nativeClient.command")(function* (
  program: string,
  args: string[],
  inherit = false,
  cwd?: string,
  includeStderr = false,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcess.Environment;
  const spawn = yield* resolveSpawnCommand(program === "adb" ? yield* resolveAdb : program, args);
  const child = yield* spawner.spawn(
    ChildProcess.make(spawn.command, spawn.args, {
      shell: spawn.shell,
      cwd: cwd ?? (yield* roots).mobile,
      env: {
        ...environment,
        APP_VARIANT: "development",
        MOBILE_VERSION_POLICY: "appVersion",
        T3CODE_IOS_PERSONAL_TEAM: "0",
        CI: "1",
        EXPO_NO_GIT_STATUS: "1",
      },
      stdin: "ignore",
      stdout: inherit ? "inherit" : "pipe",
      stderr: inherit ? "inherit" : "pipe",
    }),
  );
  const [stdout, stderr, code] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode],
    { concurrency: "unbounded" },
  );
  if (code !== 0)
    return yield* new NativeClientError({
      message: `${program} ${args[0]} failed (${code}): ${stderr || "see build output"}`,
    });
  return (includeStderr ? `${stdout}\n${stderr}` : stdout).trim();
}, Effect.scoped);

const fingerprint = Effect.fn("nativeClient.fingerprint")(function* (platform: NativePlatform) {
  const output = yield* command(yield* HostProcess.ExecutablePath, [
    "--eval",
    `require('expo/fingerprint').createFingerprintAsync(process.cwd(), { platforms: [process.argv[1]], silent: true }).then(fp => console.log('T3_NATIVE_FINGERPRINT=' + JSON.stringify({ hash: fp.hash, sources: fp.sources.map(({ type, filePath, reasons, hash, overrideHashKey }) => ({ type, filePath, reasons, hash, overrideHashKey })) }))).catch(e => { console.error(e); process.exitCode = 1; });`,
    platform,
  ]);
  const serialized = output
    .split("\n")
    .find((line) => line.startsWith("T3_NATIVE_FINGERPRINT="))
    ?.slice("T3_NATIVE_FINGERPRINT=".length);
  const snapshot = yield* NativeClientBuildIdentity.decodeExpoFingerprint(serialized ?? "").pipe(
    Effect.catchTags({
      SchemaError: () =>
        Effect.fail(
          new NativeClientError({ message: "Expo did not return native input sources." }),
        ),
    }),
  );
  if (!/^[a-f0-9]{40,64}$/.test(snapshot.hash))
    return yield* new NativeClientError({ message: "Expo did not return a native fingerprint." });
  return snapshot;
});

const validateDevice = Effect.fn("nativeClient.validateDevice")(function* (
  platform: NativePlatform,
  device: string,
) {
  if (platform === "ios") {
    if ((yield* HostProcess.Platform) !== "darwin")
      return yield* new NativeClientError({
        message: "Run iOS check/ensure on the Mac that hosts the simulator.",
      });
    const listing = yield* decodeSimulators(
      yield* command("xcrun", ["simctl", "list", "devices", "available", "--json"]),
    );
    const match = Object.entries(listing.devices)
      .flatMap(([runtime, devices]) => devices.map((entry) => ({ runtime, entry })))
      .find(({ entry }) => entry.udid === device);
    if (!match)
      return yield* new NativeClientError({
        message: `No available iOS simulator with UDID ${device}.`,
      });
    if (match.entry.state !== "Booted")
      return yield* new NativeClientError({
        message: `Boot the selected simulator first: xcrun simctl boot ${device}`,
      });
    const architecture = (yield* HostProcess.Architecture) === "arm64" ? "arm64" : "x86_64";
    return { platform, runtime: match.runtime, architecture };
  } else {
    if ((yield* command("adb", ["-s", device, "get-state"])) !== "device")
      return yield* new NativeClientError({ message: "Android device is not connected." });
    if ((yield* command("adb", ["-s", device, "shell", "getprop", "ro.kernel.qemu"])) !== "1")
      return yield* new NativeClientError({
        message: "Select an Android emulator, not a physical device.",
      });
    const abi = yield* command("adb", ["-s", device, "shell", "getprop", "ro.product.cpu.abi"]);
    if (!["arm64-v8a", "x86_64", "x86", "armeabi-v7a"].includes(abi))
      return yield* new NativeClientError({
        message: `Android emulator ABI '${abi || "unknown"}' is not supported for a cached development client.`,
      });
    const apiLevel = yield* command("adb", [
      "-s",
      device,
      "shell",
      "getprop",
      "ro.build.version.sdk",
    ]);
    if (!/^\d+$/.test(apiLevel))
      return yield* new NativeClientError({
        message: "Could not determine the Android emulator API level.",
      });
    return { platform, abi, apiLevel };
  }
});

export const installedBinary = Effect.fn("installedBinary")(function* (
  platform: NativePlatform,
  device: string,
  run: typeof command = command,
) {
  if (platform === "ios") {
    const apps = yield* run("xcrun", ["simctl", "listapps", device]);
    if (!apps.includes(`"${bundleId}"`)) return null;
    return yield* hashBundle(
      yield* run("xcrun", ["simctl", "get_app_container", device, bundleId, "app"]),
    );
  }
  const installed = yield* run("adb", ["-s", device, "shell", "pm", "list", "packages", bundleId]);
  if (!installed.split("\n").some((line) => line.trim() === `package:${bundleId}`)) return null;
  const packages = yield* run("adb", ["-s", device, "shell", "pm", "path", bundleId]);
  const apks = packages
    .split("\n")
    .filter((line) => line.startsWith("package:"))
    .map((line) => line.slice(8).trim())
    .sort();
  if (apks.length === 0) return null;
  const hashes = yield* Effect.forEach(apks, (apk) =>
    Effect.gen(function* () {
      if (!/^\/[\w/+=.~-]+\.apk$/.test(apk))
        return yield* new NativeClientError({ message: "Unexpected installed APK path." });
      const hash = (yield* run("adb", ["-s", device, "shell", "sha256sum", apk])).split(/\s/)[0];
      if (!hash || !/^[a-f0-9]{64}$/.test(hash))
        return yield* new NativeClientError({ message: "Could not hash installed APK." });
      return hash;
    }),
  );
  return yield* digest(hashes.sort().join("\n"));
});

const main = Command.make(
  "mobile-native-client",
  {
    mode: Argument.Literals("mode", ["check", "ensure"]),
    platform: Argument.Literals("platform", ["ios", "android"]),
    device: Argument.String("device"),
  },
  Effect.fn("nativeClient.main")(function* ({ mode, platform, device }) {
    const target = yield* validateDevice(platform, device);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcess.Environment;
    const home = environment.HOME ?? environment.USERPROFILE;
    if (!home)
      return yield* new NativeClientError({
        message: "HOME or USERPROFILE must be set to store native client records.",
      });
    const recordPath = path.join(
      home,
      ".cache/t3code/native-clients",
      platform,
      `${yield* digest(device)}.json`,
    );
    const readBuildContext = () =>
      Effect.gen(function* () {
        const { repo } = yield* roots;
        const snapshot = yield* fingerprint(platform);
        const identity = yield* NativeClientBuildIdentity.nativeArtifactIdentity({
          snapshot,
          target,
          repositoryRoot: repo,
          command,
        });
        const cacheKey = yield* NativeArtifactCache.nativeArtifactCacheKey(identity);
        return { identity, cacheKey } satisfies NativeClientBuildContext;
      });
    const operations = {
      buildContext: readBuildContext(),
      currentBuildContext: readBuildContext,
      installedBinary: installedBinary(platform, device),
      readRecord: fs.readFileString(recordPath).pipe(
        Effect.flatMap(decodeRecord),
        Effect.catchTags({ SchemaError: () => Effect.succeed(null) }),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      ),
      buildAndInstall: (context: NativeClientBuildContext) =>
        Effect.gen(function* () {
          const { mobile, repo } = yield* roots;
          const result = yield* NativeClientArtifactBuilder.ensureNativeClientArtifact({
            cacheRoot: path.join(home, ".cache/t3code/native-clients/builds"),
            platform,
            device,
            target,
            identity: context.identity,
            repositoryRoot: repo,
            mobileRoot: mobile,
            command,
            currentIdentity: () => Effect.map(readBuildContext(), (current) => current.identity),
            installedBinary: () => installedBinary(platform, device),
          });
          yield* Console.error(
            result.cacheHit
              ? "Reused a verified native development client build."
              : "Published the native development client build to the shared cache.",
          );
          return result;
        }),
      saveRecord: Effect.fn(function* (record: NativeClientRecord) {
        yield* fs.makeDirectory(path.dirname(recordPath), { recursive: true });
        yield* fs.writeFileString(recordPath, yield* encodeRecord(record));
      }),
    };
    if (mode === "ensure") {
      yield* Console.log(yield* encodeOutput(yield* ensureClient(operations)));
    } else {
      const context = yield* operations.buildContext;
      const assessment = clientStatus(
        context.identity.fingerprint,
        yield* operations.installedBinary,
        yield* operations.readRecord,
        context.cacheKey,
      );
      yield* Console.log(
        yield* encodeOutput({
          status: assessment.status,
          reason: assessment.reason,
          fingerprint: context.identity.fingerprint,
          compatibility: {
            platform: context.identity.platform,
            target: context.identity.target,
            toolchain: context.identity.toolchain,
          },
          next:
            assessment.status === "compatible"
              ? "Start Metro with vp run dev:client"
              : `node scripts/mobile-native-client.ts ensure ${platform} ${device}`,
        }),
      );
      process.exitCode = assessment.status === "compatible" ? 0 : 2;
    }
  }),
);

if (import.meta.main) {
  Command.run(main, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
