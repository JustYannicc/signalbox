import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { buildHarnessQualificationArtifact } from "./prepareArtifact.ts";
import { inspectQualificationArtifact } from "./inspectQualificationArtifact.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

const staged = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "qualification-build-"));
  roots.push(root);
  const codex = NodePath.join(root, "codex");
  await NodeFSP.mkdir(codex);
  await NodeFSP.writeFile(NodePath.join(codex, "manifest.json"), '{"mainModule":"loader.mjs"}');
  await NodeFSP.writeFile(NodePath.join(codex, "loader.mjs"), "import 'node:cluster';");
  const built = await buildHarnessQualificationArtifact({
    harness: "codex",
    sourceIdentity: "a".repeat(64),
    computer: { sourceIdentity: "b".repeat(64), manifestSha256: "c".repeat(64) },
    components: { codex },
    output: NodePath.join(root, "artifact"),
  });
  const request = NodePath.join(root, "request.json");
  await execFile(process.execPath, [
    NodePath.resolve(
      import.meta.dirname,
      "../../../../scripts/harness-releases/nodeBuiltinGate/cli.ts",
    ),
    built.directory,
    "--request",
    "--result",
    request,
  ]);
  const requestValue: unknown = JSON.parse(await NodeFSP.readFile(request, "utf8"));
  const requestSha256 = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(requestValue))
    .digest("hex");
  const inventory = NodePath.join(root, "inventory.json");
  const snapshot = {
    modules: [],
    functions: [],
    profile: {
      systemIdentity: {},
      processIdentity: {},
      filesystem: { posixPolicy: false, setUmask: false },
      cpu: { execution: false, processAccounting: false },
    },
    capture: { inventoryRequestSha256: requestSha256 },
  };
  return { built, inventory, snapshot };
};

describe("qualification build and inventory handoff", () => {
  it("reuses the built artifact and retains unsupported builtins from a supplied snapshot", async () => {
    const { built, inventory, snapshot } = await staged();
    await NodeFSP.writeFile(inventory, JSON.stringify(snapshot));
    const inspected = await inspectQualificationArtifact({ ...built, inventory });
    expect(inspected.identity).toEqual(built.identity);
    expect(inspected.openFindings.missingBuiltins).toContain("cluster");
    expect(inspected.openFindings.sources.map((source) => source.name)).toEqual([
      "codex/loader.mjs",
    ]);
  });

  it("refuses a snapshot from another source request", async () => {
    const { built, inventory, snapshot } = await staged();
    await NodeFSP.writeFile(
      inventory,
      JSON.stringify({ ...snapshot, capture: { inventoryRequestSha256: "0".repeat(64) } }),
    );
    await expect(inspectQualificationArtifact({ ...built, inventory })).rejects.toThrow(
      "NODE_BUILTIN_INVENTORY_SOURCE_CHANGED",
    );
  });
});
