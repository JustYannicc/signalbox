import { expect, it } from "vite-plus/test";
import { scanBuiltinSource } from "./source.ts";
import { linkPublishedSources } from "./publishedGraph.ts";
import { assertPackagedBuiltinCoverage } from "../nodeBuiltinGate.ts";

const fallback = `var loader=(x=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(x,{get:(a,b)=>(typeof require<"u"?require:a)[b]}):x)(function(x){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+x+'" is not supported')});`;
const scan = (source: string) => scanBuiltinSource({ name: "published-worker.js", source });

it("does not require dynamic loading for the exact unused esbuild fallback", () => {
  expect(scan(fallback).functionAmbiguities).toEqual([]);
});

it.each([
  fallback,
  fallback
    .replaceAll('typeof require<"u"', 'typeof require!=="undefined"')
    .replaceAll('typeof Proxy<"u"', 'typeof Proxy!=="undefined"'),
])("resolves static calls through either generated helper spelling", (helper) => {
  const inventory = scan(`${helper}loader("node:fs").readFileSync("/input");`);
  expect(inventory.requiredSpecifiers).toEqual(["node:fs"]);
  expect(inventory.requiredFunctions).toContainEqual(
    expect.objectContaining({ specifier: "fs", memberPath: ["readFileSync"] }),
  );
  expect(inventory.functionAmbiguities).toEqual([]);
});

it("checks actual builtin calls through the normal linker's require helper", async () => {
  const linked = await linkPublishedSources([
    {
      name: "release.js",
      source: 'export const load=()=>require("fs").readFileSync("/work/input")',
    },
  ]);
  const inventory = scanBuiltinSource(linked);
  expect(inventory.requiredSpecifiers).toContain("fs");
  expect(inventory.requiredFunctions).toContainEqual(
    expect.objectContaining({ specifier: "fs", memberPath: ["readFileSync"] }),
  );
  expect(inventory.functionAmbiguities).toEqual([]);
  const runtime = {
    modules: ["fs"],
    functions: [
      {
        specifier: "fs",
        memberPath: ["readFileSync"],
        status: "supported" as const,
        evidence: "fixture",
      },
    ],
    profile: {
      systemIdentity: {},
      processIdentity: {},
      filesystem: { posixPolicy: true, setUmask: true },
      cpu: { execution: false, processAccounting: false },
    },
  };
  await expect(assertPackagedBuiltinCoverage([linked], runtime)).resolves.toMatchObject({
    status: "pass",
  });
  await expect(
    assertPackagedBuiltinCoverage([linked], {
      ...runtime,
      functions: [{ ...runtime.functions[0]!, status: "unsupported" }],
    }),
  ).rejects.toThrow("unsupported-functions=fs.readFileSync");
});

it.each(["export const ready=true;", 'export const load=()=>loader("fs").readFileSync("/input");'])(
  "resolves nested helpers emitted by linking an existing generated helper: %s",
  async (consumer) => {
    const linked = await linkPublishedSources([
      { name: "release.js", source: `${fallback}${consumer}` },
    ]);
    const inventory = scanBuiltinSource(linked);
    expect(inventory.functionAmbiguities).toEqual([]);
    if (consumer.includes("readFileSync")) {
      expect(inventory.requiredSpecifiers).toContain("fs");
      expect(inventory.requiredFunctions).toContainEqual(
        expect.objectContaining({ specifier: "fs", memberPath: ["readFileSync"] }),
      );
    }
  },
);

it.each(["export const escaped=loader;", "export const dynamic=(name)=>loader(name);"])(
  "keeps an escaping or dynamic nested helper blocking: %s",
  async (consumer) => {
    const original = { name: "release.js", source: `${fallback}${consumer}` };
    const linked = await linkPublishedSources([original]);
    expect(
      [original, linked].flatMap((source) => scanBuiltinSource(source).functionAmbiguities),
    ).toContainEqual(expect.objectContaining({ kind: "dynamic-builtin-loader-call" }));
  },
);

it("retains builtin calls in unexported, uncalled module bodies during analysis linking", async () => {
  const linked = await linkPublishedSources([
    {
      name: "release.js",
      source:
        'function unused(){return require("vm").runInContext("code",{})} export const ready=true;',
    },
  ]);
  expect(scanBuiltinSource(linked).requiredFunctions).toContainEqual(
    expect.objectContaining({ specifier: "vm", memberPath: ["runInContext"] }),
  );
});

it("tracks the loader assigned once by a deferred module initializer", async () => {
  const linked = await linkPublishedSources([
    {
      name: "release.js",
      source: `${fallback}var bound; function init(){bound=loader} function run(){return (0,bound)("fs").readFileSync("/input")} export {init,run};`,
    },
  ]);
  const inventory = scanBuiltinSource(linked);
  expect(inventory.requiredSpecifiers).toContain("fs");
  expect(inventory.requiredFunctions).toContainEqual(
    expect.objectContaining({ specifier: "fs", memberPath: ["readFileSync"] }),
  );
  expect(inventory.functionAmbiguities).toEqual([]);
});

it.each([
  "var bound;function init(){bound=loader}function run(name){return bound(name)}",
  'var bound;function init(){bound=loader}function run(){bound=other;return bound("fs")}',
  "var bound;function init(){bound=loader}function run(){consume(bound)}",
  "var bound;function init(){bound=loader}function run(){bound++}",
  'var bound=other;function init(){bound=loader}function run(){return bound("fs")}',
])("keeps uncertain deferred aliases blocking: %s", async (consumer) => {
  const original = {
    name: "release.js",
    source: `${fallback}${consumer} export const ready=true;`,
  };
  const linked = await linkPublishedSources([original]);
  expect(
    [original, linked].flatMap((source) => scanBuiltinSource(source).functionAmbiguities),
  ).toContainEqual(expect.objectContaining({ kind: "dynamic-builtin-loader-call" }));
});

it.each([
  `${fallback}loader(selectedModule);`,
  `${fallback}export {loader};`,
  `${fallback}const alias=loader;consume(alias);`,
  `${fallback}loader.call(null,"fs");`,
  `${fallback}loader=(name)=>import(name);loader("fs");`,
  `${fallback}++loader;`,
  fallback.replace("var loader", "export var loader"),
  fallback.replace("require.apply(this,arguments)", "require.apply(other,arguments)"),
  fallback.replace(
    "return require.apply(this,arguments)",
    "return (touch(),require.apply(this,arguments))",
  ),
  `${fallback}eval(dynamicSource);`,
  `const Proxy=class{constructor(callback){callback(selectedModule)}};${fallback}`,
  `globalThis.Proxy=class{constructor(callback){callback(selectedModule)}};${fallback}`,
])("keeps a used, escaping or changed loader blocking", (source) => {
  expect(scan(source).functionAmbiguities).toContainEqual(
    expect.objectContaining({ kind: "dynamic-builtin-loader-call" }),
  );
});
