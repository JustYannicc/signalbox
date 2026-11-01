import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { publishBundle } from "../claude-bunfs/bundle-artifact.ts";
import { inspectClaudeQualificationBundle } from "./inspectClaudeQualificationBundle.ts";
import { preparePublishedBuiltinInventoryRequest } from "./nodeBuiltinGate.ts";
import { builtinInventoryRequestSha256 } from "./nodeBuiltinGate/inventoryRequest.ts";
import { freezeArtifact } from "./releaseIdentity.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

async function staged() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-inventory-"));
  roots.push(root);
  const directory = NodePath.join(root, "bundle");
  await publishBundle({
    output: directory,
    release: {
      provider: "claude-code",
      version: "2.1.303",
      platform: "linux-x64",
      binarySha256: "a".repeat(64),
    },
    workerEntries: {},
    mainModule: "entry.js",
    modules: [
      { path: "entry.js", contents: Buffer.from('import {read} from "./module.js"; read("x");') },
      {
        path: "module.js",
        contents: Buffer.from(
          'import {readFileSync} from "node:fs"; import "node:cluster"; export const read=readFileSync;',
        ),
      },
    ],
    assets: [],
    requiredHostModules: [],
    sourceModules: ["original.js"],
    metafile: {},
  });
  const artifact = await freezeArtifact(directory);
  const request = await preparePublishedBuiltinInventoryRequest(directory);
  const inventory = {
    modules: [],
    functions: [],
    profile: {
      systemIdentity: {},
      processIdentity: {},
      filesystem: { posixPolicy: false, setUmask: false },
      cpu: { execution: false, processAccounting: false },
    },
    capture: { inventoryRequestSha256: builtinInventoryRequestSha256(request) },
  };
  return { directory, artifact, request, inventory };
}

describe("published Claude build and inventory handoff", () => {
  it("inspects linked partitions with the matching snapshot and preserves the built bytes", async () => {
    const { directory, artifact, request, inventory } = await staged();
    expect(request.sources.map((source) => source.name)).toContain("signalbox:published-analysis");
    expect(request.functions).toContainEqual({ specifier: "fs", memberPath: ["readFileSync"] });
    const inspected = await inspectClaudeQualificationBundle(directory, artifact.sha256, inventory);
    expect(inspected.openFindings.missingBuiltins).toContain("cluster");
    expect(inspected.releasable).toBe(false);
    expect(await freezeArtifact(directory)).toEqual(artifact);
  });

  it("refuses changed payloads instead of inspecting a stale build identity", async () => {
    const { directory, artifact, inventory } = await staged();
    await NodeFSP.appendFile(NodePath.join(directory, "entry.js"), "\nexport const extra=1;");
    await expect(
      inspectClaudeQualificationBundle(directory, artifact.sha256, inventory),
    ).rejects.toThrow("RELEASE_ARTIFACT_INVENTORY_MISMATCH");
  });
});
