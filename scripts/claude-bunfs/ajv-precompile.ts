// @effect-diagnostics nodeBuiltinImport:off - build-time hashing never enters the generated Worker bundle.
import * as NodeCrypto from "node:crypto";
import { Ajv } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import standaloneModule from "ajv/dist/standalone/index.js";
import type { AnySchema, Options } from "ajv";
import ts from "typescript-legacy";
import { discoverAjvSchemas } from "./ajv-precompile-discovery.ts";
import type {
  AjvDiagnostic,
  AjvModuleAnalysis,
  DiscoveredAjvCall,
} from "./ajv-precompile-discovery.ts";
import { canonicalSchema } from "./ajv-precompile-runtime.ts";
import { insertAjvBinding } from "./ajv-precompile-constructors.ts";

const standaloneCode = standaloneModule.default ?? standaloneModule;

export { discoverAjvSchemas } from "./ajv-precompile-discovery.ts";
export {
  AjvConstructorTransformError,
  replaceEmbeddedAjvConstructors,
} from "./ajv-precompile-constructors.ts";
export type { AjvDiagnostic, AjvModuleAnalysis } from "./ajv-precompile-discovery.ts";

export interface AjvGeneratedValidator {
  id: string;
  source: string;
}

export class AjvPrecompileError extends Error {
  readonly code = "AJV_PRECOMPILE_INCOMPLETE";
  readonly diagnostics: readonly AjvDiagnostic[];

  constructor(diagnostics: readonly AjvDiagnostic[]) {
    super(`AJV precompilation failed at ${diagnostics.length} site(s)`);
    this.name = "AjvPrecompileError";
    this.diagnostics = diagnostics;
  }

  toJSON() {
    return { code: this.code, diagnostics: this.diagnostics };
  }
}

