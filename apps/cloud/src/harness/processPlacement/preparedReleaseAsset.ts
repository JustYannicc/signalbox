export type HarnessProcessModuleType = "js" | "cjs" | "text" | "wasm";

export interface HarnessProcessPreparedReleaseAsset {
  readonly artifactRef: string;
  readonly moduleKey: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly type: HarnessProcessModuleType;
}

export interface HarnessProcessPreparedRelease {
  readonly artifact: { readonly artifactRef: string };
  readonly plan: {
    readonly preparedModules: Readonly<
      Record<
        string,
        {
          readonly path: string;
          readonly bytes: number;
          readonly sha256: string;
          readonly type: HarnessProcessModuleType;
        }
      >
    >;
  };
}

export interface HarnessProcessPreparedReleaseAssetModule {
  readonly preparedReleaseAsset: HarnessProcessPreparedReleaseAsset;
}

export type MaterializedHarnessProcessFacetModule =
  | string
  | { readonly js: string }
  | { readonly cjs: string }
  | { readonly text: string }
  | { readonly wasm: ArrayBuffer };

export type HarnessProcessReleaseAssetChunkReader = (
  artifactRef: string,
  path: string,
  offset: number,
  length: number,
) => Promise<Uint8Array>;

export const HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES = 8 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function snapshotPreparedReleaseAsset(
  value: unknown,
): HarnessProcessPreparedReleaseAsset | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 6 ||
      keys.some(
        (key) =>
          key !== "artifactRef" &&
          key !== "moduleKey" &&
          key !== "path" &&
          key !== "bytes" &&
          key !== "sha256" &&
          key !== "type",
      )
    )
      return undefined;
    if (
      typeof value.artifactRef !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.artifactRef) ||
      typeof value.moduleKey !== "string" ||
      value.moduleKey.length === 0 ||
      value.moduleKey.length > 512 ||
      typeof value.path !== "string" ||
      value.path.length === 0 ||
      value.path.length > 512 ||
      !Number.isSafeInteger(value.bytes) ||
      (value.bytes as number) < 0 ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.sha256) ||
      (value.type !== "js" &&
        value.type !== "cjs" &&
        value.type !== "text" &&
        value.type !== "wasm")
    )
      return undefined;
    return Object.freeze({
      artifactRef: value.artifactRef,
      moduleKey: value.moduleKey,
      path: value.path,
      bytes: value.bytes as number,
      sha256: value.sha256,
      type: value.type,
    });
  } catch {
    return undefined;
  }
}

export function preparedReleaseAsset(
  release: HarnessProcessPreparedRelease,
  moduleKey: string,
): HarnessProcessPreparedReleaseAssetModule {
  const module = release.plan.preparedModules[moduleKey];
  if (
    module === undefined ||
    (module.type !== "js" &&
      module.type !== "cjs" &&
      module.type !== "text" &&
      module.type !== "wasm")
  )
    throw new TypeError(
      "A process facet asset must identify a prepared JavaScript, text, or Wasm module.",
    );
  const descriptor = snapshotPreparedReleaseAsset({
    artifactRef: release.artifact.artifactRef,
    moduleKey,
    path: module.path,
    bytes: module.bytes,
    sha256: module.sha256,
    type: module.type,
  });
  if (descriptor === undefined) throw new TypeError("The prepared release module is invalid.");
  return Object.freeze({ preparedReleaseAsset: descriptor });
}

export function preparedAssetMatchesRelease(
  descriptor: HarnessProcessPreparedReleaseAsset,
  release: HarnessProcessPreparedRelease | undefined,
): boolean {
  if (release === undefined || release.artifact.artifactRef !== descriptor.artifactRef)
    return false;
  const expected = release.plan.preparedModules[descriptor.moduleKey];
  return (
    expected !== undefined &&
    expected.path === descriptor.path &&
    expected.bytes === descriptor.bytes &&
    expected.sha256 === descriptor.sha256 &&
    expected.type === descriptor.type
  );
}

export function samePreparedReleaseAsset(
  left: HarnessProcessPreparedReleaseAsset,
  right: HarnessProcessPreparedReleaseAsset,
): boolean {
  return (
    left.artifactRef === right.artifactRef &&
    left.moduleKey === right.moduleKey &&
    left.path === right.path &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.type === right.type
  );
}

export async function materializePreparedReleaseAsset(
  descriptor: HarnessProcessPreparedReleaseAsset,
  readArtifactChunk: HarnessProcessReleaseAssetChunkReader,
): Promise<MaterializedHarnessProcessFacetModule> {
  let bytes: Uint8Array<ArrayBuffer>;
  if (descriptor.bytes === 0) {
    bytes = new Uint8Array(0);
  } else if (descriptor.bytes <= HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES) {
    const chunk = await readArtifactChunk(
      descriptor.artifactRef,
      descriptor.path,
      0,
      descriptor.bytes,
    );
    if (!isExactChunk(chunk, descriptor.bytes))
      throw new TypeError("A prepared process facet asset chunk has the wrong byte length.");
    bytes = chunk as Uint8Array<ArrayBuffer>;
  } else {
    bytes = new Uint8Array(descriptor.bytes);
    for (
      let offset = 0;
      offset < descriptor.bytes;
      offset += HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES
    ) {
      const length = Math.min(HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES, descriptor.bytes - offset);
      const chunk = await readArtifactChunk(
        descriptor.artifactRef,
        descriptor.path,
        offset,
        length,
      );
      if (!isExactChunk(chunk, length))
        throw new TypeError("A prepared process facet asset chunk has the wrong byte length.");
      bytes.set(chunk, offset);
    }
  }
  if ((await sha256Hex(bytes)) !== descriptor.sha256)
    throw new TypeError("A prepared process facet asset has the wrong SHA-256 digest.");
  if (descriptor.type === "wasm") {
    if (
      !(bytes.buffer instanceof ArrayBuffer) ||
      bytes.byteOffset !== 0 ||
      bytes.byteLength !== bytes.buffer.byteLength
    )
      throw new TypeError("A prepared Wasm asset must arrive as one owned ArrayBuffer.");
    return Object.freeze({ wasm: bytes.buffer });
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return descriptor.type === "cjs"
    ? Object.freeze({ cjs: source })
    : descriptor.type === "text"
      ? Object.freeze({ text: source })
      : Object.freeze({ js: source });
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isExactChunk(value: unknown, length: number): value is Uint8Array<ArrayBuffer> {
  return (
    value instanceof Uint8Array &&
    value.buffer instanceof ArrayBuffer &&
    value.byteOffset === 0 &&
    value.byteLength === length &&
    value.buffer.byteLength === length
  );
}
