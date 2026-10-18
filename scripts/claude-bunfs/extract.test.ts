// @effect-diagnostics nodeBuiltinImport:off - verifies extracted bytes in temporary Node filesystem fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { extract, modulePath } from "./extract.ts";
import { fixture } from "./graph-fixture.ts";

describe("unchanged Bun extraction", () => {
  it.each([
    "/$bunfs/root/../escape",
    "/other/absolute",
    "B:/~BUN/root/../escape",
    "../escape",
    "foo/./bar",
    "foo//bar",
    "manifest.json",
    ".bun-data",
    ".bun-data/graph.bin",
    "C:relative",
    "",
  ])("rejects unsafe or reserved name %j", (name) => {
    expect(() => modulePath(name)).toThrow("Unsafe module path");
  });
  it.each([
    ["/$bunfs/root/cli", "cli"],
    ["B:/~BUN/root/deps/a.js", "deps/a.js"],
  ])("maps %s below the output root", (name, relative) => {
    expect(modulePath(name!)).toBe(relative);
  });
  it("preserves the complete serialized graph as well as raw module contents", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-extract-test-"));
    try {
      const input = fixture();
      const binary = NodePath.join(directory, "binary");
      await NodeFSP.writeFile(binary, input.bytes);
      const output = NodePath.join(directory, "out");
      const manifest = await extract(binary, output);
      expect(await NodeFSP.readFile(NodePath.join(output, "cli"), "utf8")).toBe(
        "export default 1;",
      );
      const graph = await NodeFSP.readFile(NodePath.join(output, manifest.serializedGraph.path));
      expect(new Uint8Array(graph)).toEqual(input.graph.subarray(0, -8));
      expect(manifest.serializedGraph.sha256).toBe(
        NodeCrypto.createHash("sha256").update(graph).digest("hex"),
      );
      await expect(extract(binary, output)).rejects.toThrow();
      expect(await NodeFSP.readFile(NodePath.join(output, "cli"), "utf8")).toBe(
        "export default 1;",
      );
      expect((await NodeFSP.readdir(directory)).sort()).toEqual(["binary", "out"]);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
