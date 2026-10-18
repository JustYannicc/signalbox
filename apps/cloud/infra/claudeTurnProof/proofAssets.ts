import type { NodeFsModules } from "../../src/isolate/NodeFs.ts";

type AssetCatalog = Readonly<Record<string, { bytes: number; sha256: string }>>;

async function sha256(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifySeededAssets(fs: NodeFsModules, catalog: AssetCatalog) {
  const errors: Array<{ path: string; reason: string }> = [];
  const expectedRecords: string[] = [];
  const actualRecords: string[] = [];
  let readAssets = 0;
  let verifiedAssets = 0;
  let verifiedBytes = 0;
  for (const [path, expected] of Object.entries(catalog).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    expectedRecords.push(JSON.stringify([path, expected.bytes, expected.sha256]));
    try {
      const bytes = fs.fs.readFileSync(path);
      if (typeof bytes === "string") throw new Error("Asset read returned text instead of bytes");
      readAssets += 1;
      const digest = await sha256(bytes);
      actualRecords.push(JSON.stringify([path, bytes.byteLength, digest]));
      if (bytes.byteLength !== expected.bytes) {
        errors.push({
          path,
          reason: `Byte length mismatch: ${bytes.byteLength} != ${expected.bytes}`,
        });
      } else if (digest !== expected.sha256) {
        errors.push({ path, reason: `SHA-256 mismatch: ${digest}` });
      } else {
        verifiedAssets += 1;
        verifiedBytes += bytes.byteLength;
      }
    } catch (error) {
      errors.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const encoder = new TextEncoder();
  const expectedCatalogSha256 = await sha256(encoder.encode(expectedRecords.join("\n")));
  const actualCatalogSha256 = await sha256(encoder.encode(actualRecords.join("\n")));
  return {
    ok: errors.length === 0 && actualCatalogSha256 === expectedCatalogSha256,
    source: "sqlite-filesystem",
    expectedAssets: expectedRecords.length,
    readAssets,
    verifiedAssets,
    verifiedBytes,
    expectedCatalogSha256,
    actualCatalogSha256,
    errors,
  };
}
