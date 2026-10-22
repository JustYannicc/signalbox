// @effect-diagnostics nodeBuiltinImport:off - exercise published release fixtures.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import { rebundle } from "./rebundle.ts";
import { parseReleaseCoverageCorpus, releaseSourceHash } from "./release-omission.ts";
import { createPinnedEnvironmentTransform } from "./pinned-environment.ts";

const binarySha256 = releaseSourceHash("fixture");
const configuration = { name: "qualification", env: { DISABLE: "1", ABSENT: null } } as const;

async function fixture(
  root: string,
  sources: Record<string, string> = {
    "/cli": `import {env} from './env.js';export const reachable=()=>21*2;export const configured=()=>env.DISABLE==='1'?'disabled':import('./gated.js');export const cold=()=>import('./cold.js');export const cjs=()=>import('./cold.cjs');export const unreported=()=>import('./unreported.js');export const coldRequire=()=>import.meta.require('./cold.js');export const cjsRequire=()=>import.meta.require('./cold.cjs');`,
    "/env.js": "const value=process.env;export{value as env};",
    "/gated.js": 'export const value="tier-one-payload";',
    "/cold.js": 'export function value(){return "tier-two-payload"}',
    "/cold.cjs":
      '(function(exports,require,module,__filename,__dirname){module.exports={value:"commonjs-payload"}})',
    "/unreported.js": 'export function value(){return "coverage-absent-payload"}',
  },
) {
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

async function textFixture(root: string) {
  const extracted = NodePath.join(root, "extracted");
  await NodeFSP.mkdir(extracted);
  const modules = [
    {
      index: 0,
      name: "/cli",
      loader: 1,
      encoding: 0,
      format: 1,
      contents: Buffer.from('import text from "./message.txt";export const actualData=text;'),
    },
    {
      index: 1,
      name: "/message.txt",
      loader: 13,
      encoding: 1,
      format: 0,
      contents: Buffer.from("actual imported text"),
    },
  ];
  const manifestModules = [];
  for (const { contents, ...module } of modules) {
    const path = `${module.index}.bin`;
    await NodeFSP.writeFile(NodePath.join(extracted, path), contents);
    manifestModules.push({
      ...module,
      artifacts: {
        contents: { path, bytes: contents.length, sha256: releaseSourceHash(contents.toString()) },
      },
    });
  }
  await NodeFSP.writeFile(
    NodePath.join(extracted, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      binary: { bytes: 1, sha256: binarySha256 },
      graph: { entry: 0 },
      modules: manifestModules,
    }),
  );
  return extracted;
}

const validCorpus = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1 as const,
  binarySha256,
  provenance: [{ name: "fixture-coverage", sha256: releaseSourceHash("coverage") }],
  pending: [],
  inputs: [],
  ...overrides,
});

const runtimeMutationCases: ReadonlyArray<{
  readonly name: string;
  readonly specifier: string;
  readonly sources: Record<string, string>;
  readonly layerModules?: Record<string, string>;
  readonly environmentPackageModules?: Record<string, string>;
}> = [
  {
    name: "a destructured CommonJS process environment",
    specifier: "./mutator.js",
    sources: {
      "/mutator.js": `const {env}=require("node:process");env.FLAG="changed";`,
    },
  },
  {
    name: "a computed global process environment",
    specifier: "./mutator.js",
    sources: {
      "/mutator.js": `globalThis["process"]["env"]["FLAG"]="changed";`,
    },
  },
  {
    name: "an aliased global object",
    specifier: "./mutator.js",
    sources: {
      "/mutator.js": `const g=global;g.process.env.FLAG="changed";`,
    },
  },
  {
    name: "a global object passed to unknown code",
    specifier: "./mutator.js",
    sources: {
      "/mutator.js": `const mutate=(g)=>{g.process.env.FLAG="changed";};mutate(globalThis);`,
    },
  },
  {
    name: "a layer module",
    specifier: "signalbox:mutation",
    sources: {},
    layerModules: {
      "signalbox:mutation": `const {env}=require("node:process");env.FLAG="changed";`,
    },
  },
  {
    name: "an environment package module",
    specifier: "signalbox:mutation",
    sources: {},
    environmentPackageModules: {
      "signalbox:mutation": `const {env}=require("node:process");env.FLAG="changed";`,
    },
  },
  {
    name: "a layer alias imported from an environment package",
    specifier: "signalbox:mutation",
    sources: {},
    layerModules: {
      "signalbox:mutation": `import{env}from"signalbox:environment";env.FLAG="changed";`,
    },
    environmentPackageModules: {
      "signalbox:environment": `const {env}=require("node:process");export{env};`,
    },
  },
];

