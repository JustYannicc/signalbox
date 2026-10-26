// @effect-diagnostics nodeBuiltinImport:off - test-only image capture hashes.
import * as NodeCrypto from "node:crypto";
import type { MachineProgramInventory } from "../MachineProgramInventory.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";

export function imageContentInventory(): MachineProgramInventory {
  const bytes = Uint8Array.from([0, 255, 128, 10, 65]);
  const base = machineInventoryFixture([
    { path: "/etc/config", mode: 0o644, uid: 0, gid: 0 },
    { path: "/etc/private", mode: 0o600, uid: 0, gid: 0 },
  ]);
  const metadata = {
    ...base,
    provenance: { ...base.provenance, snapshotSha256: "1".repeat(64) },
    entries: [
      ...base.entries.map((entry) => (entry.type === "file" ? { ...entry, size: "5" } : entry)),
      { ...base.entries[0]!, path: "/etc/link", type: "symlink" as const, target: "config" },
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  const hash = (value: string | Uint8Array) =>
    NodeCrypto.createHash("sha256").update(value).digest("hex");
  return {
    ...metadata,
    imageContent: {
      format: "signalbox-machine-image-content-v1",
      imageDigest: metadata.imageDigest,
      captureSha256: metadata.provenance.captureSha256,
      inventorySha256: hash(JSON.stringify(metadata)),
      includeRule: "regular-files-under-/etc",
      fileCount: 2,
      totalBytes: bytes.length * 2,
      entries: ["/etc/config", "/etc/private"].map((path) => ({
        path,
        size: "5",
        sha256: hash(bytes),
        bytesBase64: Buffer.from(bytes).toString("base64"),
      })),
    },
  };
}