function preserveGeneratedJsonKeys(source: string) {
  const parsed = ts.createSourceFile(
    "standalone.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const keys: ts.PropertyName[] = [];
  const visit = (node: ts.Node) => {
    // AJV serializes JSON constants as object literals; this key must remain own data.
    if (
      ts.isPropertyAssignment(node) &&
      !ts.isComputedPropertyName(node.name) &&
      node.name.text === "__proto__"
    )
      keys.push(node.name);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  for (const key of keys.sort((a, b) => b.getStart(parsed) - a.getStart(parsed)))
    source = `${source.slice(0, key.getStart(parsed))}["__proto__"]${source.slice(key.end)}`;
  return source;
}

function compile(call: DiscoveredAjvCall): AjvGeneratedValidator {
  if (!call.profile || call.schema === undefined)
    throw new Error("Unresolved schema or AJV profile");
  // A pre-existing process callback or source-generation option cannot be replaced safely.
  if (Object.hasOwn(call.profile.options, "code"))
    throw new Error("Custom AJV code options require a dedicated compiler profile");
  const options: Options = { ...call.profile.options, code: { source: true } };
  const Constructor =
    call.profile.dialect === "2020" ? Ajv2020 : call.profile.dialect === "2019" ? Ajv2019 : Ajv;
  const compiler = new Constructor(options);
  const validate = compiler.compile(call.schema as AnySchema);
  const source = preserveGeneratedJsonKeys(standaloneCode(compiler, validate));
  const id = NodeCrypto.createHash("sha256")
    .update(canonicalSchema({ schema: call.schema, profile: call.profile }))
    .digest("hex")
    .slice(0, 24);
  return { id, source };
}

/** The interpreter uses AJV-generated meta-schema checks without shipping an AJV compiler. */
export function precompileAjvMetaValidators(): Record<
  "draft7" | "2019" | "2020",
  AjvGeneratedValidator
> {
  const generate = (compiler: Ajv | Ajv2019 | Ajv2020, dialect: string, id: string) => {
    const validate = compiler.getSchema(id);
    if (!validate) throw new Error(`Missing AJV meta-schema ${id}`);
    return {
      id: `meta-${dialect}`,
      source: preserveGeneratedJsonKeys(standaloneCode(compiler, validate)),
    };
  };
  const options = { code: { source: true }, allErrors: true, strict: false };
  return {
    draft7: generate(new Ajv(options), "draft7", "http://json-schema.org/draft-07/schema"),
    "2019": generate(new Ajv2019(options), "2019", "https://json-schema.org/draft/2019-09/schema"),
    "2020": generate(new Ajv2020(options), "2020", "https://json-schema.org/draft/2020-12/schema"),
  };
}

export interface AjvPrecompileOptions {
  registrySpecifier: string;
  runtimeSpecifier: string;
  validatorSpecifier: (id: string) => string;
  // Diagnostic output can still be emitted for an unsupported release. Unknown schemas throw at runtime.
  allowUnresolved?: boolean;
  // Use only when the caller replaces AJV constructors with the bounded interpreter.
  preserveUnresolvedCalls?: boolean;
}

/** Build-only entry point. The emitted registry imports only the portable helper and standalone validators. */
export function precompileAjvModule(
  input:
    | AjvModuleAnalysis
    | { key: string; source: string; format?: "commonjs" | "module" | 1 | 2 },
  options: AjvPrecompileOptions,
) {
  const analysis = "calls" in input ? input : discoverAjvSchemas(input);
  const diagnostics = [...analysis.diagnostics];
  const validators = new Map<string, AjvGeneratedValidator>();
  const entries: { call: DiscoveredAjvCall; validator: AjvGeneratedValidator }[] = [];
  for (const call of analysis.calls) {
    if (!call.profile || call.schema === undefined || call.site.reason) continue;
    try {
      const validator = compile(call);
      validators.set(validator.id, validator);
      entries.push({ call, validator });
    } catch (error) {
      diagnostics.push({
        code: "AJV_UNKNOWN_PROFILE",
        module: analysis.key,
        offset: call.start,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (diagnostics.length && !options.allowUnresolved) throw new AjvPrecompileError(diagnostics);
  if (!analysis.calls.length)
    return {
      source: analysis.source,
      registrySource: undefined,
      validators: [],
      compiledSiteCount: 0,
      diagnostics,
      analysis,
    };
  const identifier = `__signalboxAjv_${NodeCrypto.createHash("sha256").update(analysis.key).digest("hex").slice(0, 12)}`;
  if (analysis.source.includes(identifier))
    throw new Error(`Generated AJV binding collides in ${analysis.key}`);
  let source = analysis.source;
  const compiledSites = new Set(entries.map((entry) => entry.call.site.id));
  for (const call of [...analysis.calls].sort((a, b) => b.start - a.start)) {
    if (options.preserveUnresolvedCalls && !compiledSites.has(call.site.id)) continue;
    source = `${source.slice(0, call.start)}(${call.receiver},${identifier}(${call.argument},${JSON.stringify(call.site.id)}))${source.slice(call.end)}`;
  }
  const binding =
    analysis.format === "commonjs" || analysis.format === 2
      ? `const {compile:${identifier}}=require(${JSON.stringify(options.registrySpecifier)});`
      : `import { compile as ${identifier} } from ${JSON.stringify(options.registrySpecifier)};`;
  source = insertAjvBinding(source, binding, analysis.format);
  const uniqueValidators = [...validators.values()];
  const names = new Map(
    uniqueValidators.map((validator, index) => [validator.id, `validate${index}`]),
  );
  const imports = uniqueValidators
    .map(
      (validator) =>
        `import ${names.get(validator.id)} from ${JSON.stringify(options.validatorSpecifier(validator.id))};`,
    )
    .join("\n");
  const registryEntries = entries
    .map(
      ({ call, validator }) =>
        `{site:${JSON.stringify(call.site)},schema:JSON.parse(${JSON.stringify(JSON.stringify(call.schema))}),validate:${names.get(validator.id)}}`,
    )
    .join(",\n");
  const sites = analysis.calls.map((call) => {
    const issue = diagnostics.find((diagnostic) => diagnostic.offset === call.start);
    return issue ? { ...call.site, reason: issue.message } : call.site;
  });
  const registrySource = `import { createPrecompiledAjvRegistry } from ${JSON.stringify(options.runtimeSpecifier)};\n${imports}\nexport const compile = createPrecompiledAjvRegistry([${registryEntries}],${JSON.stringify(sites)});\n`;
  return {
    source,
    registrySource,
    validators: uniqueValidators,
    compiledSiteCount: entries.length,
    diagnostics,
    analysis,
  };
}