const resolveSource =
  (sources: ReadonlyMap<string, string>) => (specifier: string, importer: string) => {
    const path = specifier.startsWith(".")
      ? NodePath.posix.resolve(NodePath.posix.dirname(importer), specifier)
      : specifier;
    return sources.has(path) ? path : undefined;
  };

const mutationCases: ReadonlyArray<{
  readonly name: string;
  readonly modules: ReadonlyArray<readonly [string, string]>;
}> = [
  {
    name: "a property assignment through an alias of process",
    modules: [["/mutator.js", "const p=process;p.env.FLAG='changed';"]],
  },
  {
    name: "whole-object replacement through an imported process alias",
    modules: [["/mutator.js", "import p from 'node:process';const alias=p;alias.env={};"]],
  },
  {
    name: "a property assignment in a source without a pinned read",
    modules: [["/mutator.js", "const env=process.env;env.FLAG='changed';"]],
  },
  {
    name: "a property deletion in a source without a pinned read",
    modules: [["/mutator.js", "const env=process.env;delete env.FLAG;"]],
  },
  {
    name: "whole-object replacement of an environment alias",
    modules: [["/mutator.js", "let env=process.env;env={};"]],
  },
  {
    name: "a write through an exported mutable alias after reassignment",
    modules: [
      [
        "/environment.js",
        "export let env=process.env;const original=env;env={};original.FLAG='changed';",
      ],
    ],
  },
  {
    name: "a write through an imported exported alias",
    modules: [
      ["/environment.js", "export let env=process.env;"],
      ["/mutator.js", "import{env}from'./environment.js';env.FLAG='changed';"],
    ],
  },
  {
    name: "an exported mutable environment alias that may escape the source graph",
    modules: [["/environment.js", "export let env=process.env;"]],
  },
  {
    name: "a presence check using in",
    modules: [["/probe.js", "const env=process.env;const present='FLAG' in env;"]],
  },
  {
    name: "a presence check using Object.hasOwn",
    modules: [["/probe.js", "const env=process.env;const present=Object.hasOwn(env,'FLAG');"]],
  },
  {
    name: "a presence check using hasOwnProperty",
    modules: [["/probe.js", "const env=process.env;const present=env.hasOwnProperty('FLAG');"]],
  },
  {
    name: "an environment alias passed to unknown code",
    modules: [["/probe.js", "const env=process.env;inspectEnvironment(env);"]],
  },
  {
    name: "a destructured CommonJS process environment",
    modules: [["/mutator.js", 'const {env}=require("node:process");env.FLAG="changed";']],
  },
  {
    name: "an import.meta.require process alias",
    modules: [
      ["/mutator.js", 'const proc=import.meta.require("process");proc.env.FLAG="changed";'],
    ],
  },
  {
    name: "aliases of a CommonJS process environment",
    modules: [
      [
        "/mutator.js",
        'const proc=require("node:process");const env=proc.env;const alias=env;alias.FLAG="changed";',
      ],
    ],
  },
  {
    name: "a computed write through a CommonJS process alias",
    modules: [["/mutator.js", 'const proc=require("process");proc[key].FLAG="changed";']],
  },
  {
    name: "a CommonJS process value passed to unknown code",
    modules: [["/mutator.js", 'inspect(require("process"));']],
  },
  {
    name: "an import.meta.require environment that escapes to unknown code",
    modules: [["/mutator.js", 'inspect(import.meta.require("node:process").env);']],
  },
];

