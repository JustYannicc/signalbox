// @effect-diagnostics nodeBuiltinImport:off - synchronous hashes keep require on the prepared resolver contract.
import * as NodeCrypto from "node:crypto";

import type { NodeFsModules } from "../../src/isolate/NodeFs.ts";
import {
  NodeModuleUnavailableError,
  type NodePreparedModuleResolver,
} from "../../src/isolate/NodeModule.ts";

export interface PreparedAssetModuleMetadata {
  readonly bytes: number;
  readonly sha256: string;
  readonly loader?: number;
  readonly encoding?: number;
}

export type PreparedAssetModuleCatalog = Readonly<Record<string, PreparedAssetModuleMetadata>>;

export function createPreparedAssetModuleCatalog(
  assets: Readonly<Record<string, PreparedAssetModuleMetadata>>,
): PreparedAssetModuleCatalog {
  return Object.fromEntries(
    Object.entries(assets).map(([name, metadata]) => [
      name,
      {
        bytes: metadata.bytes,
        sha256: metadata.sha256,
        ...(metadata.loader === undefined ? {} : { loader: metadata.loader }),
        ...(metadata.encoding === undefined ? {} : { encoding: metadata.encoding }),
      },
    ]),
  );
}

const textLoader = 13;
const sha256Pattern = /^[0-9a-f]{64}$/;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function decodeLatin1(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.byteLength; start += 0x2000) {
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + 0x2000)));
  }
  return chunks.join("");
}

function decodeText(bytes: Uint8Array, encoding: number): string {
  if (encoding === 0) {
    // A prepared require returns the source string itself, so a leading U+FEFF is data.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  if (encoding === 1) return decodeLatin1(bytes);
  if (encoding === 2) {
    if (bytes.byteLength % 2 !== 0) {
      return fail("ERR_DIAGNOSTIC_PREPARED_MODULE_INVALID_ENCODING", "Odd-length UTF-16LE asset");
    }
    return new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  return fail(
    "ERR_DIAGNOSTIC_PREPARED_MODULE_UNSUPPORTED_ENCODING",
    `Unsupported prepared text encoding: ${encoding}`,
  );
}

/** Resolves only exact, seeded asset names through the existing SQLite-backed Node fs. */
export function createPreparedAssetModuleResolver(options: {
  readonly assets: PreparedAssetModuleCatalog;
  readonly fs: NodeFsModules;
  readonly isSeeded: () => boolean;
}): NodePreparedModuleResolver {
  return (specifier) => {
    if (!Object.hasOwn(options.assets, specifier)) {
      throw new NodeModuleUnavailableError("require", specifier);
    }
    const metadata = options.assets[specifier]!;
    if (!options.isSeeded()) {
      return fail(
        "ERR_DIAGNOSTIC_ASSETS_NOT_SEEDED",
        `Diagnostic asset bytes not seeded: ${specifier}`,
      );
    }
    if (metadata.loader !== textLoader) {
      return fail(
        "ERR_DIAGNOSTIC_PREPARED_MODULE_UNSUPPORTED_LOADER",
        `Unsupported prepared module loader for ${specifier}: ${metadata.loader}`,
      );
    }
    if (metadata.encoding !== 0 && metadata.encoding !== 1 && metadata.encoding !== 2) {
      return fail(
        "ERR_DIAGNOSTIC_PREPARED_MODULE_UNSUPPORTED_ENCODING",
        `Unsupported prepared text encoding for ${specifier}: ${metadata.encoding}`,
      );
    }
    if (
      !Number.isSafeInteger(metadata.bytes) ||
      metadata.bytes < 0 ||
      !sha256Pattern.test(metadata.sha256)
    ) {
      return fail(
        "ERR_DIAGNOSTIC_PREPARED_MODULE_INVALID_METADATA",
        `Invalid prepared asset metadata: ${specifier}`,
      );
    }

    let stored: Uint8Array | string;
    try {
      stored = options.fs.fs.readFileSync(specifier);
    } catch (cause) {
      throw Object.assign(new Error(`Diagnostic asset bytes missing: ${specifier}`, { cause }), {
        code: "ERR_DIAGNOSTIC_PREPARED_MODULE_MISSING",
      });
    }
    if (typeof stored === "string") {
      return fail(
        "ERR_DIAGNOSTIC_PREPARED_MODULE_INVALID_BYTES",
        `Prepared asset read returned text: ${specifier}`,
      );
    }
    if (stored.byteLength !== metadata.bytes) {
      return fail(
        "ERR_DIAGNOSTIC_PREPARED_MODULE_INTEGRITY_MISMATCH",
        `Prepared asset byte length mismatch: ${specifier}`,
      );
    }
    const sha256 = NodeCrypto.createHash("sha256").update(stored).digest("hex");
    if (sha256 !== metadata.sha256) {
      return fail(
        "ERR_DIAGNOSTIC_PREPARED_MODULE_INTEGRITY_MISMATCH",
        `Prepared asset SHA-256 mismatch: ${specifier}`,
      );
    }

    return decodeText(stored, metadata.encoding);
  };
}
