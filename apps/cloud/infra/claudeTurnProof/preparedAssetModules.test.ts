// @effect-diagnostics nodeBuiltinImport:off - isolated in-memory SQLite fixture exercises the prepared require seam.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { createFacetSqliteStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { createNodeBridge } from "../../src/isolate/NodeBridge.ts";
import { createNodeFs } from "../../src/isolate/NodeFs.ts";
import { createProofTestStorage } from "./proofTestStorage.ts";
import { createProofEnvironment } from "./proofEnvironment.ts";
import {
  createPreparedAssetModuleCatalog,
  createPreparedAssetModuleResolver,
  type PreparedAssetModuleCatalog,
} from "./preparedAssetModules.ts";

const require = NodeModule.createRequire(import.meta.url);
const clock = () => 1_800_000_000_000_000_001n;

function filesystemFixture() {
  const database = createProofTestStorage();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, clock) }],
    cwd: "/",
  });
  const fs = createNodeFs(filesystem);
  return {
    fs,
    write(path: string, bytes: Uint8Array) {
      const directory = path.slice(0, path.lastIndexOf("/"));
      fs.fs.mkdirSync(directory, { recursive: true });
      fs.fs.writeFileSync(path, bytes);
    },
    close() {
      try {
        filesystem.dispose();
      } finally {
        database.close();
      }
    },
  };
}

function asset(bytes: Uint8Array, encoding: number, loader = 13) {
  return {
    bytes: bytes.byteLength,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    loader,
    encoding,
  };
}

function utf16le(text: string) {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    bytes[index * 2] = codeUnit & 0xff;
    bytes[index * 2 + 1] = codeUnit >>> 8;
  }
  return bytes;
}

