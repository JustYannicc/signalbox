import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createReleaseOmission } from "../../claude-bunfs/rebundle-omission.ts";
import {
  publishBundle,
  type BundleFile,
  type BundlePublication,
} from "../../claude-bunfs/bundle-artifact.ts";
import { sha256 } from "../guards.ts";
import { assertPublishedBuiltinCoverage } from "../nodeBuiltinGate.ts";
import { linkPublishedSources } from "./publishedGraph.ts";
import { scanBuiltinSource } from "../nodeBuiltinGate.ts";
import { readPublishedBuiltinSources } from "./published.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function publish(
  input: {
    readonly modules?: readonly BundleFile[];
    readonly source?: string;
    readonly omission?: BundlePublication["omission"];
  } = {},
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "builtin-published-"));
  roots.push(root);
  const directory = NodePath.join(root, "bundle");
  const built = await publishBundle({
    output: directory,
    release: {
      provider: "claude-code",
      version: "2.1.303",
      platform: "linux-x64",
      binarySha256: "a".repeat(64),
    },
    mainModule: "entry.js",
    modules: input.modules ?? [
      { path: "entry.js", contents: new TextEncoder().encode('import "./module.js";') },
      {
        path: "module.js",
        contents: new TextEncoder().encode(
          input.source ?? 'import os from "node:os"; os.release();',
        ),
      },
    ],
    assets: [],
    requiredHostModules: [],
    sourceModules: ["original.js"],
    metafile: {},
    ...(input.omission === undefined ? {} : { omission: input.omission }),
  });
  return { root, directory, built };
}

async function makeOmissionFixture() {
  const binarySha256 = "a".repeat(64);
  const path = "vendor/cold.js";
  const inputPath = `bun-graph:${path}`;
  const originalSource = "export function cold() { return 1; }";
  const producer = createReleaseOmission({
    options: {
      configuration: { name: "qualification", env: { HOME: "/home/claude" } },
      corpus: {
        schemaVersion: 1,
        binarySha256,
        provenance: [{ name: "release-binary", sha256: "b".repeat(64) }],
        pending: ["normal-turn"],
        inputs: [{ inputPath, initialized: false }],
      },
    },
    binarySha256,
    sources: new Map([[path, originalSource]]),
    resolve: () => undefined,
    commonJs: () => false,
  });
  producer.observeSource(originalSource, path, "bun-graph");

  const build = async () => {
    const emitted = producer.prepareSource(originalSource, path, "bun-graph");
    const bytes = new TextEncoder().encode(emitted).byteLength;
    return {
      metafile: {
        inputs: { [inputPath]: { bytes: originalSource.length, imports: [] } },
        outputs: {
          "release.js": {
            bytes,
            imports: [],
            exports: [],
            inputs: { [inputPath]: { bytesInOutput: bytes } },
          },
        },
      },
    };
  };
  await producer.plan(build);
  return {
    omission: producer.manifest(),
    emittedSource: producer.prepareSource(originalSource, path, "bun-graph"),
  };
}

const inventory = {
  modules: ["os"],
  functions: [
    {
      specifier: "os",
      memberPath: ["release"],
      status: "unsupported" as const,
      evidence: "test capability",
    },
  ],
  profile: {
    systemIdentity: {},
    processIdentity: {},
    filesystem: { posixPolicy: true, setUmask: true },
    cpu: { execution: false, processAccounting: false },
  },
};

describe("published partition linking", () => {
  it("validates the worker retention tier and rejects overlapping omissions", async () => {
    const fixture = await makeOmissionFixture();
    const omission = {
      ...fixture.omission,
      retainedInputs: { worker: ["bun-graph:worker-only.js"] },
    };
    const valid = await publish({ omission });
    expect((await readPublishedBuiltinSources(valid.directory)).omission).toEqual(omission);
    const invalid = await publish({
      omission: {
        ...omission,
        retainedInputs: { worker: [fixture.omission.omittedModules[0]!.inputPath] },
      },
    });
    await expect(readPublishedBuiltinSources(invalid.directory)).rejects.toThrow(
      "NODE_BUILTIN_PUBLISHED_MANIFEST_INVALID",
    );
  });

  it("finds builtin calls whose facade crosses the partition boundary", async () => {
    const linked = await linkPublishedSources([
      { name: "signalbox/main.js", source: 'import {os} from "./worker.js"; os.release();' },
      { name: "signalbox/worker.js", source: 'import os from "node:os"; export {os};' },
    ]);
    expect(scanBuiltinSource(linked).requiredFunctions).toContainEqual(
      expect.objectContaining({ specifier: "os", memberPath: ["release"] }),
    );
  });
});

