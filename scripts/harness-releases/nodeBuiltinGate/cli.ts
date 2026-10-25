import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assertPackagedBuiltinCoverage, type BuiltinSource } from "../nodeBuiltinGate.ts";

const directory = process.argv[2];
if (!directory || process.argv.length !== 3)
  throw new Error("Supply one prepared artifact directory");
const root = await NodeFSP.realpath(directory);
const sources: BuiltinSource[] = [];
async function walk(relative: string) {
  for (const entry of await NodeFSP.readdir(NodePath.join(root, relative), {
    withFileTypes: true,
  })) {
    const path = NodePath.join(relative, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) {
      const bytes = await NodeFSP.readFile(NodePath.join(root, path));
      sources.push({ name: path, source: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
    } else if (!entry.isFile()) throw new Error("NODE_BUILTIN_SOURCE_NOT_A_FILE");
  }
}
await walk("");
process.stdout.write(JSON.stringify(await assertPackagedBuiltinCoverage(sources)) + "\n");
