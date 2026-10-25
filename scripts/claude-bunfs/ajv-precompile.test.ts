// @effect-diagnostics nodeBuiltinImport:off - build-time fixture bundling reads generated modules from disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import addFormatsModule from "ajv-formats";
import { Ajv as ReferenceAjv } from "ajv";
import { Ajv2019 as ReferenceAjv2019 } from "ajv/dist/2019.js";
import { Ajv2020 as ReferenceAjv2020 } from "ajv/dist/2020.js";
import { build } from "esbuild";
import { describe, expect, it } from "@effect/vitest";
import {
  AjvPrecompileError,
  AjvConstructorTransformError,
  discoverAjvSchemas,
  precompileAjvMetaValidators,
  precompileAjvModule,
  replaceEmbeddedAjvConstructors,
} from "./ajv-precompile.ts";
import { createInterpretedAjv } from "./ajv-precompile-interpreter.ts";
import {
  assertAjvCompatibility,
  createPrecompiledAjvRegistry,
  resetAjvCompatibility,
  UnsupportedAjvSchemaError,
} from "./ajv-precompile-runtime.ts";

const resolveDir = NodeURL.fileURLToPath(new URL("./", import.meta.url));

async function bundleRegistry(source: string, files: Map<string, string>) {
  const output = await build({
    stdin: { contents: source, resolveDir, sourcefile: "registry.js" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "Registry",
    legalComments: "inline",
    plugins: [
      {
        name: "generated-validators",
        setup(builder) {
          builder.onResolve({ filter: /^generated:/ }, (args) => ({
            path: args.path,
            namespace: "generated",
          }));
          builder.onLoad({ filter: /.*/, namespace: "generated" }, async (args) => {
            if (args.path === "generated:runtime")
              return {
                contents: await NodeFSP.readFile(
                  new URL("./ajv-precompile-runtime.ts", import.meta.url),
                  "utf8",
                ),
                loader: "ts",
                resolveDir,
              };
            if (args.path === "generated:interpreter")
              return {
                contents: await NodeFSP.readFile(
                  new URL("./ajv-precompile-interpreter.ts", import.meta.url),
                  "utf8",
                ),
                loader: "ts",
                resolveDir,
              };
            const contents = files.get(args.path);
            if (!contents) throw new Error(`Missing generated file ${args.path}`);
            return { contents, loader: "js", resolveDir };
          });
        },
      },
    ],
  });
  const code = output.outputFiles[0]?.text;
  if (!code) throw new Error("No bundle emitted");
  return {
    code,
    context: NodeVM.createContext({ URL }, { codeGeneration: { strings: false, wasm: false } }),
  };
}

describe("AJV build-time compilation", () => {
  it("binds extensionless extracted keys without changing their diagnostic identity", () => {
    const key = "$bunfs/root/cli";
    const source =
      "class Base{};class Child extends Base{};const location=import.meta.url;const a=new lib.Ajv({allErrors:false});a.compile({type:'string'});";
    const analysis = discoverAjvSchemas({ key, source, format: 1 });
    expect(analysis.key).toBe(key);
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.calls).toHaveLength(1);
    expect(analysis.calls[0]?.profile?.options).toEqual({ allErrors: false });
    expect(analysis.calls[0]?.site.module).toBe(key);
    expect(analysis.calls[0]?.site.id).toBe(`${key}:${source.indexOf("a.compile")}`);
    const options = {
      registrySpecifier: "registry",
      runtimeSpecifier: "runtime",
      validatorSpecifier: (id: string) => id,
    };
    expect(precompileAjvModule(analysis, options).compiledSiteCount).toBe(1);
    const dynamic = discoverAjvSchemas({
      key,
      source: `${source}a.compile(schema);`,
      format: 1,
    });
    expect(dynamic.diagnostics[0]?.module).toBe(key);
    expect(dynamic.diagnostics[0]?.code).toBe("AJV_DYNAMIC_SCHEMA");
    expect(() => precompileAjvModule(dynamic, options)).toThrow(AjvPrecompileError);
  });

  it("keeps bindings separate and preserves constructor options", () => {
    const analysis = discoverAjvSchemas({
      key: "fixture.js",
      source: `import Ajv from 'ajv';
      const schema={type:'object',required:['name'],properties:{name:{type:'string'}}};
      const a=new Ajv({allErrors:!0,strict:!1});a.compile(schema);
      function other(){const schema={type:'integer'};const a=new Ajv();return a.compile(schema)}`,
    });
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.calls).toHaveLength(2);
    expect(analysis.calls[0]?.profile?.options).toEqual({ allErrors: true, strict: false });
    expect(analysis.calls[1]?.schema).toEqual({ type: "integer" });
  });

  it("does not precompile options that escaped through a mutating call or alias", () => {
    for (const mutation of [
      "Object.assign(opts,{allErrors:true});",
      "const alias=opts;Object.assign(alias,{allErrors:true});",
      "opts.allErrors=true;",
      "const alias=opts;alias.allErrors=true;",
      "const alias=opts;mutate(alias);",
      "delete opts.allErrors;",
      "let alias;alias=opts;alias.allErrors=true;",
      "const h={opts};h.opts.allErrors=true;",
      "const h={};h.o=opts;h.o.allErrors=true;",
      "new Mutator(opts);",
      "mutate((opts));",
      "const alias=()=>opts;mutate(alias());",
    ]) {
      const input = {
        key: "escaped.js",
        source: `import Ajv from 'ajv';const opts={allErrors:false};${mutation}const a=new Ajv(opts);a.compile({type:'object',required:['a','b']});`,
      };
      const analysis = discoverAjvSchemas(input);
      expect(analysis.diagnostics.map((issue) => issue.code)).toContain("AJV_UNKNOWN_PROFILE");
      expect(() =>
        precompileAjvModule(analysis, {
          registrySpecifier: "registry",
          runtimeSpecifier: "runtime",
          validatorSpecifier: (id) => id,
        }),
      ).toThrow(AjvPrecompileError);
    }
  });

  it("precompiles only inline options and receivers used exclusively by direct compile calls", () => {
    const options = {
      registrySpecifier: "registry",
      runtimeSpecifier: "runtime",
      validatorSpecifier: (id: string) => id,
      allowUnresolved: true,
      preserveUnresolvedCalls: true,
    };
    for (const source of [
      "const o={allErrors:false};const a=new lib.Ajv(o);a.compile({type:'string'});",
      "const o={strictSchema:false};mutate`${o}`;const a=new lib.Ajv(o);a.compile({unknownKeyword:true});",
      "const o={strictSchema:false};o['__defineGetter__']('strictSchema',()=>true);const a=new lib.Ajv(o);a.compile({unknownKeyword:true});",
      "var o={allErrors:false};var o={allErrors:true};const a=new lib.Ajv(o);a.compile({type:'string'});",
      "const allErrors=false;const a=new lib.Ajv({allErrors});a.compile({type:'string'});",
      "const flag=false;const a=new lib.Ajv({allErrors:flag});a.compile({type:'string'});",
      "const o={allErrors:false};const a=new lib.Ajv({...o});a.compile({type:'string'});",
      ...[
        "const b=x?a:{};",
        "const b=x||a;",
        "const b=x??a;",
        "const b=x&&a;",
        "const b=(x,a);",
        "const b=await a;",
        "mutate`${a}`;",
        "a['addFormat']('custom',()=>true);",
        "const b=a;",
        "a=new lib.Ajv({allErrors:true});",
      ].map(
        (escape) => `let a=new lib.Ajv({allErrors:false});${escape}a.compile({type:'string'});`,
      ),
      "var a=new lib.Ajv({allErrors:false});var a=new lib.Ajv({allErrors:true});a.compile({type:'string'});",
    ]) {
      const result = precompileAjvModule({ key: "eligibility.js", source }, options);
      expect(result.analysis.calls).toHaveLength(1);
      expect(result.analysis.calls[0]?.profile).toBeUndefined();
      expect(result.compiledSiteCount).toBe(0);
      expect(result.source).toContain("a.compile(");
    }
    const control = precompileAjvModule(
      {
        key: "inline.js",
        source:
          "const schema={type:'string'};const a=new lib.Ajv({allErrors:false});a.compile(schema);a.compile({type:'integer'});",
      },
      options,
    );
    expect(control.diagnostics).toEqual([]);
    expect(control.compiledSiteCount).toBe(2);
    expect(control.validators).toHaveLength(2);
  });

  it("keeps plain exported receivers interpreted when importers can add formats", async () => {
    const options = {
      registrySpecifier: "generated:registry",
      runtimeSpecifier: "generated:runtime",
      validatorSpecifier: (id: string) => `generated:${id}`,
      allowUnresolved: true,
      preserveUnresolvedCalls: true,
    };
    for (const exported of ["export {a};", "export {a as renamed};", "export default a;"]) {
      const result = precompileAjvModule(
        {
          key: "exported.js",
          source: `const a=new lib.Ajv({strict:false});a.compile({type:'string',format:'email'});${exported}`,
        },
        options,
      );
      expect(result.analysis.calls).toHaveLength(1);
      expect(result.analysis.calls[0]?.profile).toBeUndefined();
      expect(result.compiledSiteCount).toBe(0);
    }
    const result = precompileAjvModule(
      {
        key: "exported-runtime.mjs",
        source:
          "import {createInterpretedAjv} from 'generated:interpreter';const lib={Ajv:createInterpretedAjv({draft7:()=>true,'2019':()=>true,'2020':()=>true})};const a=new lib.Ajv({strict:false});a.compile({type:'string',format:'email'});export {a};export const next=()=>a.compile({type:'string',format:'email'});",
      },
      options,
    );
    expect(result.compiledSiteCount).toBe(0);
    const files = new Map([["generated:exported", result.source]]);
    if (result.registrySource) files.set("generated:registry", result.registrySource);
    const { code, context } = await bundleRegistry(
      "import {a,next} from 'generated:exported';a.addFormat('email',/^valid$/);export const valid=next()('valid');export const invalid=next()('bad');",
      files,
    );
    new NodeVM.Script(code).runInContext(context);
    const reference = new ReferenceAjv({ strict: false });
    reference.addFormat("email", /^valid$/);
    const validate = reference.compile({ type: "string", format: "email" });
    expect(new NodeVM.Script("Registry.valid").runInContext(context)).toBe(validate("valid"));
    expect(new NodeVM.Script("Registry.invalid").runInContext(context)).toBe(validate("bad"));
  });

  it("rejects prototype-setting literals instead of decoding them as JSON properties", () => {
    const options = {
      registrySpecifier: "registry",
      runtimeSpecifier: "runtime",
      validatorSpecifier: (id: string) => id,
      allowUnresolved: true,
      preserveUnresolvedCalls: true,
    };
    for (const name of ["__proto__", "'__proto__'"])
      for (const source of [
        `const a=new lib.Ajv({strict:false,${name}:{unicodeRegExp:false}});a.compile({type:'string',pattern:${JSON.stringify("^\\p{L}$")}});`,
        `const a=new lib.Ajv({strict:false,${name}:{messages:false}});a.compile({type:'string'});`,
        `const a=new lib.Ajv({strict:false});a.compile({${name}:{type:'string'}});`,
      ]) {
        const result = precompileAjvModule({ key: "prototype.js", source }, options);
        expect(result.analysis.calls).toHaveLength(1);
        expect(result.compiledSiteCount).toBe(0);
        expect(result.source).toContain("a.compile(");
      }
    const inherited = { __proto__: { unicodeRegExp: false }, strict: false };
    expect(new ReferenceAjv(inherited).compile({ type: "string", pattern: "^\\p{L}$" })("é")).toBe(
      false,
    );
    const messages = { __proto__: { messages: false }, strict: false };
    const validate = new ReferenceAjv(messages).compile({ type: "string" });
    expect(validate(3)).toBe(false);
    expect(validate.errors?.[0]?.message).toBeUndefined();
  });

  it("preserves own __proto__ schema keys from shorthand and spread in generated registries", async () => {
    const properties = JSON.parse('{"__proto__":{"type":"string"}}');
    const schema = { type: "object", properties };
    const reference = new ReferenceAjv({ strict: false }).compile(schema);
    const values = [{}, JSON.parse('{"__proto__":"valid"}'), JSON.parse('{"__proto__":7}')];
    for (const source of [
      "const __proto__={type:'string'};const a=new lib.Ajv({strict:false});a.compile({type:'object',properties:{__proto__}});",
      "const __proto__={type:'string'};const map={__proto__};const a=new lib.Ajv({strict:false});a.compile({type:'object',properties:{...map}});",
    ]) {
      const result = precompileAjvModule(
        { key: "own-prototype.js", source },
        {
          registrySpecifier: "generated:registry",
          runtimeSpecifier: "generated:runtime",
          validatorSpecifier: (id) => `generated:${id}`,
        },
      );
      expect(result.compiledSiteCount).toBe(1);
      const files = new Map(
        result.validators.map((entry) => [`generated:${entry.id}`, entry.source]),
      );
      const { code, context } = await bundleRegistry(result.registrySource ?? "", files);
      new NodeVM.Script(code).runInContext(context);
      const site = result.analysis.calls[0]?.site.id;
      for (const value of values)
        expect(
          new NodeVM.Script(
            `Registry.compile(JSON.parse(${JSON.stringify(JSON.stringify(schema))}),${JSON.stringify(site)})(JSON.parse(${JSON.stringify(JSON.stringify(value))}))`,
          ).runInContext(context),
        ).toBe(reference(value));
    }
  });

  it("preserves own __proto__ in standalone const and enum values without rewriting string contents", async () => {
    const matching = JSON.parse('{"__proto__":{"tag":"expected"}}');
    const nonmatching = JSON.parse('{"__proto__":{"tag":"other"}}');
    for (const keyword of ["const", "enum"]) {
      const schema = keyword === "const" ? { const: matching } : { enum: [matching] };
      const reference = new ReferenceAjv({ strict: false }).compile(schema);
      expect(reference({})).toBe(false);
      expect(reference(matching)).toBe(true);
      expect(reference(nonmatching)).toBe(false);
      const expression = keyword === "const" ? "{const:{__proto__}}" : "{enum:[{__proto__}]}";
      const result = precompileAjvModule(
        {
          key: `prototype-${keyword}.js`,
          source: `const __proto__={tag:'expected'};const a=new lib.Ajv({strict:false});a.compile(${expression});a.compile({const:'literal {"__proto__":123}'});`,
        },
        {
          registrySpecifier: "generated:registry",
          runtimeSpecifier: "generated:runtime",
          validatorSpecifier: (id) => `generated:${id}`,
        },
      );
      expect(result.compiledSiteCount).toBe(2);
      const files = new Map(
        result.validators.map((entry) => [`generated:${entry.id}`, entry.source]),
      );
      const { code, context } = await bundleRegistry(result.registrySource ?? "", files);
      new NodeVM.Script(code).runInContext(context);
      const site = result.analysis.calls[0]?.site.id;
      for (const value of [{}, matching, nonmatching])
        expect(
          new NodeVM.Script(
            `Registry.compile(JSON.parse(${JSON.stringify(JSON.stringify(schema))}),${JSON.stringify(site)})(JSON.parse(${JSON.stringify(JSON.stringify(value))}))`,
          ).runInContext(context),
        ).toBe(reference(value));
      const stringSchema = { const: 'literal {"__proto__":123}' };
      const stringSite = result.analysis.calls[1]?.site.id;
      for (const value of [stringSchema.const, 'literal {["__proto__"]:123}'])
        expect(
          new NodeVM.Script(
            `Registry.compile(${JSON.stringify(stringSchema)},${JSON.stringify(stringSite)})(${JSON.stringify(value)})`,
          ).runInContext(context),
        ).toBe(value === stringSchema.const);
    }
  });

  it("leaves deleted options to the interpreter under the code-generation ban", async () => {
    const source =
      "import {createInterpretedAjv} from 'generated:interpreter';const lib={Ajv:createInterpretedAjv({draft7:()=>true,'2019':()=>true,'2020':()=>true})};const opts={strictSchema:false};delete opts.strictSchema;const a=new lib.Ajv(opts);export const check=()=>a.compile({unknownKeyword:true});";
    const result = precompileAjvModule(
      { key: "deleted-options.mjs", source },
      {
        registrySpecifier: "generated:registry",
        runtimeSpecifier: "generated:runtime",
        validatorSpecifier: (id) => `generated:${id}`,
        allowUnresolved: true,
        preserveUnresolvedCalls: true,
      },
    );
    expect(result.analysis.calls).toHaveLength(1);
    expect(result.analysis.calls[0]?.profile).toBeUndefined();
    expect(result.validators).toHaveLength(0);
    const files = new Map([["generated:deleted-options", result.source]]);
    if (result.registrySource) files.set("generated:registry", result.registrySource);
    const { code, context } = await bundleRegistry(
      "export {check} from 'generated:deleted-options';",
      files,
    );
    new NodeVM.Script(code).runInContext(context);
    const options = { strictSchema: false };
    Reflect.deleteProperty(options, "strictSchema");
    expect(() => new ReferenceAjv(options).compile({ unknownKeyword: true })).toThrow();
    expect(() => new NodeVM.Script("Registry.check()").runInContext(context)).toThrow(
      /Unknown AJV schema keyword/,
    );
  });

  it("preserves compile registration before getSchema and validate", async () => {
    const source =
      "import {createInterpretedAjv} from 'generated:interpreter';const lib={Ajv:createInterpretedAjv({draft7:()=>true,'2019':()=>true,'2020':()=>true})};const a=new lib.Ajv({strict:false});a.compile({$id:'urn:x',type:'string'});export const valid=a.validate('urn:x','ok');export const invalid=a.getSchema('urn:x')(3);";
    const result = precompileAjvModule(
      { key: "stateful.mjs", source },
      {
        registrySpecifier: "generated:registry",
        runtimeSpecifier: "generated:runtime",
        validatorSpecifier: (id) => `generated:${id}`,
        allowUnresolved: true,
        preserveUnresolvedCalls: true,
      },
    );
    expect(result.validators).toHaveLength(0);
    expect(result.analysis.calls).toHaveLength(1);
    expect(result.diagnostics.map((issue) => issue.code)).toContain("AJV_RUNTIME_API");
    expect(result.source).toContain("a.compile({$id:'urn:x'");
    const files = new Map([["generated:stateful", result.source]]);
    if (result.registrySource) files.set("generated:registry", result.registrySource);
    const { code, context } = await bundleRegistry(
      "export {valid,invalid} from 'generated:stateful';",
      files,
    );
    new NodeVM.Script(code).runInContext(context);
    expect(new NodeVM.Script("Registry.valid").runInContext(context)).toBe(true);
    expect(new NodeVM.Script("Registry.invalid").runInContext(context)).toBe(false);
    const analysis = discoverAjvSchemas({
      key: "state.js",
      source:
        "const a=new lib.Ajv();a.compile({$id:'urn:x',type:'string'});a.validate('urn:x','ok');",
    });
    expect(analysis.diagnostics.map((issue) => issue.code)).toContain("AJV_RUNTIME_API");
    const registration = discoverAjvSchemas({
      key: "registration.js",
      source: "const a=new lib.Ajv();a.compile({$id:'urn:x',type:'string'});",
    });
    expect(registration.calls[0]?.profile).toBeUndefined();
    expect(registration.calls[0]?.site.reason).toContain("registers runtime state");
  });

  it("runs generated validators with string code generation disabled", async () => {
    const schema = {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", minLength: 2 } },
      additionalProperties: false,
    };
    const result = precompileAjvModule(
      {
        key: "fixture.js",
        source: `import Ajv from 'ajv'; const a=new Ajv({allErrors:true}); a.compile(${JSON.stringify(schema)}); a.compile(${JSON.stringify(schema)})`,
      },
      {
        registrySpecifier: "generated:registry",
        runtimeSpecifier: "generated:runtime",
        validatorSpecifier: (id) => `generated:${id}`,
      },
    );
    expect(result.validators).toHaveLength(1);
    expect(result.compiledSiteCount).toBe(2);
    const files = new Map(
      result.validators.map((entry) => [`generated:${entry.id}`, entry.source]),
    );
    const { code, context } = await bundleRegistry(result.registrySource ?? "", files);
    new NodeVM.Script(code).runInContext(context);
    for (const { site } of result.analysis.calls) {
      expect(
        new NodeVM.Script(
          `Registry.compile(${JSON.stringify(schema)},${JSON.stringify(site.id)})({name:'Ada'})`,
        ).runInContext(context),
      ).toBe(true);
      expect(
        new NodeVM.Script(
          `Registry.compile(${JSON.stringify(schema)},${JSON.stringify(site.id)})({name:3,extra:true})`,
        ).runInContext(context),
      ).toBe(false);
    }
    expect(() => new NodeVM.Script("new Function('return 1')").runInContext(context)).toThrow();
  });

  it("does not silently accept invalid or dynamic schemas", () => {
    expect(() =>
      precompileAjvModule(
        { key: "bad.js", source: "const a=new lib.Ajv(); a.compile({type:'garbage'})" },
        {
          registrySpecifier: "registry",
          runtimeSpecifier: "runtime",
          validatorSpecifier: (id) => id,
        },
      ),
    ).toThrow(AjvPrecompileError);
    const analysis = discoverAjvSchemas({
      key: "mcp.js",
      source:
        "function f(schema){const {Ajv2020:A}=load();return new A({strict:false,validateFormats:false}).compile(schema)}",
    });
    expect(analysis.calls[0]?.profile?.dialect).toBe("2020");
    expect(analysis.diagnostics.map((issue) => issue.code)).toContain("AJV_DYNAMIC_SCHEMA");
    const lookup = createPrecompiledAjvRegistry(
      [],
      analysis.calls.map((call) => call.site),
    );
    expect(() =>
      lookup({ $id: "mcp:tool", type: "object" }, analysis.calls[0]?.site.id ?? ""),
    ).toThrow(UnsupportedAjvSchemaError);
  });

  it("rejects schema mutation rather than reusing a different validator", () => {
    const site = { id: "fixture:1", module: "fixture", offset: 1 };
    const lookup = createPrecompiledAjvRegistry(
      [{ site, schema: { type: "string" }, validate: () => true }],
      [site],
    );
    expect(() => lookup({ type: "number" }, site.id)).toThrow(/differs/);
  });

  it("replaces minified declarations and expressions through AJV exports", () => {
    const result = replaceEmbeddedAjvConstructors(
      {
        key: "bundled.js",
        source: `function moduleA(e){class x extends base{_addVocabularies(){}_addDefaultMetaSchema(){}defaultMeta(){}}e.Ajv=x}
      function moduleB(e){var y=class extends base{_addVocabularies(){}_addDefaultMetaSchema(){}defaultMeta(){}};e.Ajv2020=y}`,
      },
      "adapter",
    );
    expect(result.constructors.map((item) => item.dialect)).toEqual(["draft7", "2020"]);
    expect(result.source).not.toContain("extends base");
    expect(result.source).toContain("createAjv");
  });

  it("preserves CommonJS exports when replacing bundled constructors", async () => {
    const result = replaceEmbeddedAjvConstructors(
      {
        key: "legacy.cjs",
        format: 2,
        source: `class A extends base{_addVocabularies(){}_addDefaultMetaSchema(){}defaultMeta(){}}module.exports.Ajv=A;`,
      },
      "generated:adapter",
    );
    const files = new Map([
      ["generated:legacy", result.source],
      [
        "generated:adapter",
        "exports.createAjv=()=>class{compile(){return value=>typeof value==='string'}}",
      ],
    ]);
    const { code, context } = await bundleRegistry(
      "import legacy from 'generated:legacy';export const valid=new legacy.Ajv().compile({type:'string'})('ok');",
      files,
    );
    new NodeVM.Script(code).runInContext(context);
    expect(new NodeVM.Script("Registry.valid").runInContext(context)).toBe(true);
  });

  it("keeps CommonJS strict mode after inserting adapter and registry bindings", () => {
    const source = `'use strict';"another directive";exports.strictThis=function(){return this};class A extends base{_addVocabularies(){}_addDefaultMetaSchema(){}defaultMeta(){}}module.exports.Ajv=A;`;
    const constructors = replaceEmbeddedAjvConstructors(
      { key: "strict.cjs", format: 2, source },
      "adapter",
    );
    const compiled = precompileAjvModule(
      {
        key: "strict-schema.cjs",
        format: 2,
        source: `'use strict';exports.strictThis=function(){return this};const a=new lib.Ajv();a.compile({type:'string'});`,
      },
      {
        registrySpecifier: "registry",
        runtimeSpecifier: "runtime",
        validatorSpecifier: (id) => id,
      },
    );
    for (const transformed of [constructors.source, compiled.source]) {
      const context = NodeVM.createContext({}, { codeGeneration: { strings: false, wasm: false } });
      const script = `const lib={Ajv:class{}};const m={exports:{}};const require=()=>({createAjv:()=>class{},compile:()=>()=>true});(function(module,exports,require){${transformed}\n})(m,m.exports,require);(0,m.exports.strictThis)();`;
      expect(new NodeVM.Script(script).runInContext(context)).toBeUndefined();
    }
  });

  it("rewrites named class expressions through their outer export binding", () => {
    const transformed = replaceEmbeddedAjvConstructors(
      {
        key: "named.cjs",
        format: 2,
        source:
          "var y=class x extends base{_addVocabularies(){}_addDefaultMetaSchema(){}defaultMeta(){}};exports.Ajv2020=y;",
      },
      "adapter",
    );
    const context = NodeVM.createContext({}, { codeGeneration: { strings: false, wasm: false } });
    const script = `const exports={};const require=()=>({createAjv:dialect=>class{constructor(){this.dialect=dialect}}});${transformed.source}\nnew exports.Ajv2020().dialect`;
    expect(new NodeVM.Script(script).runInContext(context)).toBe("2020");
  });

  it("rejects JTD and unresolved known AJV exports before generating a bundle", () => {
    for (const source of [
      "class A extends base{_addVocabularies(){}_addDefaultMetaSchema(){}defaultMeta(){}compileSerializer(){}compileParser(){}}exports.Ajv=A;",
      "exports.Ajv=unresolved;",
      "exports.Ajv2020=namespace.default;",
    ]) {
      expect(() =>
        replaceEmbeddedAjvConstructors({ key: "unsupported.js", source }, "adapter"),
      ).toThrow(AjvConstructorTransformError);
    }
  });

  it("keeps an ESM hashbang first when adding either generated binding", async () => {
    const constructors = replaceEmbeddedAjvConstructors(
      {
        key: "hashbang.mjs",
        format: 1,
        source:
          "#!/usr/bin/env node\nclass A extends base{_addVocabularies(){}_addDefaultMetaSchema(){}defaultMeta(){}}const facade={};facade.Ajv=A;export const value=new A().value;",
      },
      "generated:adapter",
    );
    const compiled = precompileAjvModule(
      {
        key: "schema.mjs",
        format: 1,
        source:
          "#!/usr/bin/env node\nconst a=new lib.Ajv();export const validate=a.compile({type:'string'});",
      },
      {
        registrySpecifier: "generated:registry",
        runtimeSpecifier: "generated:runtime",
        validatorSpecifier: (id) => id,
      },
    );
    expect(constructors.source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(compiled.source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    const files = new Map([
      ["generated:hashbang", constructors.source],
      ["generated:adapter", "export const createAjv=()=>class{value='ok'}"],
    ]);
    const { code, context } = await bundleRegistry(
      "export {value} from 'generated:hashbang';",
      files,
    );
    new NodeVM.Script(code).runInContext(context);
    expect(new NodeVM.Script("Registry.value").runInContext(context)).toBe("ok");
  });
});

describe("AJV dynamic-schema interpreter", () => {
  it("rejects inherited and accessor constructor options before reading them under the code-generation ban", async () => {
    const nonEnumerable = Object.defineProperty({ strict: false }, "unicodeRegExp", {
      value: false,
    });
    expect(
      new ReferenceAjv(nonEnumerable).compile({ type: "string", pattern: "^\\p{L}$" })("é"),
    ).toBe(false);
    const { code, context } = await bundleRegistry(
      `import {createInterpretedAjv} from 'generated:interpreter';
      import {assertAjvCompatibility,resetAjvCompatibility} from './ajv-precompile-runtime.ts';
      const Ajv=createInterpretedAjv({draft7:()=>true,'2019':()=>true,'2020':()=>true});
      export function reject(options,schema=false){resetAjvCompatibility();let typed=false,latched=false;try{if(schema)new Ajv({strict:false}).compile(options);else new Ajv(options)}catch(error){typed=error.code==='AJV_SCHEMA_NOT_PRECOMPILED'}try{assertAjvCompatibility()}catch(error){latched=error.code==='AJV_SCHEMA_NOT_PRECOMPILED'}return typed&&latched}`,
      new Map(),
    );
    new NodeVM.Script(code).runInContext(context);
    for (const options of [
      "null",
      "[]",
      "{strict:false,__proto__:{unicodeRegExp:false}}",
      "{strict:false,'__proto__':{messages:false}}",
      "Object.create({strict:false})",
      "Object.defineProperty({strict:false},'unicodeRegExp',{value:false})",
    ])
      expect(new NodeVM.Script(`Registry.reject(${options})`).runInContext(context)).toBe(true);
    expect(
      new NodeVM.Script("Registry.reject({__proto__:{type:'string'}},true)").runInContext(context),
    ).toBe(true);
    expect(
      new NodeVM.Script(
        "let reads=0;const options=Object.defineProperty({},'strict',{enumerable:true,get(){reads++;return false}});Registry.reject(options)&&reads===0",
      ).runInContext(context),
    ).toBe(true);
    expect(
      new NodeVM.Script(
        "let hiddenReads=0;const hidden=Object.defineProperty({strict:false},'unicodeRegExp',{get(){hiddenReads++;return false}});Registry.reject(hidden)&&hiddenReads===0",
      ).runInContext(context),
    ).toBe(true);
  });

  it("matches defaultMeta and latches unsupported public state under the code-generation ban", async () => {
    const { code, context } = await bundleRegistry(
      `import {createInterpretedAjv} from 'generated:interpreter';
      import {assertAjvCompatibility,resetAjvCompatibility} from './ajv-precompile-runtime.ts';
      const meta={draft7:()=>true,'2019':()=>true,'2020':()=>true};
      export const compilers=['draft7','2019','2020'].map(dialect=>new (createInterpretedAjv(meta,dialect))({strict:false}));
      export function reject(check){resetAjvCompatibility();let typed=false,latched=false;try{check()}catch(error){typed=error.code==='AJV_SCHEMA_NOT_PRECOMPILED'}try{assertAjvCompatibility()}catch(error){latched=error.code==='AJV_SCHEMA_NOT_PRECOMPILED'}return typed&&latched}
      export const ajv=compilers[0];`,
      new Map(),
    );
    new NodeVM.Script(code).runInContext(context);
    const references = [new ReferenceAjv(), new ReferenceAjv2019(), new ReferenceAjv2020()];
    for (const [index, reference] of references.entries())
      expect(
        new NodeVM.Script(`Registry.compilers[${index}].defaultMeta()`).runInContext(context),
      ).toBe(reference.defaultMeta());
    for (const property of ["logger", "scope", "refs", "schemas", "formats", "RULES"])
      for (const script of [
        `Registry.reject(()=>Registry.ajv[${JSON.stringify(property)}])`,
        `Registry.reject(function(){Registry.ajv[${JSON.stringify(property)}]={}})`,
        `Registry.reject(function(){'use strict';Registry.ajv[${JSON.stringify(property)}]={}})`,
      ])
        expect(new NodeVM.Script(script).runInContext(context)).toBe(true);
    expect(() => new ReferenceAjv().validateSchema({ type: "garbage" }, true)).toThrow();
    expect(
      new NodeVM.Script(
        "Registry.reject(()=>Registry.ajv.validateSchema({type:'garbage'},true))",
      ).runInContext(context),
    ).toBe(true);
    for (const declaration of [
      7,
      null,
      "https://example.test/unknown-meta",
      "https://json-schema.org/draft/2020-12/schema",
    ]) {
      const schema = { $schema: declaration, type: "object" };
      let rejected = false;
      try {
        const reference = new ReferenceAjv();
        rejected = Reflect.apply(reference.validateSchema, reference, [schema]) === false;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      expect(
        new NodeVM.Script(
          `Registry.reject(()=>Registry.ajv.validateSchema(${JSON.stringify(schema)}))`,
        ).runInContext(context),
      ).toBe(true);
    }
    for (const [index, reference] of references.entries()) {
      const declared = reference.defaultMeta();
      if (typeof declared !== "string") throw new Error("Expected the built-in dialect meta ID");
      const schema = { $schema: declared, type: "object" };
      expect(reference.validateSchema(schema)).toBe(true);
      expect(
        new NodeVM.Script(
          `Registry.compilers[${index}].validateSchema(${JSON.stringify(schema)})`,
        ).runInContext(context),
      ).toBe(true);
    }
    const reference = new ReferenceAjv();
    const validate = reference.compile({ type: "string" });
    expect(reference.getSchema("")).toBe(validate);
    expect(
      new NodeVM.Script(
        "Registry.ajv.compile({type:'string'});Registry.reject(()=>Registry.ajv.getSchema(''))",
      ).runInContext(context),
    ).toBe(true);
  });

  it("latches undefined data with equality constraints instead of changing AJV results", async () => {
    const reference = new ReferenceAjv({ strict: false });
    expect(
      reference.compile({ type: "array", uniqueItems: true })([{ a: undefined }, { b: undefined }]),
    ).toBe(true);
    expect(reference.compile({ const: { b: 1 } })({ a: undefined })).toBe(false);
    expect(reference.compile({ enum: [{ b: 1 }] })({ a: undefined })).toBe(false);
    const { code, context } = await bundleRegistry(
      `import {createInterpretedAjv} from 'generated:interpreter';
      import {assertAjvCompatibility,resetAjvCompatibility} from './ajv-precompile-runtime.ts';
      export const ajv=new (createInterpretedAjv({draft7:()=>true,'2019':()=>true,'2020':()=>true}))({strict:false});
      export function check(schema,data){resetAjvCompatibility();let typed=false,latched=false;try{ajv.compile(schema)(data)}catch(error){typed=error.code==='AJV_SCHEMA_NOT_PRECOMPILED'}try{assertAjvCompatibility()}catch(error){latched=error.code==='AJV_SCHEMA_NOT_PRECOMPILED'}return typed&&latched}`,
      new Map(),
    );
    new NodeVM.Script(code).runInContext(context);
    for (const expression of [
      "Registry.check({type:'array',uniqueItems:true},[{a:undefined},{b:undefined}])",
      "Registry.check({const:{b:1}},{a:undefined})",
      "Registry.check({enum:[{b:1}]},{a:undefined})",
    ])
      expect(new NodeVM.Script(expression).runInContext(context)).toBe(true);
    expect(
      new NodeVM.Script("Registry.ajv.compile({const:{b:1}})({b:1})").runInContext(context),
    ).toBe(true);
  });

  it("latches unsupported public API calls even when a caller catches them", () => {
    const Interpreted = createInterpretedAjv({
      draft7: () => true,
      "2019": () => true,
      "2020": () => true,
    });
    const ajv = new Interpreted({ strict: false });
    for (const name of [
      "addMetaSchema",
      "removeSchema",
      "compileAsync",
      "addVocabulary",
      "getKeyword",
      "removeKeyword",
      "$dataMetaSchema",
    ]) {
      resetAjvCompatibility();
      const method: unknown = Reflect.get(ajv, name);
      if (typeof method !== "function") throw new Error(`Missing public API ${name}`);
      try {
        Reflect.apply(method, ajv, []);
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedAjvSchemaError);
      }
      expect(() => assertAjvCompatibility()).toThrow(new RegExp(name.replace("$", "\\$")));
    }
    resetAjvCompatibility();
  });

  it("rejects an unsupported registered schema at registration, before any unrelated compile", () => {
    const Interpreted = createInterpretedAjv({
      draft7: () => true,
      "2019": () => true,
      "2020": () => true,
    });
    resetAjvCompatibility();
    const ajv = new Interpreted({ strict: false });
    expect(() => ajv.addSchema({ $id: "urn:unused", type: "number", multipleOf: 2 })).toThrow(
      UnsupportedAjvSchemaError,
    );
    expect(() => assertAjvCompatibility()).toThrow(/multipleOf/);
    resetAjvCompatibility();
    let reads = 0;
    expect(() =>
      ajv.addSchema({
        $id: "urn:accessor",
        get type() {
          reads++;
          return "string";
        },
      }),
    ).toThrow(UnsupportedAjvSchemaError);
    expect(reads).toBe(0);
    expect(() => assertAjvCompatibility()).toThrow(/accessors/);
    resetAjvCompatibility();
    ajv.addSchema({ $id: "urn:accepted", type: "string" });
    expect(ajv.compile({ type: "boolean" })(true)).toBe(true);
    expect(() => assertAjvCompatibility()).not.toThrow();
  });

  it("treats own undefined object values as missing without changing key counts", () => {
    const Interpreted = createInterpretedAjv({
      draft7: () => true,
      "2019": () => true,
      "2020": () => true,
    });
    const interpreted = new Interpreted({ strict: false });
    const reference = new ReferenceAjv({ strict: false });
    const schemas = [
      { type: "object", properties: { a: { type: "string" } } },
      { type: "object", required: ["a"], properties: { a: { type: "string" } } },
      { type: "object", minProperties: 1, properties: { a: { type: "string" } } },
      { type: "object", maxProperties: 0, properties: { a: { type: "string" } } },
    ];
    resetAjvCompatibility();
    for (const schema of schemas) {
      const expected = reference.compile(schema);
      const actual = interpreted.compile(schema);
      for (const data of [{ a: undefined }, Object.freeze({ a: undefined })])
        expect(actual(data)).toBe(expected(data));
    }
    expect(() => assertAjvCompatibility()).not.toThrow();
    for (const mixed of [
      { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
      { type: "object", additionalProperties: { type: "string" } },
      { type: "object", patternProperties: { "^a": { type: "string" } } },
    ]) {
      resetAjvCompatibility();
      expect(() => interpreted.compile(mixed)({ a: undefined })).toThrow(
        /Undefined values with additionalProperties/,
      );
      expect(() => assertAjvCompatibility()).toThrow(UnsupportedAjvSchemaError);
    }
    resetAjvCompatibility();
    let reads = 0;
    const accessor = {
      get a() {
        reads++;
        return "value";
      },
    };
    expect(() => interpreted.compile(schemas[0])(accessor)).toThrow(/accessors/);
    expect(reads).toBe(0);
    resetAjvCompatibility();
  });
  it("keeps unsupported schemas visible after Claude catches their exceptions", () => {
    resetAjvCompatibility();
    const Interpreted = createInterpretedAjv({
      draft7: () => true,
      "2019": () => true,
      "2020": () => true,
    });
    const ajv = new Interpreted({ strict: false });
    const caught = () => {
      try {
        ajv.compile({ multipleOf: 0.1 });
        return "checked";
      } catch {
        return "unchecked";
      }
    };
    expect(caught()).toBe("unchecked");
    expect(() => assertAjvCompatibility()).toThrow(UnsupportedAjvSchemaError);
    expect(ajv.compile({ type: "string" })("ok")).toBe(true);
    expect(() => assertAjvCompatibility()).toThrow(/multipleOf/);
    resetAjvCompatibility();
    expect(() => assertAjvCompatibility()).not.toThrow();
  });
  it("returns one required-field error unless allErrors is enabled", () => {
    const Interpreted = createInterpretedAjv({
      draft7: () => true,
      "2019": () => true,
      "2020": () => true,
    });
    const schema = { type: "object", required: ["first", "second"] };
    for (const options of [{ allErrors: false }, {}, { allErrors: true }]) {
      const reference = new ReferenceAjv(options).compile(schema);
      const actual = new Interpreted(options).compile(schema);
      expect(actual({})).toBe(reference({}));
      expect(actual.errors?.length).toBe(reference.errors?.length);
      expect(actual.errors?.map((error) => error.params)).toEqual(
        reference.errors?.map((error) => error.params),
      );
      expect(actual({ first: "Ada", second: "Lovelace" })).toBe(true);
      expect(actual.errors).toBeNull();
    }
  });
  it("validates dynamic MCP input without Function and rejects invalid schemas", async () => {
    const meta = precompileAjvMetaValidators();
    const files = new Map(
      Object.values(meta).map((entry) => [`generated:${entry.id}`, entry.source]),
    );
    const source = `import {createInterpretedAjv} from 'generated:interpreter';
      import draft7 from 'generated:meta-draft7';import draft2019 from 'generated:meta-2019';import draft2020 from 'generated:meta-2020';
      const Ajv=createInterpretedAjv({draft7,'2019':draft2019,'2020':draft2020},'2020');
      export const ajv=new Ajv({allErrors:true,strict:false,validateFormats:false});`;
    const { code, context } = await bundleRegistry(source, files);
    new NodeVM.Script(code).runInContext(context);
    const schema = {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", format: "email" } },
      additionalProperties: false,
    };
    expect(
      new NodeVM.Script(
        `Registry.ajv.compile(${JSON.stringify(schema)})({name:'not-an-email'})`,
      ).runInContext(context),
    ).toBe(true);
    expect(
      new NodeVM.Script(`Registry.ajv.compile(${JSON.stringify(schema)})({name:4})`).runInContext(
        context,
      ),
    ).toBe(false);
    expect(
      new NodeVM.Script("Registry.ajv.validateSchema({type:'garbage'})").runInContext(context),
    ).toBe(false);
    expect(
      new NodeVM.Script(
        "Registry.ajv.getSchema('https://json-schema.org/draft/2020-12/schema')({type:'garbage'})",
      ).runInContext(context),
    ).toBe(false);
    expect(
      new NodeVM.Script(
        "Registry.ajv.getSchema('https://json-schema.org/draft/2020-12/schema').errors[0].instancePath",
      ).runInContext(context),
    ).toBe("/type");
    expect(() =>
      new NodeVM.Script("Registry.ajv.compile({type:'garbage'})").runInContext(context),
    ).toThrow(/invalid/);
    expect(() => new NodeVM.Script("new Function('return 1')").runInContext(context)).toThrow();
  });

  it("fails unsupported options and schema features explicitly", () => {
    const Ajv = createInterpretedAjv({
      draft7: () => true,
      "2019": () => true,
      "2020": () => true,
    });
    expect(() => new Ajv({ coerceTypes: true })).toThrow(/option coerceTypes/);
    const ajv = new Ajv({ strict: false });
    expect(() => ajv.compile({ type: "number", multipleOf: 0.1 })).toThrow(/multipleOf/);
    expect(() => ajv.compile({ $dynamicRef: "#node" })).toThrow(/dynamicRef/);
    const strict = new Ajv({ strict: false, strictSchema: true });
    expect(() => strict.compile({ type: "string", unknownKeyword: true })).toThrow(
      /Unknown AJV schema keyword/,
    );
    expect(() => strict.compile({ type: "string", format: "unknownFormat" })).toThrow(
      /Unknown AJV format/,
    );
    expect(() => ajv.compile({ type: "string", __absolute_ref__: "https://example.test" })).toThrow(
      /absolute_ref/,
    );
    const Modern = createInterpretedAjv(
      { draft7: () => true, "2019": () => true, "2020": () => true },
      "2020",
    );
    const conditional = {
      if: { properties: { x: { const: 1 } } },
      then: { required: ["y"] },
      unevaluatedProperties: false,
    };
    expect(new ReferenceAjv2020({ strict: false }).compile(conditional)({ x: 2 })).toBe(true);
    expect(() => new Modern({ strict: false }).compile(conditional)).toThrow(
      /unevaluatedProperties/,
    );
  });

  it("accepts the standard SDK format plugin and keeps instances isolated", () => {
    const Ajv = createInterpretedAjv({
      draft7: () => true,
      "2019": () => true,
      "2020": () => true,
    });
    const ajv = new Ajv({ strict: false });
    const addFormats = addFormatsModule.default ?? addFormatsModule;
    // The plugin's runtime contract is addFormat/addKeyword/opts.code; its declared type requires the entire AJV class.
    Reflect.apply(addFormats, undefined, [ajv]);
    const validate = ajv.compile({ type: "string", format: "email" });
    expect(validate("ada@example.com")).toBe(true);
    expect(validate("bad-email")).toBe(false);
    const other = new Ajv({ strict: false });
    expect(other.compile({ type: "string", format: "email" })("bad-email")).toBe(true);
    expect(() =>
      ajv.compile({ type: "string", format: "date", formatMinimum: "2000-01-01" }),
    ).toThrow(/formatMinimum/);
    ajv.addFormat("custom", /^first$/);
    const first = ajv.compile({ type: "string", format: "custom" });
    ajv.addFormat("custom", /^second$/);
    const second = ajv.compile({ type: "string", format: "custom" });
    expect(first("first")).toBe(true);
    expect(first("second")).toBe(false);
    expect(second("second")).toBe(true);
    expect(second("first")).toBe(false);
  });

  it("preserves SDK 2020 factory and getSchema cache behavior", () => {
    const meta = { draft7: () => true, "2019": () => true, "2020": () => true };
    const Interpreted = createInterpretedAjv(meta, "2020");
    const options = {
      strict: false,
      validateFormats: true,
      validateSchema: false,
      allErrors: true,
    };
    const reference = new ReferenceAjv2020(options);
    const actual = new Interpreted(options);
    const addFormats = addFormatsModule.default ?? addFormatsModule;
    addFormats(reference);
    Reflect.apply(addFormats, undefined, [actual]);
    const schema = {
      $schema: "http://json-schema.org/draft/2020-12/schema",
      $id: "urn:mcp:output",
      type: "object",
      required: ["email"],
      properties: { email: { type: "string", format: "email" } },
    };
    for (const compiler of [actual, reference]) {
      const validate = compiler.getSchema(schema.$id) ?? compiler.compile(schema);
      expect(validate({ email: "ada@example.com" })).toBe(true);
      expect(validate({ email: "invalid" })).toBe(false);
      expect(compiler.getSchema(schema.$id)).toBe(validate);
    }
  });

  it("keeps registered boolean schemas and relative references usable", () => {
    const Interpreted = createInterpretedAjv({
      draft7: () => true,
      "2019": () => true,
      "2020": () => true,
    });
    for (const compiler of [
      new Interpreted({ strict: false }),
      new ReferenceAjv({ strict: false }),
    ]) {
      compiler.addSchema(false, "https://example.test/never");
      compiler.addSchema({ $ref: "never" }, "https://example.test/root");
      const validate = compiler.getSchema("https://example.test/root");
      expect(validate?.("value")).toBe(false);
      expect(compiler.errorsText([])).toBe("No errors");
      expect(() => compiler.compile({ $id: "https://example.test/root", type: "string" })).toThrow(
        /already exists/,
      );
    }
  });

  it("matches AJV for references, required fields, and dialect-specific tuple behavior", () => {
    const meta = { draft7: () => true, "2019": () => true, "2020": () => true };
    const fixtures = [
      {
        schema: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { name: { type: "string" } },
        },
        values: [{}, { name: "Ada" }, { name: 5 }, { name: "Ada", extra: true }],
      },
      {
        schema: { $defs: { name: { type: "string", minLength: 2 } }, $ref: "#/$defs/name" },
        values: ["A", "Ada", 5],
      },
      {
        schema: { $defs: { value: { type: "string" } }, $ref: "#/$defs/value", minLength: 2 },
        values: ["A", "Ada", 5],
      },
      {
        schema: { type: "array", contains: { type: "string" }, minContains: 0 },
        values: [[], [5], ["Ada"]],
      },
      { schema: { type: "array", prefixItems: [{ type: "string" }] }, values: [[5], ["Ada"], []] },
    ];
    for (const dialect of ["draft7", "2020"] as const) {
      const Interpreted = createInterpretedAjv(meta, dialect);
      const reference =
        dialect === "draft7"
          ? new ReferenceAjv({ strict: false })
          : new ReferenceAjv2020({ strict: false });
      const interpreted = new Interpreted({ strict: false });
      for (const fixture of fixtures) {
        const expected = reference.compile(fixture.schema);
        const actual = interpreted.compile(fixture.schema);
        for (const value of fixture.values) expect(actual(value)).toBe(expected(value));
      }
      const required = interpreted.compile(fixtures[0]?.schema);
      expect(required({})).toBe(false);
      expect(required.errors?.find((error) => error.keyword === "required")?.params).toEqual({
        missingProperty: "name",
      });
      expect(required({ name: "Ada" })).toBe(true);
      expect(required.errors).toBeNull();
      const pointerSchema = { type: "object", properties: { "a b/ñ": { type: "string" } } };
      const pointerActual = interpreted.compile(pointerSchema);
      const pointerReference = reference.compile(pointerSchema);
      pointerActual({ "a b/ñ": 5 });
      pointerReference({ "a b/ñ": 5 });
      expect(pointerActual.errors?.[0]?.instancePath).toBe(
        pointerReference.errors?.[0]?.instancePath,
      );
    }
  });
});
