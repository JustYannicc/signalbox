import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as NativeArtifactLock from "./native-artifact-lock.ts";

const NativePlatform = Schema.Literals(["ios", "android"]);
const NativeArtifactKind = Schema.Literals(["app", "apk"]);
const ExpoSource = Schema.Struct({
  type: Schema.String,
  filePath: Schema.String,
  reasons: Schema.Array(Schema.String),
  hash: Schema.String,
  overrideHashKey: Schema.optional(Schema.String),
});
const NativeArtifactIdentitySchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  platform: NativePlatform,
  fingerprint: Schema.String,
  expoPlatforms: Schema.Array(NativePlatform),
  target: Schema.Record(Schema.String, Schema.String),
  toolchain: Schema.Record(Schema.String, Schema.Unknown),
  sources: Schema.Array(ExpoSource),
  artifactKind: NativeArtifactKind,
});
export type NativeArtifactIdentity = typeof NativeArtifactIdentitySchema.Type;
export type NativeArtifactSource = typeof ExpoSource.Type;

const NativeArtifactManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  cacheKey: Schema.String,
  identity: NativeArtifactIdentitySchema,
  artifactName: Schema.String,
  artifactHash: Schema.String,
  verifiedBinaryHash: Schema.String,
});
const NativeArtifactManifestEnvelope = Schema.Struct({
  manifest: NativeArtifactManifest,
  manifestDigest: Schema.String,
});
const encodeManifestEnvelope = Schema.encodeEffect(
  Schema.fromJsonString(NativeArtifactManifestEnvelope),
);
const decodeManifestEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(NativeArtifactManifestEnvelope),
);
const isNotLink = Schema.is(Schema.Struct({ code: Schema.Literal("EINVAL") }));

export class NativeArtifactCacheError extends Schema.TaggedError<NativeArtifactCacheError>()(
  "NativeArtifactCacheError",
  { message: Schema.String },
) {}

export interface EnsureNativeArtifactOptions<E, R, EBuild> {
  readonly cacheRoot: string;
  readonly identity: NativeArtifactIdentity;
  readonly currentIdentity: () => Effect.Effect<NativeArtifactIdentity, E, R>;
  readonly process: NativeArtifactLock.ProcessIdentityProbe<E, R>;
  readonly build: (artifactPath: string) => Effect.Effect<void, EBuild, R>;
  readonly install: (artifactPath: string) => Effect.Effect<void, E, R>;
  readonly installedBinary: () => Effect.Effect<string | null, E, R>;
  readonly expectedInstalledBinary: (artifactPath: string) => Effect.Effect<string, E, R>;
  readonly waitForLock?: () => Effect.Effect<void, E, R>;
}

export interface EnsureNativeArtifactResult {
  readonly artifactPath: string;
  readonly artifactHash: string;
  readonly verifiedBinaryHash: string;
  readonly built: boolean;
  readonly cacheHit: boolean;
}

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
};

const canonicalJson = (value: unknown) => JSON.stringify(canonicalValue(value));

const cacheKeyMaterial = (identity: NativeArtifactIdentity) => ({
  schemaVersion: identity.schemaVersion,
  platform: identity.platform,
  fingerprint: identity.fingerprint,
  expoPlatforms: identity.expoPlatforms,
  target: identity.target,
  toolchain: identity.toolchain,
  sources: sortedSources(identity),
  artifactKind: identity.artifactKind,
});

const sortedSources = (identity: NativeArtifactIdentity) =>
  [...identity.sources].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right), "en"),
  );

const sameIdentity = (left: NativeArtifactIdentity, right: NativeArtifactIdentity) =>
  canonicalJson(cacheKeyMaterial(left)) === canonicalJson(cacheKeyMaterial(right)) &&
  canonicalJson(sortedSources(left)) === canonicalJson(sortedSources(right));

