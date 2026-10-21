import { Schema } from "effect";

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ManifestPath = Schema.Literals([
  "codex/manifest.json",
  "cli/manifest.json",
  "sdk/manifest.json",
]);

const ComponentManifest = Schema.Struct({ manifest: ManifestPath }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
const Components = Schema.Struct({
  codex: Schema.optionalKey(ComponentManifest),
  cli: Schema.optionalKey(ComponentManifest),
  sdk: Schema.optionalKey(ComponentManifest),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const File = Schema.Struct({
  bytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  sha256: Sha256,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export const HarnessReleaseArtifactManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  harness: Schema.Literals(["codex", "claude-code"]),
  sourceIdentity: Sha256,
  components: Components,
  files: Schema.Record(Schema.String, File),
  computer: Schema.Struct({ sourceIdentity: Sha256, manifestSha256: Sha256 }).annotate({
    parseOptions: { onExcessProperty: "error" },
  }),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export type HarnessReleaseArtifactManifest = typeof HarnessReleaseArtifactManifestSchema.Type;
export type ArtifactComponent = "codex" | "cli" | "sdk";

const decodeArtifactManifest = Schema.decodeUnknownSync(HarnessReleaseArtifactManifestSchema, {
  onExcessProperty: "error",
  reportInput: false,
});
const decodeArtifactManifestJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(HarnessReleaseArtifactManifestSchema),
  { onExcessProperty: "error", reportInput: false },
);
const HarnessReleaseArtifactIdentitySchema = Schema.Struct({
  artifactRef: Schema.String,
  artifactHash: Sha256,
  sourceIdentity: Sha256,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const decodeArtifactIdentity = Schema.decodeUnknownSync(HarnessReleaseArtifactIdentitySchema, {
  onExcessProperty: "error",
  reportInput: false,
});
const RawProviderManifestSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeRawProviderManifestRecord = Schema.decodeUnknownSync(RawProviderManifestSchema, {
  reportInput: false,
});

export type HarnessReleaseArtifactErrorCode =
  | "INVALID_IDENTITY"
  | "ARTIFACT_REF_MISMATCH"
  | "MANIFEST_HASH_MISMATCH"
  | "MANIFEST_INVALID_UTF8"
  | "MANIFEST_INVALID"
  | "NON_CANONICAL_MANIFEST"
  | "SOURCE_IDENTITY_MISMATCH"
  | "INVALID_COMPONENTS"
  | "UNSAFE_PATH"
  | "MISSING_COMPONENT_MANIFEST"
  | "RAW_MANIFEST_SIZE_MISMATCH"
  | "RAW_MANIFEST_HASH_MISMATCH"
  | "RAW_MANIFEST_INVALID_UTF8"
  | "RAW_MANIFEST_INVALID_JSON"
  | "RAW_MANIFEST_NOT_OBJECT"
  | "FILE_NOT_DECLARED"
  | "FILE_SIZE_MISMATCH"
  | "FILE_HASH_MISMATCH"
  | "SOURCE_RETURNED_INVALID_BYTES";

export class HarnessReleaseArtifactError extends Error {
  readonly code: HarnessReleaseArtifactErrorCode;

  constructor(code: HarnessReleaseArtifactErrorCode) {
    super(`Harness release artifact validation failed: ${code}`);
    this.name = "HarnessReleaseArtifactError";
    this.code = code;
  }
}

export const failArtifact = (code: HarnessReleaseArtifactErrorCode): never => {
  throw new HarnessReleaseArtifactError(code);
};

export const decodeHarnessReleaseArtifactManifest = (
  input: unknown,
): HarnessReleaseArtifactManifest => {
  try {
    return decodeArtifactManifest(input);
  } catch {
    return failArtifact("MANIFEST_INVALID");
  }
};

export const decodeHarnessReleaseArtifactIdentity = (input: unknown) => {
  try {
    return decodeArtifactIdentity(input);
  } catch {
    return failArtifact("INVALID_IDENTITY");
  }
};

export const validateHarnessReleaseArtifactManifest = (
  manifest: HarnessReleaseArtifactManifest,
): void => {
  const { codex, cli, sdk } = manifest.components;
  if (
    (manifest.harness === "codex" && (!codex || cli || sdk)) ||
    (manifest.harness === "claude-code" && (codex || !cli || !sdk))
  ) {
    failArtifact("INVALID_COMPONENTS");
  }

  const activeComponents = new Set<ArtifactComponent>(
    manifest.harness === "codex" ? ["codex"] : ["cli", "sdk"],
  );
  for (const path of Object.keys(manifest.files)) {
    const parts = path.split("/");
    const component = parts[0];
    if (
      parts.length < 2 ||
      !activeComponents.has(component as ArtifactComponent) ||
      parts.some((part) => part === "" || part === "." || part === "..") ||
      path.includes("\\") ||
      hasControlCharacters(path)
    ) {
      failArtifact("UNSAFE_PATH");
    }
  }

  const componentManifests =
    manifest.harness === "codex"
      ? ([["codex", codex]] as const)
      : ([
          ["cli", cli],
          ["sdk", sdk],
        ] as const);
  for (const [name, component] of componentManifests) {
    const entry = component ?? failArtifact("INVALID_COMPONENTS");
    if (entry.manifest !== `${name}/manifest.json`) failArtifact("INVALID_COMPONENTS");
    if (manifest.files[entry.manifest] === undefined) {
      failArtifact("MISSING_COMPONENT_MANIFEST");
    }
  }
};

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return failArtifact("MANIFEST_INVALID");
  return serialized;
};

const hasControlCharacters = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

export const serializeHarnessReleaseArtifactManifest = (input: unknown): Uint8Array => {
  const manifest = decodeHarnessReleaseArtifactManifest(input);
  validateHarnessReleaseArtifactManifest(manifest);
  return new TextEncoder().encode(canonicalJson(manifest));
};

export const decodeCanonicalManifestBytes = async (
  bytes: Uint8Array<ArrayBuffer>,
  artifactHash: string,
): Promise<HarnessReleaseArtifactManifest> => {
  if ((await sha256Hex(bytes)) !== artifactHash) failArtifact("MANIFEST_HASH_MISMATCH");

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failArtifact("MANIFEST_INVALID_UTF8");
  }

  let manifest: HarnessReleaseArtifactManifest;
  try {
    manifest = decodeArtifactManifestJson(text);
  } catch {
    return failArtifact("MANIFEST_INVALID");
  }

  const canonicalBytes = new TextEncoder().encode(canonicalJson(manifest));
  if (
    canonicalBytes.byteLength !== bytes.byteLength ||
    canonicalBytes.some((byte, index) => byte !== bytes[index])
  ) {
    failArtifact("NON_CANONICAL_MANIFEST");
  }
  validateHarnessReleaseArtifactManifest(manifest);
  return manifest;
};

export const decodeRawProviderManifest = (bytes: Uint8Array) => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failArtifact("RAW_MANIFEST_INVALID_UTF8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failArtifact("RAW_MANIFEST_INVALID_JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failArtifact("RAW_MANIFEST_NOT_OBJECT");
  }

  try {
    return decodeRawProviderManifestRecord(parsed);
  } catch {
    return failArtifact("RAW_MANIFEST_NOT_OBJECT");
  }
};

export const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const copyBytes = (bytes: unknown) => {
  if (!(bytes instanceof Uint8Array)) return failArtifact("SOURCE_RETURNED_INVALID_BYTES");
  return Uint8Array.from(bytes);
};

export type DeepReadonly<T> = T extends readonly (infer Value)[]
  ? readonly DeepReadonly<Value>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export const deepFreeze = <Value>(value: Value): DeepReadonly<Value> => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
};
