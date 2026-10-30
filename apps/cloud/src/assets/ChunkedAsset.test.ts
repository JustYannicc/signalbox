import { describe, expect, it } from "vite-plus/test";
import {
  ASSET_CHUNK_BYTES,
  WORKER_ASSET_MAX_BYTES,
  assetSha256,
  decodeChunkedAsset,
  readChunkedAsset,
  readChunkedAssetRange,
  readPinnedAsset,
  writeChunkedAsset,
} from "./ChunkedAsset.ts";

async function pack(bytes: Uint8Array, path = "release/main.js") {
  const stored = new Map<string, Uint8Array>();
  const file = await writeChunkedAsset(bytes, path, async (path, bytes) => {
    stored.set(path, Uint8Array.from(bytes));
  });
  const requested: string[] = [];
  const binding = {
    fetch: async (request: Request) => {
      requested.push(request.url);
      const path = new URL(request.url).pathname
        .slice(1)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      const bytes = stored.get(path);
      return bytes
        ? new Response(Uint8Array.from(bytes).buffer)
        : new Response(null, { status: 404 });
    },
  };
  return { file, stored, binding, requested };
}

describe("chunked Worker assets", () => {
  it("keeps fixed 8 MiB offsets, content-addressed deduplication and exact cross-chunk reads", async () => {
    const tailBytes = 2 * 1024 * 1024 + 7;
    const bytes = new Uint8Array(ASSET_CHUNK_BYTES * 3 + tailBytes).fill(37);
    expect(bytes.length).toBeGreaterThan(WORKER_ASSET_MAX_BYTES);
    const first = await pack(bytes);
    const second = await pack(bytes);
    expect(first.file).toEqual(second.file);
    expect(first.file.chunks.map((chunk) => [chunk.offset, chunk.length])).toEqual([
      [0, ASSET_CHUNK_BYTES],
      [ASSET_CHUNK_BYTES, ASSET_CHUNK_BYTES],
      [ASSET_CHUNK_BYTES * 2, ASSET_CHUNK_BYTES],
      [ASSET_CHUNK_BYTES * 3, tailBytes],
    ]);
    expect(first.stored.size).toBe(2);
    expect(first.file.chunks.every((chunk) => chunk.path === `chunks/${chunk.sha256}.bin`)).toBe(
      true,
    );
    const range = await readChunkedAssetRange(first.binding, first.file, ASSET_CHUNK_BYTES - 2, 5);
    expect(Array.from(range)).toEqual([37, 37, 37, 37, 37]);
    expect(range.byteOffset).toBe(0);
    expect(range.buffer.byteLength).toBe(5);
    expect(await assetSha256(await readChunkedAsset(first.binding, first.file))).toBe(
      await assetSha256(bytes),
    );
  });

  it("rejects missing, truncated and hash-changed chunks and a mismatched whole-file pin", async () => {
    const { file, binding, stored } = await pack(new Uint8Array([1, 2, 3]));
    await expect(readChunkedAsset(binding, { ...file, sha256: "f".repeat(64) })).rejects.toThrow(
      "CHUNKED_ASSET_PIN_MISMATCH",
    );
    stored.set("release/main.js", new Uint8Array([3, 2, 1]));
    await expect(readChunkedAsset(binding, file)).rejects.toThrow("CHUNKED_ASSET_PIN_MISMATCH");
    stored.set("release/main.js", new Uint8Array([1]));
    await expect(readChunkedAssetRange(binding, file, 0, 1)).rejects.toThrow(
      "CHUNKED_ASSET_PIN_MISMATCH",
    );
    stored.clear();
    await expect(readChunkedAsset(binding, file)).rejects.toThrow("CHUNKED_ASSET_HTTP_404");
  });

  it("rejects holes, overlaps, reordered chunks and traversal before fetching", async () => {
    const pin = { path: "chunk.bin", sha256: "a".repeat(64), length: ASSET_CHUNK_BYTES };
    const valid = {
      bytes: ASSET_CHUNK_BYTES + 1,
      sha256: "b".repeat(64),
      chunks: [
        { ...pin, offset: 0 },
        { ...pin, offset: ASSET_CHUNK_BYTES, length: 1 },
      ],
    };
    for (const chunks of [
      valid.chunks.slice(1),
      valid.chunks.toReversed(),
      [valid.chunks[0], { ...valid.chunks[1], offset: ASSET_CHUNK_BYTES - 1 }],
      [valid.chunks[0], { ...valid.chunks[1], offset: ASSET_CHUNK_BYTES + 1 }],
    ])
      expect(() => decodeChunkedAsset({ ...valid, chunks })).toThrow();
    expect(() =>
      decodeChunkedAsset({ ...valid, chunks: [{ ...pin, offset: 0, path: "../chunk" }] }),
    ).toThrow("CHUNKED_ASSET_PATH_INVALID");
  });

  it("round-trips literal percent paths and the empty-file whole hash", async () => {
    const packed = await pack(new Uint8Array([9]), "cli/%2F%24bunfs.js");
    expect(
      Array.from(
        await readPinnedAsset(packed.binding, {
          path: "cli/%2F%24bunfs.js",
          bytes: 1,
          sha256: packed.file.sha256,
        }),
      ),
    ).toEqual([9]);
    expect(packed.requested[0]).toContain("/cli/%252F%2524bunfs.js");
    const empty = await pack(new Uint8Array());
    expect((await readChunkedAsset(empty.binding, empty.file)).byteLength).toBe(0);
    expect(empty.requested).toEqual([]);
    await expect(readChunkedAssetRange(packed.binding, packed.file, 1, 1)).rejects.toThrow(
      "CHUNKED_ASSET_RANGE_INVALID",
    );
  });
});
