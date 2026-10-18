// @effect-diagnostics nodeBuiltinImport:off - Tests run Knip against an isolated file graph.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, test } from "vite-plus/test";

const knip = NodeURL.fileURLToPath(new URL("../node_modules/.bin/knip", import.meta.url));
const preprocessor = NodeURL.fileURLToPath(new URL("./knip-declarations.ts", import.meta.url));

test("retains declarations of used modules while reporting unused pairs and orphan declarations", () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "knip-declarations-")),
  );
  try {
    const sources = {
      "package.json": JSON.stringify({ name: "declaration-fixture", private: true }),
      "knip.json": JSON.stringify({ entry: ["index.ts"], project: ["**/*.{ts,mts,mjs}"] }),
      "index.ts": 'import { value } from "./used.mjs"; console.log(value);',
      "used.mjs": "export const value = 1;",
      "used.d.mts": "export declare const value: number;",
      "unused.mjs": "export const unused = 2;",
      "unused.d.mts": "export declare const unused: number;",
      "orphan.d.mts": "export declare const orphan: number;",
    };
    for (const [name, source] of Object.entries(sources))
      NodeFS.writeFileSync(NodePath.join(root, name), source);

    const unused = (preprocess: boolean): string[] => {
      const result = NodeChildProcess.spawnSync(
        knip,
        [
          "--directory",
          root,
          "--include",
          "files",
          "--no-config-hints",
          "--reporter",
          "json",
          ...(preprocess ? ["--preprocessor", preprocessor] : []),
        ],
        { encoding: "utf8" },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      const report: { issues: { file: string; files: unknown[] }[] } = JSON.parse(result.stdout);
      return report.issues
        .filter((issue) => issue.files.length > 0)
        .map((issue) => NodePath.basename(issue.file))
        .sort();
    };

    expect(unused(false)).toEqual(["orphan.d.mts", "unused.d.mts", "unused.mjs", "used.d.mts"]);
    expect(unused(true)).toEqual(["orphan.d.mts", "unused.d.mts", "unused.mjs"]);

    NodeFS.writeFileSync(NodePath.join(root, "index.ts"), "console.log('no imports');");
    expect(unused(true)).toEqual([
      "orphan.d.mts",
      "unused.d.mts",
      "unused.mjs",
      "used.d.mts",
      "used.mjs",
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
