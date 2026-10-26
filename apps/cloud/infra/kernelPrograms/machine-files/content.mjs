import * as NodeCrypto from "node:crypto";

/** The metadata walk defines membership; content cannot add paths or omit included files. */
export function validateCapturedContent(snapshot) {
  const content = snapshot.content;
  if (
    content?.includeRule !== "regular-files-under-/etc" ||
    !Array.isArray(content.entries) ||
    content.fileCount !== content.entries.length
  )
    throw new TypeError("Image content capture is incomplete");
  const included = snapshot.entries.filter(
    (entry) => entry.type === "file" && entry.path.startsWith("/etc/"),
  );
  if (included.length !== content.entries.length)
    throw new TypeError("Image content does not cover the include rule");
  let total = 0;
  for (const [index, entry] of content.entries.entries()) {
    const metadata = included[index];
    if (metadata?.path !== entry.path || metadata.size !== entry.size)
      throw new TypeError("Image content path or size differs from inventory");
    if (typeof entry.bytesBase64 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? ""))
      throw new TypeError("Invalid image content encoding or hash");
    if (
      BigInt(entry.size) + BigInt(total) > 1024n * 1024n ||
      entry.bytesBase64.length !== 4 * Math.ceil(Number(entry.size) / 3)
    )
      throw new TypeError("Image content encoding exceeds its size or capture budget");
    const bytes = Buffer.from(entry.bytesBase64, "base64");
    if (bytes.toString("base64") !== entry.bytesBase64 || String(bytes.byteLength) !== entry.size)
      throw new TypeError("Image content payload size or encoding differs");
    if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new TypeError(`Image content hash differs: ${entry.path}`);
    total += bytes.byteLength;
  }
  if (total !== content.totalBytes || total > 1024 * 1024)
    throw new TypeError("Image content total differs or exceeds the 1 MiB budget");
}
