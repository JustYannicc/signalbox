// @effect-diagnostics nodeBuiltinImport:off - native hashes independently check the Web Crypto asset decoder.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";

import {
  decodeVerifiedAssetBundle,
  encodeAssetBundle,
  type AssetBundleEntry,
} from "./assetBundle.ts";

function entry(path: string, bytes = new Uint8Array([0, 255, 128, 10])): AssetBundleEntry {
  return { path, bytes, sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex") };
}

const assets = [entry("/claude/雪/addon.node"), entry("/claude/empty", new Uint8Array())];
const catalog = Object.fromEntries(
  assets.map(({ path, bytes, sha256 }) => [path, { bytes: bytes.length, sha256 }]),
);

function rewriteHeader(bundle: Uint8Array, metadata: unknown) {
  const previousLength = new DataView(
    bundle.buffer,
    bundle.byteOffset,
    bundle.byteLength,
  ).getUint32(8);
  const header = new TextEncoder().encode(JSON.stringify(metadata));
  const changed = new Uint8Array(12 + header.length + bundle.length - 12 - previousLength);
  changed.set(bundle.subarray(0, 8));
  new DataView(changed.buffer).setUint32(8, header.length);
  changed.set(header, 12);
  changed.set(bundle.subarray(12 + previousLength), 12 + header.length);
  return changed;
}

function metadata(bundle: Uint8Array): Array<{ path: string; bytes: number; sha256: string }> {
  const length = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength).getUint32(8);
  return JSON.parse(new TextDecoder().decode(bundle.subarray(12, 12 + length)));
}

describe("Claude proof asset bundle", () => {
  it("round-trips binary and empty assets with Unicode paths deterministically", async () => {
    const encoded = encodeAssetBundle(assets);
    expect(encodeAssetBundle(assets.toReversed())).toEqual(encoded);
    const decoded = await decodeVerifiedAssetBundle(encoded, catalog);
    expect(decoded).toEqual(assets.toReversed());
    encoded.fill(0);
    expect(decoded[1]!.bytes).toEqual(new Uint8Array([0, 255, 128, 10]));
  });

  it("snapshots request bytes before asynchronous hashing", async () => {
    const encoded = encodeAssetBundle(assets);
    const decoding = decodeVerifiedAssetBundle(encoded, catalog);
    encoded.fill(0);
    expect(await decoding).toEqual(assets.toReversed());
  });

  it("handles a bundle supplied as a view into a larger allocation", async () => {
    const encoded = encodeAssetBundle(assets);
    const allocation = new Uint8Array(encoded.length + 16);
    allocation.set(encoded, 7);
    expect(
      await decodeVerifiedAssetBundle(allocation.subarray(7, 7 + encoded.length), catalog),
    ).toEqual(assets.toReversed());
  });

  it("rejects corruption even when metadata still matches the expected catalog", async () => {
    const encoded = encodeAssetBundle(assets);
    encoded[encoded.length - 1] = encoded[encoded.length - 1]! ^ 1;
    await expect(decodeVerifiedAssetBundle(encoded, catalog)).rejects.toThrow("hash mismatch");
  });

  it("rejects catalog omissions, extra paths, wrong lengths, and wrong hashes", async () => {
    const encoded = encodeAssetBundle(assets);
    for (const changed of [
      {},
      { ...catalog, "/claude/extra": { bytes: 0, sha256: assets[0]!.sha256 } },
      { ...catalog, [assets[0]!.path]: { bytes: 3, sha256: assets[0]!.sha256 } },
      { ...catalog, [assets[0]!.path]: { bytes: 4, sha256: "f".repeat(64) } },
    ]) {
      await expect(decodeVerifiedAssetBundle(encoded, changed)).rejects.toThrow("catalog");
    }
    const unknown = metadata(encoded).map((value) => ({
      ...value,
      path: `/unexpected${value.path}`,
    }));
    await expect(
      decodeVerifiedAssetBundle(rewriteHeader(encoded, unknown), catalog),
    ).rejects.toThrow("catalog mismatch");
  });

  it("rejects duplicate paths rather than accepting a missing expected asset", async () => {
    const encoded = encodeAssetBundle(assets);
    const values = metadata(encoded);
    await expect(
      decodeVerifiedAssetBundle(rewriteHeader(encoded, [values[0], values[0]]), catalog),
    ).rejects.toThrow("duplicate path");
    expect(() => encodeAssetBundle([assets[0]!, assets[0]!])).toThrow("duplicate path");
  });

  it("rejects truncated prefixes, headers, and bodies and trailing bytes", async () => {
    const encoded = encodeAssetBundle(assets);
    for (const cut of [0, 8, 11, 12, encoded.length - 1]) {
      await expect(decodeVerifiedAssetBundle(encoded.subarray(0, cut), catalog)).rejects.toThrow(
        "truncated",
      );
    }
    const extra = new Uint8Array(encoded.length + 1);
    extra.set(encoded);
    await expect(decodeVerifiedAssetBundle(extra, catalog)).rejects.toThrow("trailing bytes");
  });

  it("rejects wrong magic, malformed JSON, invalid UTF-8, and malformed metadata", async () => {
    const encoded = encodeAssetBundle(assets);
    const wrongMagic = encoded.slice();
    wrongMagic[0] = 0;
    await expect(decodeVerifiedAssetBundle(wrongMagic, catalog)).rejects.toThrow("wrong magic");
    for (const byte of [0, 255]) {
      const malformed = encoded.slice();
      malformed[12] = byte;
      await expect(decodeVerifiedAssetBundle(malformed, catalog)).rejects.toThrow(
        "malformed header",
      );
    }
    const values = metadata(encoded);
    for (const changed of [
      null,
      {},
      [{ ...values[0], bytes: -1 }, values[1]],
      [{ ...values[0], bytes: 0.5 }, values[1]],
      [{ ...values[0], sha256: "bad" }, values[1]],
      [{ ...values[0], extra: true }, values[1]],
      [{ bytes: 0, sha256: assets[0]!.sha256 }, values[1]],
    ]) {
      await expect(
        decodeVerifiedAssetBundle(rewriteHeader(encoded, changed), catalog),
      ).rejects.toThrow("Invalid Claude asset bundle");
    }
  });

  it("enforces body, metadata, and entry limits for encoding and decoding", async () => {
    await expect(
      decodeVerifiedAssetBundle(new Uint8Array(8 * 1024 * 1024 + 1), catalog),
    ).rejects.toThrow("bundle too large");
    expect(() => encodeAssetBundle([entry("/large", new Uint8Array(8 * 1024 * 1024))])).toThrow(
      "bundle too large",
    );
    const encoded = encodeAssetBundle(assets);
    const largeHeader = encoded.slice();
    new DataView(largeHeader.buffer).setUint32(8, 256 * 1024 + 1);
    await expect(decodeVerifiedAssetBundle(largeHeader, catalog)).rejects.toThrow(
      "header too large",
    );
    expect(() => encodeAssetBundle([entry(`/${"a".repeat(256 * 1024)}`)])).toThrow(
      "header too large",
    );
    const manyEntries = Array.from({ length: 513 }, (_, index) => entry(`/asset-${index}`));
    expect(() => encodeAssetBundle(manyEntries)).toThrow("too many entries");
    await expect(
      decodeVerifiedAssetBundle(rewriteHeader(encoded, manyEntries), catalog),
    ).rejects.toThrow("invalid entry list");
  });
});
