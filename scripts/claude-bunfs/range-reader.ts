// @effect-diagnostics globalFetch:off - the range reader runs directly in Node and workerd.
import type { BinaryReader } from "./bun-container.ts";

// Metadata and source text are laid out in runs. A bounded page cache avoids
// one HTTP request per name without retaining the executable or its bytecode.
export function cachedReader(source: BinaryReader): BinaryReader {
  const pageSize = 1024 * 1024;
  const pages = new Map<number, Uint8Array>();
  return {
    size: source.size,
    async read(offset, length) {
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        offset + length > source.size
      )
        throw new Error("BUN_FORMAT_CHANGED: read outside binary");
      if (length === 0) return new Uint8Array();
      const start = Math.floor(offset / pageSize) * pageSize;
      if (offset + length > start + pageSize) return source.read(offset, length);
      let page = pages.get(start);
      if (!page) {
        page = await source.read(start, Math.min(pageSize, source.size - start));
        if (page.length !== Math.min(pageSize, source.size - start))
          throw new Error("short binary read");
        if (pages.size >= 8) pages.delete(pages.keys().next().value!);
        pages.set(start, page);
      }
      return page.subarray(offset - start, offset - start + length);
    },
  };
}

export async function httpReader(url: string) {
  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`Binary HEAD failed: ${head.status}`);
  const size = Number(head.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error("Binary has no valid content-length");
  return cachedReader({
    size,
    async read(offset, length) {
      const response = await fetch(url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      });
      if (
        response.status !== 206 ||
        response.headers.get("content-range") !== `bytes ${offset}-${offset + length - 1}/${size}`
      ) {
        await response.body?.cancel();
        throw new Error(`Binary range response invalid: ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== length) throw new Error("short HTTP range read");
      return bytes;
    },
  });
}
