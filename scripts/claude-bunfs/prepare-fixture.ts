// @effect-diagnostics nodeBuiltinImport:off - packages the same parser for local and deployed facets.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { requiredVersions } from "./releases.ts";

const [output, selected = requiredVersions.join(",")] = process.argv.slice(2);
if (!output)
  throw new Error(
    "Usage: node prepare-fixture.ts <new-fixture-directory> [versions-comma-separated]",
  );
const versions = selected.split(",");
if (versions.some((version) => !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)))
  throw new Error("Invalid release version");
await NodeFSP.mkdir(output);
const modules: Record<string, { path: string; type: "js" }> = {};
for (const filename of [
  "proof-worker.mts",
  "bun-container.ts",
  "bun-graph.ts",
  "range-reader.ts",
]) {
  const name = filename === "proof-worker.mts" ? "main.js" : filename.replace(/\.ts$/, ".js");
  const source = await NodeFSP.readFile(new URL(filename, import.meta.url), "utf8");
  const js = NodeModule.stripTypeScriptTypes(source, { mode: "strip" }).replaceAll(
    /(from "\.\/[^"]+)\.ts"/g,
    '$1.js"',
  );
  await NodeFSP.writeFile(NodePath.join(output, name), js);
  modules[name] = { path: name, type: "js" };
}
await NodeFSP.writeFile(
  NodePath.join(output, "manifest.json"),
  `${JSON.stringify(
    {
      id: "claude-extractor",
      mode: "facet",
      allowOutbound: true,
      mainModule: "main.js",
      entrypoint: "ProbeFacet",
      modules,
      paths: versions.map((version) => `/proof?version=${version}&platform=linux-x64`),
    },
    null,
    2,
  )}\n`,
);