describe("published builtin gate", () => {
  it("scans every declared final JS module using its type and verifies the artifact identity", async () => {
    const { directory, built } = await publish();
    const read = await readPublishedBuiltinSources(directory);
    expect(read.artifact.sha256).toBe(built.artifactSha256);
    expect(read.sources.map((source) => source.name)).toEqual(["entry.js", "module.js"]);
    await expect(assertPublishedBuiltinCoverage(directory, inventory)).rejects.toThrow(
      "unsupported-functions=os.release",
    );
  });

  it("uses emitted code and does not turn unlisted original source into a requirement", async () => {
    const { root, directory } = await publish({ source: "export const emitted = 1;" });
    await NodeFSP.writeFile(
      NodePath.join(root, "original.js"),
      'import os from "os"; os.getPriority();',
    );
    const report = await assertPublishedBuiltinCoverage(directory, { ...inventory, functions: [] });
    expect(report.status).toBe("pass");
    expect(report.requiredFunctions).toEqual([]);
    expect(Object.hasOwn(report, "omission")).toBe(false);
    expect(report.artifact.files.map((file) => file.path)).toEqual([
      "entry.js",
      "module-map.json",
      "module.js",
    ]);
  });

  it("carries the exact final omission manifest and generated reporter stub into the gate report", async () => {
    const fixture = await makeOmissionFixture();
    const { directory, built } = await publish({
      omission: fixture.omission,
      modules: [
        { path: "entry.js", contents: new TextEncoder().encode('import "./omitted.js";') },
        { path: "omitted.js", contents: new TextEncoder().encode(fixture.emittedSource) },
      ],
    });

    const read = await readPublishedBuiltinSources(directory);
    expect(read.artifact.sha256).toBe(built.artifactSha256);
    expect(read.omission).toEqual(fixture.omission);
    expect(read.sources).toContainEqual({ name: "omitted.js", source: fixture.emittedSource });
    expect(fixture.emittedSource).toContain('"code":"RELEASE_MODULE_OMITTED"');
    expect(fixture.emittedSource).toContain('Symbol.for("signalbox.releaseModuleOmitted")');
    expect(fixture.emittedSource).toContain("finally{throw error}");

    const report = await assertPublishedBuiltinCoverage(directory, { ...inventory, functions: [] });
    expect(report.artifact).toEqual(read.artifact);
    expect(report.omission).toEqual(fixture.omission);
  });

  it("still rejects unsupported calls in surviving code when omission metadata names a cold input", async () => {
    const fixture = await makeOmissionFixture();
    const { directory } = await publish({
      omission: fixture.omission,
      modules: [
        {
          path: "entry.js",
          contents: new TextEncoder().encode('import "./omitted.js"; import "./retained.js";'),
        },
        { path: "omitted.js", contents: new TextEncoder().encode(fixture.emittedSource) },
        {
          path: "retained.js",
          contents: new TextEncoder().encode('import os from "node:os"; os.release();'),
        },
      ],
    });
    expect(fixture.omission.omittedModules).toEqual([
      expect.objectContaining({ inputPath: "bun-graph:vendor/cold.js", tier: "corpus" }),
    ]);
    await expect(assertPublishedBuiltinCoverage(directory, inventory)).rejects.toThrow(
      "unsupported-functions=os.release",
    );
  });

  it("rejects missing and malformed omittedModules in the final manifest", async () => {
    const fixture = await makeOmissionFixture();
    const malformed = [
      { ...fixture.omission, omittedModules: undefined },
      { ...fixture.omission, omittedModules: { inputPath: "vendor/cold.js" } },
    ] as const;
    for (const omission of malformed) {
      const { directory } = await publish({
        omission: omission as unknown as BundlePublication["omission"],
      });
      await expect(readPublishedBuiltinSources(directory)).rejects.toThrow(
        "NODE_BUILTIN_PUBLISHED_MANIFEST_INVALID",
      );
    }
  });

  it("rejects changed module bytes before scanning or accepting capability evidence", async () => {
    const { directory } = await publish();
    await NodeFSP.writeFile(NodePath.join(directory, "module.js"), "export const changed = 1;");
    await expect(assertPublishedBuiltinCoverage(directory, inventory)).rejects.toThrow(
      "RELEASE_ARTIFACT_INVENTORY_MISMATCH",
    );
  });

  it("rejects a self-consistent map hash whose loader entries differ from the manifest", async () => {
    const { directory, built } = await publish();
    const changedMap = JSON.stringify({
      "entry.js": { path: "entry.js", type: "js" },
      "module.js": { path: "entry.js", type: "js" },
    });
    await NodeFSP.writeFile(NodePath.join(directory, "module-map.json"), changedMap);
    await NodeFSP.writeFile(
      NodePath.join(directory, "manifest.json"),
      JSON.stringify({
        ...built.manifest,
        moduleMap: { path: "module-map.json", sha256: sha256(changedMap) },
      }),
    );
    await expect(readPublishedBuiltinSources(directory)).rejects.toThrow(
      "NODE_BUILTIN_PUBLISHED_MANIFEST_INVALID",
    );
  });
});