describe("prepared text asset modules", () => {
  it("preserves supplied loader metadata and does not invent defaults", () => {
    const sha256 = "a".repeat(64);
    expect(
      createPreparedAssetModuleCatalog({
        "/fixture/text.txt": { bytes: 3, sha256, loader: 13, encoding: 1 },
        "/fixture/unknown-mode.txt": { bytes: 2, sha256, loader: 14, encoding: 99 },
        "/fixture/no-mode.txt": { bytes: 0, sha256 },
      }),
    ).toEqual({
      "/fixture/text.txt": { bytes: 3, sha256, loader: 13, encoding: 1 },
      "/fixture/unknown-mode.txt": { bytes: 2, sha256, loader: 14, encoding: 99 },
      "/fixture/no-mode.txt": { bytes: 0, sha256 },
    });
  });

  it("returns the exact Latin-1 string primitive before and after package loading", async () => {
    const fixture = filesystemFixture();
    try {
      const path = "/fixture/latin1.txt";
      const bytes = new Uint8Array([0x80, 0xa2, 0xff]);
      fixture.write(path, bytes);
      const prepared = createPreparedAssetModuleResolver({
        assets: { [path]: asset(bytes, 1) },
        fs: fixture.fs,
        isSeeded: () => true,
      });
      const environment = createProofEnvironment({
        bridge: () => createNodeBridge({ path: NodePath }),
        loadPackages: async () => ({ yaml: require("yaml"), undici: require("undici") }),
        onBuiltinFailure: () => {},
        prepared,
      });
      const guestRequire = environment.module.createRequire("/guest/claude.js");
      const expected = "\u0080\u00a2\u00ff";

      const beforeLoad = guestRequire(path);
      expect(typeof beforeLoad).toBe("string");
      expect(beforeLoad).toBe(expected);

      await environment.load();

      const afterLoad = guestRequire(path);
      expect(typeof afterLoad).toBe("string");
      expect(afterLoad).toBe(expected);
    } finally {
      fixture.close();
    }
  });

  it("decodes UTF-8 and UTF-16LE without losing BOM or surrogate code units", () => {
    const fixture = filesystemFixture();
    try {
      const utf8Path = "/fixture/utf8.txt";
      const utf16Path = "/fixture/utf16.txt";
      const utf8Bytes = new TextEncoder().encode("\uFEFFcafé 🌍");
      const utf16Bytes = utf16le("\uFEFFA🧪");
      fixture.write(utf8Path, utf8Bytes);
      fixture.write(utf16Path, utf16Bytes);
      const resolver = createPreparedAssetModuleResolver({
        assets: {
          [utf8Path]: asset(utf8Bytes, 0),
          [utf16Path]: asset(utf16Bytes, 2),
        },
        fs: fixture.fs,
        isSeeded: () => true,
      });

      expect(resolver(utf8Path, "/guest/claude.js")).toBe("\uFEFFcafé 🌍");
      expect(resolver(utf16Path, "/guest/claude.js")).toBe("\uFEFFA🧪");
    } finally {
      fixture.close();
    }
  });

  it("fails closed until seeded and accepts only exact catalog names", () => {
    const fixture = filesystemFixture();
    try {
      const path = "/fixture/exact.txt";
      const alias = "/fixture/alias.txt";
      const bytes = new TextEncoder().encode("asset text");
      fixture.write(path, bytes);
      fixture.write(alias, bytes);
      let seeded = false;
      const resolver = createPreparedAssetModuleResolver({
        assets: { [path]: asset(bytes, 0) },
        fs: fixture.fs,
        isSeeded: () => seeded,
      });

      expect(() => resolver(path, "/guest/claude.js")).toThrow(
        expect.objectContaining({ code: "ERR_DIAGNOSTIC_ASSETS_NOT_SEEDED" }),
      );
      seeded = true;
      expect(resolver(path, "/guest/claude.js")).toBe("asset text");
      for (const unknown of [alias, "exact.txt", "./exact.txt"]) {
        expect(() => resolver(unknown, "/guest/claude.js")).toThrow(
          expect.objectContaining({ code: "ERR_NODE_PREPARED_MODULE_UNAVAILABLE" }),
        );
      }
    } finally {
      fixture.close();
    }
  });

  it("rejects absent bytes and length or hash changes in the seeded filesystem", () => {
    const fixture = filesystemFixture();
    try {
      const path = "/fixture/integrity.txt";
      const missingPath = "/fixture/missing.txt";
      const expectedBytes = new Uint8Array([0x41, 0x42, 0x43]);
      const assets: PreparedAssetModuleCatalog = {
        [path]: asset(expectedBytes, 1),
        [missingPath]: asset(expectedBytes, 1),
      };
      fixture.write(path, new Uint8Array([0x41, 0x42, 0x44]));
      const resolver = createPreparedAssetModuleResolver({
        assets,
        fs: fixture.fs,
        isSeeded: () => true,
      });

      expect(() => resolver(missingPath, "/guest/claude.js")).toThrow(
        expect.objectContaining({ code: "ERR_DIAGNOSTIC_PREPARED_MODULE_MISSING" }),
      );
      expect(() => resolver(path, "/guest/claude.js")).toThrow(
        expect.objectContaining({ code: "ERR_DIAGNOSTIC_PREPARED_MODULE_INTEGRITY_MISMATCH" }),
      );

      fixture.write(path, new Uint8Array([0x41, 0x42, 0x43, 0x44]));
      expect(() => resolver(path, "/guest/claude.js")).toThrow(
        expect.objectContaining({ code: "ERR_DIAGNOSTIC_PREPARED_MODULE_INTEGRITY_MISMATCH" }),
      );
    } finally {
      fixture.close();
    }
  });

  it("rejects unsupported loaders and encodings before decoding", () => {
    const fixture = filesystemFixture();
    try {
      const loaderPath = "/fixture/loader.txt";
      const encodingPath = "/fixture/encoding.txt";
      const bytes = new Uint8Array([0x41]);
      const resolver = createPreparedAssetModuleResolver({
        assets: {
          [loaderPath]: asset(bytes, 1, 14),
          [encodingPath]: asset(bytes, 99),
        },
        fs: fixture.fs,
        isSeeded: () => true,
      });

      expect(() => resolver(loaderPath, "/guest/claude.js")).toThrow(
        expect.objectContaining({ code: "ERR_DIAGNOSTIC_PREPARED_MODULE_UNSUPPORTED_LOADER" }),
      );
      expect(() => resolver(encodingPath, "/guest/claude.js")).toThrow(
        expect.objectContaining({ code: "ERR_DIAGNOSTIC_PREPARED_MODULE_UNSUPPORTED_ENCODING" }),
      );
    } finally {
      fixture.close();
    }
  });

  it("rejects malformed UTF-8 and odd or unpaired UTF-16LE input", () => {
    const fixture = filesystemFixture();
    try {
      const malformedUtf8Path = "/fixture/malformed-utf8.txt";
      const oddUtf16Path = "/fixture/odd-utf16.txt";
      const unpairedUtf16Path = "/fixture/unpaired-utf16.txt";
      const malformedUtf8 = new Uint8Array([0xc3, 0x28]);
      const oddUtf16 = new Uint8Array([0x41]);
      const unpairedUtf16 = new Uint8Array([0x00, 0xd8]);
      fixture.write(malformedUtf8Path, malformedUtf8);
      fixture.write(oddUtf16Path, oddUtf16);
      fixture.write(unpairedUtf16Path, unpairedUtf16);
      const resolver = createPreparedAssetModuleResolver({
        assets: {
          [malformedUtf8Path]: asset(malformedUtf8, 0),
          [oddUtf16Path]: asset(oddUtf16, 2),
          [unpairedUtf16Path]: asset(unpairedUtf16, 2),
        },
        fs: fixture.fs,
        isSeeded: () => true,
      });

      expect(() => resolver(malformedUtf8Path, "/guest/claude.js")).toThrow();
      expect(() => resolver(oddUtf16Path, "/guest/claude.js")).toThrow(
        expect.objectContaining({ code: "ERR_DIAGNOSTIC_PREPARED_MODULE_INVALID_ENCODING" }),
      );
      expect(() => resolver(unpairedUtf16Path, "/guest/claude.js")).toThrow();
    } finally {
      fixture.close();
    }
  });
});
