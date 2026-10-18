// @effect-diagnostics nodeBuiltinImport:off - source-map fixtures use temporary Node filesystem data.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { reachableSources } from "./probe-sources.ts";
import { generateProbeMaps } from "./probe-maps.ts";

it("keeps only reachable JS source, with binary .js assets and bytecode recorded separately", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-probe-map-"));
  try {
    const rows = [
      {
        name: "/$bunfs/root/cli",
        path: "cli",
        loader: 1,
        encoding: 1,
        text: 'import "./dep.js"; export default 1;',
      },
      {
        name: "/$bunfs/root/dep.js",
        path: "dep.js",
        loader: 1,
        encoding: 2,
        text: 'export const value = "漢字";',
      },
      {
        name: "/$bunfs/root/orphan.js",
        path: "orphan.js",
        loader: 1,
        encoding: 1,
        text: "export default 2;",
      },
      {
        name: "/$bunfs/root/mermaid.min.js",
        path: "mermaid.min.js",
        loader: 5,
        encoding: 1,
        text: "\u00ff\u00fe\u0080",
      },
    ];
    const modules = [];
    for (const [index, row] of rows.entries()) {
      const bytes = Buffer.from(row.text, row.encoding === 2 ? "utf16le" : "latin1");
      await NodeFSP.writeFile(NodePath.join(root, row.path), bytes);
      modules.push({
        index,
        name: row.name,
        loader: row.loader,
        encoding: row.encoding,
        artifacts: {
          contents: {
            path: row.path,
            bytes: bytes.length,
            sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          },
          ...(index === 0 ? { bytecode: { path: "entry.jsc", bytes: 3, sha256: "bytecode" } } : {}),
        },
      });
    }
    const manifest = NodePath.join(root, "manifest.json");
    await NodeFSP.writeFile(manifest, JSON.stringify({ graph: { entry: 0 }, modules }));
    const selected = await reachableSources(root, manifest, NodePath.join(root, "maps"));
    expect(selected.map((row) => row.name).sort()).toEqual([
      "/$bunfs/root/cli",
      "/$bunfs/root/dep.js",
    ]);
    expect(selected.find((row) => row.name.endsWith("dep.js"))).toMatchObject({
      encoding: "utf16le",
      source: 'export const value = "漢字";',
    });
    const inventory = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, "maps/probe-module-inventory.json"), "utf8"),
    );
    expect(inventory.excluded.map((row: { name: string }) => row.name)).toEqual([
      "/$bunfs/root/mermaid.min.js",
    ]);
    expect(inventory.bytecode.map((row: { name: string }) => row.name)).toEqual([
      "/$bunfs/root/cli",
    ]);
    const maps = await generateProbeMaps([root, NodePath.join(root, "loader-maps")]);
    expect(maps.maps).toHaveLength(3);
    const map = JSON.parse(await NodeFSP.readFile(String(maps.maps[0]!.mapPath), "utf8"));
    expect(Object.keys(map.modules).every((name) => !name.startsWith("/"))).toBe(true);
    expect(map.modules["$bunfs/root/dep.js"].js).toBe('export const value = "漢字";');
    expect(map.modules["$bunfs/root/mermaid.min.js"]).toBeUndefined();
    const fixtureRoot = String(maps.maps[0]!.fixturePath);
    const fixture = JSON.parse(
      await NodeFSP.readFile(NodePath.join(fixtureRoot, "manifest.json"), "utf8"),
    );
    const fixtureModule = fixture.modules["$bunfs/root/dep.js"];
    const utf8Source = Buffer.from('export const value = "漢字";', "utf8");
    const utf16Source = Buffer.from('export const value = "漢字";', "utf16le");
    expect(fixtureModule).toMatchObject({
      sourceEncoding: "utf8",
      actualBytes: utf8Source.byteLength,
      sha256: NodeCrypto.createHash("sha256").update(utf8Source).digest("hex"),
      originalEncoding: "utf16le",
      originalBytes: utf16Source.byteLength,
      originalSha256: NodeCrypto.createHash("sha256").update(utf16Source).digest("hex"),
      utf8FileBytes: utf8Source.byteLength,
    });
    expect(await NodeFSP.readFile(NodePath.join(fixtureRoot, fixtureModule.path), "utf8")).toBe(
      'export const value = "漢字";',
    );
    await NodeFSP.writeFile(
      manifest,
      JSON.stringify({
        graph: { entry: 0 },
        modules: modules.map((module, index) =>
          index === 1 ? { ...module, encoding: "utf16le" } : module,
        ),
      }),
    );
    await expect(reachableSources(root, manifest, NodePath.join(root, "maps"))).rejects.toThrow(
      "Unsupported module encoding",
    );
    await NodeFSP.writeFile(manifest, JSON.stringify({ graph: { entry: 0 }, modules }));
    await NodeFSP.writeFile(NodePath.join(root, "dep.js"), "tampered");
    await expect(reachableSources(root, manifest, NodePath.join(root, "maps"))).rejects.toThrow(
      "Source hash differs",
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
