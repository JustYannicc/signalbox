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
        text: 'import "./dep.js"; export default 1;',
      },
      { name: "/$bunfs/root/dep.js", path: "dep.js", loader: 1, text: 'export const value = "é";' },
      { name: "/$bunfs/root/orphan.js", path: "orphan.js", loader: 1, text: "export default 2;" },
      {
        name: "/$bunfs/root/mermaid.min.js",
        path: "mermaid.min.js",
        loader: 5,
        text: "\u00ff\u00fe\u0080",
      },
    ];
    const modules = [];
    for (const [index, row] of rows.entries()) {
      const bytes = Buffer.from(row.text, "latin1");
      await NodeFSP.writeFile(NodePath.join(root, row.path), bytes);
      modules.push({
        index,
        name: row.name,
        loader: row.loader,
        encoding: 1,
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
    expect(selected.find((row) => row.name.endsWith("dep.js"))?.source).toContain("é");
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
    expect(map.modules["$bunfs/root/dep.js"].js).toBe('export const value = "é";');
    expect(map.modules["$bunfs/root/mermaid.min.js"]).toBeUndefined();
    await NodeFSP.writeFile(NodePath.join(root, "dep.js"), "tampered");
    await expect(reachableSources(root, manifest, NodePath.join(root, "maps"))).rejects.toThrow(
      "Source hash differs",
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
