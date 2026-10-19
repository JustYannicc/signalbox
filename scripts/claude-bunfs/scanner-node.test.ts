// @effect-diagnostics nodeBuiltinImport:off - exercise the scanner through Node's native TypeScript loader.
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

describe("native Node scanner entry points", () => {
  it("imports the typed scanner and analyzes a release without a transpiler", () => {
    const inventoryUrl = new URL("./release-inventory.ts", import.meta.url).href;
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { scanClaudeReleaseInventory } from ${JSON.stringify(inventoryUrl)};
const source = 'import * as fs from "node:fs"; fs.readFileSync("a"); function shadow(fs) { fs.writeFileSync("b"); }';
const inventory = scanClaudeReleaseInventory({
  release: { version: "2.1.303", platform: "linux-x64", bunVersion: null },
  binary: { bytes: 1, sha256: "a".repeat(64) },
  graph: { entry: 0, flags: 0, recordSize: 32 },
  modules: [{ index: 0, key: "$bunfs/entry", name: "/$bunfs/entry", loader: 1, source, bytes: source.length }],
  capabilities: { bunApis: {}, nodeBuiltins: {} },
});
console.log(JSON.stringify({ version: inventory.release.version, builtins: inventory.builtins.map(use => ({ name: use.canonicalBuiltin, members: use.memberUses.map(member => member.member) })) }));`,
      ],
      { encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const inventory = JSON.parse(result.stdout);
    expect(inventory.version).toBe("2.1.303");
    expect(inventory.builtins).toEqual([{ name: "fs", members: ["readFileSync"] }]);
  });

  it("loads the direct CLI and reports usage for missing arguments", () => {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodeURL.fileURLToPath(new URL("./scan-release.ts", import.meta.url))],
      { encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: scan-release.ts <extracted>");
    expect(result.stderr).not.toContain("SyntaxError");
  });
});
