import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  assertPackagedBuiltinCoverage,
  inspectPackagedBuiltinCoverage,
  type BuiltinSource,
} from "../nodeBuiltinGate.ts";
import { qualificationBuiltinFindings } from "./findings.ts";

const { values, positionals } = NodeUtil.parseArgs({
  options: { purpose: { type: "string", default: "release" }, result: { type: "string" } },
  allowPositionals: true,
});
const directory = positionals[0];
if (
  !directory ||
  positionals.length !== 1 ||
  !["qualification", "release"].includes(values.purpose)
)
  throw new Error("Supply one prepared artifact directory and purpose qualification|release");
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
const inspected = await (
  values.purpose === "qualification"
    ? inspectPackagedBuiltinCoverage
    : assertPackagedBuiltinCoverage
)(sources);
const findings = qualificationBuiltinFindings(inspected);
if (values.result)
  await NodeFSP.writeFile(values.result, JSON.stringify(findings) + "\n", { flag: "wx" });
else process.stdout.write(JSON.stringify(findings) + "\n");
