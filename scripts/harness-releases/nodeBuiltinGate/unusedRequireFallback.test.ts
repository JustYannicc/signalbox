import { expect, it } from "vite-plus/test";
import { scanBuiltinSource } from "./source.ts";

const fallback = `var loader=(x=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(x,{get:(a,b)=>(typeof require<"u"?require:a)[b]}):x)(function(x){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+x+'" is not supported')});`;
const scan = (source: string) => scanBuiltinSource({ name: "published-worker.js", source });

it("does not require dynamic loading for the exact unused esbuild fallback", () => {
  expect(scan(fallback).functionAmbiguities).toEqual([]);
});

it.each([
  `${fallback}loader(selectedModule);`,
  `${fallback}export {loader};`,
  `${fallback}const alias=loader;consume(alias);`,
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
