// @effect-diagnostics nodeBuiltinImport:off - verifies release downloads with temporary Node filesystem fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { fixture } from "./graph-fixture.ts";
import { extractRelease } from "./releases.ts";

it("keeps release provenance from overwriting an extracted module", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-release-test-"));
  const input = fixture();
  const name = new TextEncoder().encode("/$bunfs/root/release.json");
  input.graph.set(name);
  input.data.setUint32(input.table + 4, name.length, true);
  const manifest = {
    version: "1.2.3",
    platforms: {
      "linux-x64": {
        binary: "claude",
        size: input.bytes.length,
        checksum: NodeCrypto.createHash("sha256").update(input.bytes).digest("hex"),
      },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(manifest)),
  );
  try {
    await NodeFSP.writeFile(NodePath.join(directory, "claude-1.2.3-linux-x64"), input.bytes);
    const output = await extractRelease("1.2.3", directory);
    expect(await NodeFSP.readFile(NodePath.join(output, "release.json"), "utf8")).toBe(
      "export default 1;",
    );
    const provenance = JSON.parse(
      await NodeFSP.readFile(NodePath.join(output, ".bun-data/release.json"), "utf8"),
    );
    expect(provenance.manifest).toEqual(manifest);
  } finally {
    vi.unstubAllGlobals();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