const digest = Effect.fn("nativeArtifact.digest")(function* (value: string | Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.digest(
    "SHA-256",
    typeof value === "string" ? new TextEncoder().encode(value) : value,
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export const nativeArtifactCacheKey = Effect.fn("nativeArtifact.cacheKey")(function* (
  identity: NativeArtifactIdentity,
) {
  return yield* digest(canonicalJson(cacheKeyMaterial(identity)));
});

const hashFile = Effect.fn("nativeArtifact.hashFile")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const chunks = yield* fs.stream(filePath, { chunkSize: 65536 }).pipe(
    Stream.mapEffect((chunk) => digest(chunk)),
    Stream.runCollect,
  );
  return yield* digest(chunks.join("\n"));
});

/** Hash an app bundle or APK without reading its full contents into memory. */
export const hashArtifact = Effect.fn("nativeArtifact.hashArtifact")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.stat(root);
  if (info.type !== "Directory") return yield* hashFile(root);

  const entries: Array<string> = [];
  const visit = (
    relative: string,
  ): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Crypto.Crypto> =>
    Effect.gen(function* () {
      const names = (yield* fs.readDirectory(path.join(root, relative))).sort((a, b) =>
        a.localeCompare(b, "en"),
      );
      for (const name of names) {
        const key = path.join(relative, name);
        const absolute = path.join(root, key);
        const link = yield* fs.readLink(absolute).pipe(
          Effect.catchIf(
            (error) => isNotLink(error.reason.cause),
            () => Effect.succeed(null),
          ),
        );
        if (link !== null) {
          entries.push(`link:${key}:${link}`);
          continue;
        }
        const child = yield* fs.stat(absolute);
        if (child.type === "Directory") {
          entries.push(`directory:${key}`);
          yield* visit(key);
        } else {
          entries.push(`file:${key}:${yield* hashFile(absolute)}`);
        }
      }
    });
  yield* visit("");
  return yield* digest(entries.map((entry) => `${entry.length}:${entry}`).join(""));
});

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const artifactName = (identity: NativeArtifactIdentity) =>
  identity.artifactKind === "app" ? "SignalboxDev.app" : "SignalboxDev.apk";

const readValidManifest = <E, R>(input: {
  readonly entryPath: string;
  readonly cacheKey: string;
  readonly identity: NativeArtifactIdentity;
  readonly expectedInstalledBinary: EnsureNativeArtifactOptions<
    E,
    R,
    unknown
  >["expectedInstalledBinary"];
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestPath = path.join(input.entryPath, "manifest.json");
    const text = yield* fs
      .readFileString(manifestPath)
      .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(null)));
    if (text === null) return null;
    const parsed = yield* decodeManifestEnvelope(text).pipe(Effect.result);
    if (parsed._tag === "Failure") return null;
    const manifest = parsed.success.manifest;
    if (
      manifest.cacheKey !== input.cacheKey ||
      !sameIdentity(manifest.identity, input.identity) ||
      manifest.artifactName !== artifactName(input.identity)
    ) {
      return null;
    }
    if ((yield* digest(canonicalJson(manifest))) !== parsed.success.manifestDigest) return null;

    const artifactPath = path.join(input.entryPath, manifest.artifactName);
    const exists = yield* fs.exists(artifactPath);
    if (!exists) return null;
    const stat = yield* fs.stat(artifactPath);
    if (input.identity.artifactKind === "app" ? stat.type !== "Directory" : stat.type !== "File")
      return null;
    const actualHash = yield* hashArtifact(artifactPath).pipe(Effect.result);
    if (actualHash._tag === "Failure" || actualHash.success !== manifest.artifactHash) return null;
    const expectedHash = yield* input.expectedInstalledBinary(artifactPath).pipe(Effect.result);
    if (expectedHash._tag === "Failure" || expectedHash.success !== manifest.verifiedBinaryHash) {
      return null;
    }
    return {
      artifactPath,
      artifactHash: manifest.artifactHash,
      verifiedBinaryHash: manifest.verifiedBinaryHash,
    } satisfies Omit<EnsureNativeArtifactResult, "built" | "cacheHit">;
  });

