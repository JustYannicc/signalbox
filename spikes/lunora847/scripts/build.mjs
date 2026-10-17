import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
await build({
  entryPoints: ["src/client.ts"],
  bundle: true,
  format: "esm",
  target: "es2023",
  outfile: "dist/client.js",
  metafile: true,
}).then(async (result) => writeFile("client-meta.json", JSON.stringify(result.metafile)));
const html = await readFile("src/index.html", "utf8");
const js = await readFile("dist/client.js", "utf8");
await writeFile(
  "src/assets.ts",
  `export const html=${JSON.stringify(html)};\nexport const clientJs=${JSON.stringify(js)};\n`,
);
