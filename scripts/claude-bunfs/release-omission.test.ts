// @effect-diagnostics nodeBuiltinImport:off - exercise published release fixtures.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { rebundle } from "./rebundle.ts";
import { parseReleaseCoverageCorpus, releaseSourceHash } from "./release-omission.ts";
import { createPinnedEnvironmentTransform } from "./pinned-environment.ts";

const binarySha256 = releaseSourceHash("fixture");
const configuration = { name: "fixture-host", env: { DISABLE: "1", ABSENT: null }, settings: {} };

async function fixture(root: string) {
  const sources = {
    "/cli": `import {env} from './env.js';export const reachable=()=>21*2;export const configured=()=>env.DISABLE==='1'?'disabled':import('./gated.js');export const cold=()=>import('./cold.js');export const cjs=()=>import('./cold.cjs');export const coldRequire=()=>import.meta.require('./cold.js');export const cjsRequire=()=>import.meta.require('./cold.cjs');`,
    "/env.js": "const value=process.env;export{value as env};",
    "/gated.js": 'export const value="tier-one-payload";',
    "/cold.js": 'export function value(){return "tier-two-payload"}',
    "/cold.cjs":
      '(function(exports,require,module,__filename,__dirname){module.exports={value:"commonjs-payload"}})',
  };
  const extracted = NodePath.join(root, "extracted");
  await NodeFSP.mkdir(extracted);
  const modules = [];
  for (const [index, [name, source]] of Object.entries(sources).entries()) {
    const path = `${index}.js`;
    const contents = Buffer.from(source);
    await NodeFSP.writeFile(NodePath.join(extracted, path), contents);
    modules.push({
      index,
      name,
      loader: 1,
      encoding: 0,
      format: name.endsWith(".cjs") ? 2 : 1,
      artifacts: { contents: { path, bytes: contents.length, sha256: releaseSourceHash(source) } },
    });
  }
  await NodeFSP.writeFile(
    NodePath.join(extracted, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      binary: { bytes: 1, sha256: binarySha256 },
      graph: { entry: 0 },
      modules,
    }),
  );
  return extracted;
}

describe("release omission", () => {
  it("omits configured and corpus-cold payloads, preserves reachable code, and reports failed initialization", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-omission-"));
    const reports: unknown[] = [];
    const key = Symbol.for("signalbox.releaseChunkOmitted");
    const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
    const previous = globals[key];
    globals[key] = (event: unknown) => {
      reports.push(event);
      throw new Error("reporter transport unavailable");
    };
    try {
      const extracted = await fixture(root);
      const output = NodePath.join(root, "bundle");
      const built = await rebundle({
        extracted,
        output,
        version: "fixture",
        platform: "linux-x64",
        deferInitialization: true,
        omission: {
          configuration,
          corpus: {
            schemaVersion: 1,
            binarySha256,
            provenance: [{ name: "fixture-coverage", sha256: releaseSourceHash("coverage") }],
            pending: ["sessions-C-A-B"],
            inputs: [
              { inputPath: "bun-graph:/cold.js", initialized: false },
              { inputPath: "bun-graph:/cold.cjs", initialized: false },
              { inputPath: "bun-graph:/cli", initialized: true },
            ],
          },
        },
      });
      await NodeFSP.writeFile(NodePath.join(output, "package.json"), '{"type":"module"}');
      const launcher = await import(NodeURL.pathToFileURL(NodePath.join(output, "claude.js")).href);
      const release = launcher.launch();
      expect(release.reachable()).toBe(42);
      expect(release.configured()).toBe("disabled");
      for (const name of [
        "coldRequire",
        "coldRequire",
        "cjsRequire",
        "cjsRequire",
        "cold",
        "cjs",
      ]) {
        await expect(Promise.resolve().then(() => release[name]())).rejects.toMatchObject({
          name: "ReleaseChunkOmittedError",
          code: "RELEASE_CHUNK_OMITTED",
          chunkId: `bun-graph:/${name.startsWith("cjs") ? "cold.cjs" : "cold.js"}`,
          tier: "corpus",
        });
      }
      expect(reports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "RELEASE_CHUNK_OMITTED",
            inputPath: "bun-graph:/cold.js",
          }),
          expect.objectContaining({
            code: "RELEASE_CHUNK_OMITTED",
            inputPath: "bun-graph:/cold.cjs",
          }),
        ]),
      );
      const source = await NodeFSP.readFile(NodePath.join(output, "signalbox/release.js"), "utf8");
      expect(source).not.toContain("tier-one-payload");
      expect(source).not.toContain("tier-two-payload");
      expect(source).not.toContain("commonjs-payload");
      expect(built.manifest.omission).toMatchObject({
        configurationRemoved: ["bun-graph:/gated.js"],
        chunks: expect.arrayContaining([
          expect.objectContaining({ inputPath: "bun-graph:/gated.js", tier: "configuration" }),
          expect.objectContaining({ inputPath: "bun-graph:/cold.js", tier: "corpus" }),
        ]),
      });
      expect(built.manifest.mainExport).toBe("launch");
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed and ambiguous coverage", () => {
    expect(() => parseReleaseCoverageCorpus({})).toThrow("RELEASE_CORPUS_INVALID");
    expect(() =>
      parseReleaseCoverageCorpus({
        schemaVersion: 1,
        binarySha256,
        provenance: [{ name: "x", sha256: binarySha256 }],
        pending: [],
        inputs: [
          { inputPath: "x", initialized: false },
          { inputPath: "x", initialized: true },
        ],
      }),
    ).toThrow("RELEASE_CORPUS_INVALID");
  });

  it("specializes imported and local env aliases while preserving shadowed and reassigned bindings", () => {
    const sources = new Map([["/env", "const e=process.env;export{e};"]]);
    const pinned = createPinnedEnvironmentTransform(sources, configuration.env, (path) => path);
    const source = `import{e}from'/env';const local=process.env;const yes=e.DISABLE;const absent=local.ABSENT;function shadow(process){return process.env.DISABLE}let changed=process.env;changed={};const dynamic=changed.DISABLE;`;
    const result = pinned.transform(source, "/entry");
    expect(result).toContain('const yes="1"');
    expect(result).toContain("const absent=void 0");
    expect(result).toContain("return process.env.DISABLE");
    expect(result).toContain("const dynamic=changed.DISABLE");
  });
});