export const ensureNativeArtifact = <E, R, EBuild>(
  options: EnsureNativeArtifactOptions<E, R, EBuild>,
): Effect.Effect<
  EnsureNativeArtifactResult,
  | E
  | EBuild
  | NativeArtifactCacheError
  | NativeArtifactLock.NativeArtifactLockError
  | PlatformError.PlatformError,
  R | FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const identity = options.identity;
    if (
      identity.platform !== (identity.artifactKind === "app" ? "ios" : "android") ||
      identity.expoPlatforms.length !== 1 ||
      identity.expoPlatforms[0] !== identity.platform
    ) {
      return yield* new NativeArtifactCacheError({
        message: "Native cache identity does not match its Expo platform or artifact type.",
      });
    }

    const cacheKey = yield* nativeArtifactCacheKey(identity);
    const entryPath = path.join(options.cacheRoot, identity.platform, cacheKey);
    const lockPath = path.join(options.cacheRoot, "locks", identity.platform, `${cacheKey}.lock`);
    const verifyInputs = Effect.gen(function* () {
      const current = yield* options.currentIdentity();
      if (!sameIdentity(current, identity)) {
        return yield* new NativeArtifactCacheError({
          message:
            "Native inputs or toolchain changed during ensure; this artifact was not installed or recorded.",
        });
      }
    });

    yield* verifyInputs;
    const selected = yield* NativeArtifactLock.withNativeArtifactLock(
      {
        lockPath,
        process: options.process,
        ...(options.waitForLock ? { wait: options.waitForLock } : {}),
      },
      Effect.gen(function* () {
        yield* verifyInputs;
        const cached = yield* readValidManifest({
          entryPath,
          cacheKey,
          identity,
          expectedInstalledBinary: options.expectedInstalledBinary,
        });
        if (cached !== null) return { ...cached, built: false, cacheHit: true };

        if (yield* fs.exists(entryPath))
          yield* fs.remove(entryPath, { recursive: true, force: true });
        yield* fs.makeDirectory(options.cacheRoot, { recursive: true });
        const stageRoot = yield* fs.makeTempDirectory({
          directory: options.cacheRoot,
          prefix: `.staging-${cacheKey}-`,
        });
        const stageArtifact = path.join(stageRoot, artifactName(identity));
        const publish = Effect.gen(function* () {
          yield* verifyInputs;
          yield* options.build(stageArtifact);
          yield* verifyInputs;
          if (!(yield* fs.exists(stageArtifact))) {
            return yield* new NativeArtifactCacheError({
              message: "Native build completed without producing its expected artifact.",
            });
          }
          const stat = yield* fs.stat(stageArtifact);
          if (identity.artifactKind === "app" ? stat.type !== "Directory" : stat.type !== "File") {
            return yield* new NativeArtifactCacheError({
              message: "Native build produced an artifact with the wrong type.",
            });
          }

          const artifactHash = yield* hashArtifact(stageArtifact);
          const verifiedBinaryHash = yield* options.expectedInstalledBinary(stageArtifact);
          yield* verifyInputs;
          const manifest = {
            schemaVersion: 1 as const,
            cacheKey,
            identity,
            artifactName: artifactName(identity),
            artifactHash,
            verifiedBinaryHash,
          };
          const envelope = yield* encodeManifestEnvelope({
            manifest,
            manifestDigest: yield* digest(canonicalJson(manifest)),
          }).pipe(
            Effect.catchTags({
              SchemaError: () =>
                Effect.fail(
                  new NativeArtifactCacheError({
                    message: "Could not encode native cache metadata.",
                  }),
                ),
            }),
          );
          yield* fs.writeFileString(path.join(stageRoot, "manifest.json"), envelope);
          yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
          yield* verifyInputs;
          yield* fs.rename(stageRoot, entryPath);
          return {
            artifactPath: path.join(entryPath, manifest.artifactName),
            artifactHash,
            verifiedBinaryHash,
            built: true,
            cacheHit: false,
          } satisfies EnsureNativeArtifactResult;
        }).pipe(
          Effect.ensuring(
            fs.remove(stageRoot, { recursive: true, force: true }).pipe(Effect.ignore),
          ),
        );
        return yield* publish;
      }),
    );

    yield* verifyInputs;
    yield* options.install(selected.artifactPath);
    const installed = yield* options.installedBinary();
    if (installed === null || installed !== selected.verifiedBinaryHash) {
      return yield* new NativeArtifactCacheError({
        message: "Installed native client does not match the verified cached artifact.",
      });
    }
    yield* verifyInputs;
    return selected;
  });