describe("release omission", () => {
  it.each(runtimeMutationCases)(
    "keeps runtime environment reads live after $name",
    async ({ specifier, sources: extraSources, layerModules, environmentPackageModules }) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-omission-live-"));
      const previous = process.env.FLAG;
      try {
        const extracted = await fixture(root, {
          "/cli": `import ${JSON.stringify(specifier)};export const read=process.env.FLAG;export const run=()=>process.env.FLAG==="on"?"pinned":"dynamic";`,
          ...extraSources,
        });
        const output = NodePath.join(root, "bundle");
        await rebundle({
          extracted,
          output,
          version: "fixture",
          platform: "linux-x64",
          deferInitialization: true,
          ...(layerModules ? { layerModules } : {}),
          ...(environmentPackageModules ? { environmentPackageModules } : {}),
          omission: { configuration: { name: "qualification", env: { FLAG: "on" } } },
        });
        await NodeFSP.writeFile(NodePath.join(output, "package.json"), '{"type":"module"}');
        const launcher = await import(
          NodeURL.pathToFileURL(NodePath.join(output, "claude.js")).href
        );
        const release = launcher.launch();
        expect(process.env.FLAG).toBe("changed");
        expect.soft(release.read).toBe("changed");
        expect.soft(release.run()).toBe("dynamic");
      } finally {
        if (previous === undefined) delete process.env.FLAG;
        else process.env.FLAG = previous;
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("omits configured and corpus-cold payloads, preserves reachable code, and reports failed initialization", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-omission-"));
    const reports: unknown[] = [];
    const key = Symbol.for("signalbox.releaseModuleOmitted");
    const previous = Reflect.get(globalThis, key);
    Reflect.set(globalThis, key, (event: unknown) => {
      reports.push(event);
      throw new Error("reporter transport unavailable");
    });
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
      expect((await release.unreported()).value()).toBe("coverage-absent-payload");
      for (const name of [
        "coldRequire",
        "coldRequire",
        "cjsRequire",
        "cjsRequire",
        "cold",
        "cjs",
      ]) {
        await expect(Promise.resolve().then(() => release[name]())).rejects.toMatchObject({
          name: "ReleaseModuleOmittedError",
          code: "RELEASE_MODULE_OMITTED",
          inputPath: `bun-graph:/${name.startsWith("cjs") ? "cold.cjs" : "cold.js"}`,
          tier: "corpus",
        });
      }
      expect(reports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "RELEASE_MODULE_OMITTED",
            inputPath: "bun-graph:/cold.js",
          }),
          expect.objectContaining({
            code: "RELEASE_MODULE_OMITTED",
            inputPath: "bun-graph:/cold.cjs",
          }),
        ]),
      );
      const source = await NodeFSP.readFile(NodePath.join(output, "signalbox/release.js"), "utf8");
      expect(source).not.toContain("tier-one-payload");
      expect(source).not.toContain("tier-two-payload");
      expect(source).not.toContain("commonjs-payload");
      expect(source).toContain("RELEASE_MODULE_OMITTED");
      expect(source).toContain("signalbox.releaseModuleOmitted");
      expect(source).not.toContain("mirror HarnessProcessLifetime");
      expect(built.manifest.omission).toMatchObject({
        configuration: { name: "qualification" },
        configurationRemoved: ["bun-graph:/gated.js"],
        corpus: {
          binarySha256,
          provenance: [{ name: "fixture-coverage", sha256: releaseSourceHash("coverage") }],
        },
      });
      expect(built.manifest.omission?.omittedModules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ inputPath: "bun-graph:/gated.js", tier: "configuration" }),
          expect.objectContaining({ inputPath: "bun-graph:/cold.js", tier: "corpus" }),
        ]),
      );
      expect(built.manifest.omission?.omittedModules).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ inputPath: "bun-graph:/unreported.js" }),
        ]),
      );
      expect(built.manifest.mainExport).toBe("launch");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, key);
      else Reflect.set(globalThis, key, previous);
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("records configuration removals without replacing statically imported modules with throwing stubs", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-omission-static-"));
    try {
      const extracted = await fixture(root, {
        "/cli": `import {value} from './erased.js';export const result=process.env.FLAG==='on'?value:'configuration-kept';`,
        "/erased.js": 'export const value="configuration-only-payload";',
      });
      const output = NodePath.join(root, "bundle");
      const built = await rebundle({
        extracted,
        output,
        version: "fixture",
        platform: "linux-x64",
        omission: {
          configuration: { name: "qualification", env: { FLAG: null } },
        },
      });
      await expect(
        import(NodeURL.pathToFileURL(NodePath.join(output, "claude.js")).href).then(
          ({ result }) => result,
        ),
      ).resolves.toBe("configuration-kept");
      expect(built.manifest.omission?.configurationRemoved).toContain("bun-graph:/erased.js");
      expect(built.manifest.omission?.omittedModules).toContainEqual(
        expect.objectContaining({ inputPath: "bun-graph:/erased.js", tier: "configuration" }),
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps loader 13 imported text as source data and outside omission records", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-omission-text-"));
    try {
      const extracted = await textFixture(root);
      const output = NodePath.join(root, "bundle");
      const built = await rebundle({
        extracted,
        output,
        version: "fixture",
        platform: "linux-x64",
        deferInitialization: true,
        omission: {
          configuration,
          corpus: validCorpus({
            inputs: [{ inputPath: "bun-graph:/message.txt", initialized: false }],
          }),
        },
      });
      await NodeFSP.writeFile(NodePath.join(output, "package.json"), '{"type":"module"}');
      const launcher = await import(NodeURL.pathToFileURL(NodePath.join(output, "claude.js")).href);
      expect(launcher.launch().actualData).toBe("actual imported text");
      expect(built.manifest.omission?.omittedModules).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ inputPath: "bun-graph:/message.txt" })]),
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects coverage pinned to another binary", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-omission-binary-"));
    try {
      const extracted = await fixture(root);
      await expect(
        rebundle({
          extracted,
          output: NodePath.join(root, "bundle"),
          version: "fixture",
          platform: "linux-x64",
          omission: {
            configuration,
            corpus: validCorpus({ binarySha256: releaseSourceHash("another binary") }),
          },
        }),
      ).rejects.toThrow("RELEASE_CORPUS_BINARY_MISMATCH");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects coverage rows that do not name a source module", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-omission-unknown-"));
    try {
      const extracted = await fixture(root);
      await expect(
        rebundle({
          extracted,
          output: NodePath.join(root, "bundle"),
          version: "fixture",
          platform: "linux-x64",
          omission: {
            configuration,
            corpus: validCorpus({
              inputs: [{ inputPath: "bun-graph:/not-in-the-binary.js", initialized: false }],
            }),
          },
        }),
      ).rejects.toThrow("RELEASE_CORPUS_INPUT_UNKNOWN");
    } finally {
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

  it.each(mutationCases)("keeps direct environment reads dynamic after $name", ({ modules }) => {
    const entry = "export const current=process.env.FLAG;";
    const sources = new Map<string, string>([["/entry.js", entry], ...modules]);
    const pinned = createPinnedEnvironmentTransform(
      sources,
      { ...configuration.env, FLAG: "on" },
      resolveSource(sources),
    );
    expect(pinned.transform(entry, "/entry.js")).toContain("process.env.FLAG");
  });

  it("keeps post-delete property reads consistent with the runtime environment object", () => {
    const sources = new Map<string, string>();
    const pinned = createPinnedEnvironmentTransform(sources, { FLAG: "on" }, (path) => path);
    const transformed = pinned.transform(
      "const env=process.env;delete env.FLAG;['FLAG' in env,env.FLAG];",
      "/entry.js",
    );
    const result = NodeVM.runInNewContext(transformed, { process: { env: { FLAG: "on" } } });
    expect(result).toEqual([false, undefined]);
  });
});
