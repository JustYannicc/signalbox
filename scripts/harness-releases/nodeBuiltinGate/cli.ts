import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  assertPackagedBuiltinCoverage,
  inspectPackagedBuiltinCoverage,
  type BuiltinSource,
} from "../nodeBuiltinGate.ts";
import { qualificationBuiltinFindings } from "./findings.ts";
import { scanBuiltinSource } from "./source.ts";
import { createBuiltinInventoryRequest } from "./inventoryRequest.ts";
import { parseRuntimeBuiltinInventory } from "../runtimeBuiltinInventory.ts";

const { values, positionals } = NodeUtil.parseArgs({
  options: {
    purpose: { type: "string", default: "release" },
    result: { type: "string" },
    request: { type: "boolean" },
    inventory: { type: "string" },
  },
  allowPositionals: true,
});
const directory = positionals[0];
if (
  !directory ||
  positionals.length !== 1 ||
  !["qualification", "release"].includes(values.purpose)
)
  throw new Error("Supply one prepared artifact directory and purpose qualification|release");
if (values.request && values.inventory !== undefined)
  throw new Error("--request and --inventory cannot be used together");
if (values.inventory !== undefined && values.inventory.length === 0)
  throw new Error("NODE_BUILTIN_INVENTORY_PATH_REQUIRED");
const root = await NodeFSP.realpath(directory);
const sources: BuiltinSource[] = [];
async function walk(relative: string) {
  const entries = await NodeFSP.readdir(NodePath.join(root, relative), {
    withFileTypes: true,
  });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = NodePath.join(relative, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) {
      const bytes = await NodeFSP.readFile(NodePath.join(root, path));
      sources.push({ name: path, source: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
    } else if (!entry.isFile()) throw new Error("NODE_BUILTIN_SOURCE_NOT_A_FILE");
  }
}
await walk("");
if (values.request) {
  const request = createBuiltinInventoryRequest(sources.map(scanBuiltinSource));
  const bytes = JSON.stringify(request) + "\n";
  if (values.result) await NodeFSP.writeFile(values.result, bytes, { flag: "wx" });
  else process.stdout.write(bytes);
} else {
  const inventory =
    values.inventory !== undefined
      ? parseRuntimeBuiltinInventory(JSON.parse(await NodeFSP.readFile(values.inventory, "utf8")))
      : undefined;
  if (inventory !== undefined && inventory.capture?.inventoryRequestSha256 === undefined)
    throw new Error("NODE_BUILTIN_INVENTORY_REQUEST_REQUIRED");
  const inspected = await (
    values.purpose === "qualification"
      ? inspectPackagedBuiltinCoverage
      : assertPackagedBuiltinCoverage
  )(sources, inventory);
  const findings = qualificationBuiltinFindings(inspected);
  if (values.result)
    await NodeFSP.writeFile(values.result, JSON.stringify(findings) + "\n", { flag: "wx" });
  else process.stdout.write(JSON.stringify(findings) + "\n");
}
