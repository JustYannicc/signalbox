import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { verifyProgramProvenance } from "./measured.ts";

const expected = { bytes: 123, sha256: "pinned-artifact", revision: "pinned-source" };
const artifact = { bytes: expected.bytes, sha256: expected.sha256 };

it.each([
  { artifact, revision: expected.revision },
  { artifact, source: { revision: expected.revision } },
  { artifact, version: expected.revision },
])("accepts the pinned artifact and source identity: %j", async (manifest) => {
  await withManifest(manifest, async (programDir) => {
    await expect(
      verifyProgramProvenance(programDir, "provenance.json", expected),
    ).resolves.toBeUndefined();
  });
});

it.each([
  null,
  [],
  { artifact: null, revision: expected.revision },
  { artifact: [], revision: expected.revision },
  { artifact: { ...artifact, bytes: "123" }, revision: expected.revision },
  { artifact: { ...artifact, sha256: "different" }, revision: expected.revision },
  { artifact, source: { revision: "different" } },
  { artifact, version: 123 },
  { artifact, source: null },
])("rejects malformed or mismatched provenance: %j", async (manifest) => {
  await withManifest(manifest, async (programDir) => {
    await expect(verifyProgramProvenance(programDir, "provenance.json", expected)).rejects.toThrow(
      "Prepared child program provenance does not match provenance.json",
    );
  });
});

async function withManifest(manifest: unknown, run: (programDir: string) => Promise<void>) {
  const programDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "child-provenance-"));
  try {
    await NodeFSP.writeFile(NodePath.join(programDir, "provenance.json"), JSON.stringify(manifest));
    await run(programDir);
  } finally {
    await NodeFSP.rm(programDir, { recursive: true, force: true });
  }
}
