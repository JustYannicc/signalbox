import type { Schema, OutputUnit } from "@cfworker/json-schema";
import type { AjvCompatibleError, AjvMetaValidators } from "./ajv-precompile-runtime.ts";
import { canonicalSchema, UnsupportedAjvSchemaError } from "./ajv-precompile-runtime.ts";

const schemaValues = new Set([
  "additionalItems",
  "unevaluatedItems",
  "items",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]);
const schemaArrays = new Set(["prefixItems", "items", "allOf", "anyOf", "oneOf"]);
const schemaMaps = new Set([
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
]);
const keywords = new Set(
  "$id $anchor $recursiveAnchor $ref $recursiveRef $schema $comment $defs $vocabulary definitions type const enum required not anyOf allOf oneOf if then else format properties patternProperties additionalProperties unevaluatedProperties minProperties maxProperties propertyNames dependentRequired dependentSchemas dependencies prefixItems items additionalItems unevaluatedItems contains minContains maxContains minItems maxItems uniqueItems minimum maximum exclusiveMinimum exclusiveMaximum multipleOf minLength maxLength pattern title description default examples readOnly writeOnly deprecated contentEncoding contentMediaType contentSchema".split(
    " ",
  ),
);
export const formatLimits = new Set([
  "formatMinimum",
  "formatMaximum",
  "formatExclusiveMinimum",
  "formatExclusiveMaximum",
]);
const rejectedKeywords = new Set([
  "$async",
  "$data",
  "$dynamicRef",
  "$dynamicAnchor",
  "__absolute_ref__",
  "__absolute_recursive_ref__",
  "__absolute_uri__",
  "id",
  "$recursiveRef",
  "$recursiveAnchor",
  "unevaluatedProperties",
  "unevaluatedItems",
  "nullable",
  "discriminator",
  "multipleOf",
  ...formatLimits,
]);

function unsupported(reason: string, schema?: unknown): never {
  throw new UnsupportedAjvSchemaError(
    { id: "ajv-interpreter", module: "dynamic-schema", offset: 0 },
    schema,
    reason,
  );
}

export function normalizeValidationData(input: unknown, schema: unknown): unknown {
  const undefinedConstraint = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (
      ("additionalProperties" in record && record.additionalProperties !== true) ||
      "patternProperties" in record
    )
      return "additionalProperties or patternProperties";
    if (record.uniqueItems === true) return "uniqueItems";
    if ("const" in record || "enum" in record) return "const or enum";
    for (const child of Object.values(record)) {
      const constraint = undefinedConstraint(child);
      if (constraint) return constraint;
    }
    return;
  };
  const rejectsUndefined = undefinedConstraint(schema);
  const ancestors = new Set<object>();
  const visit = (value: unknown): unknown => {
    if (value === undefined && rejectsUndefined)
      unsupported(`Undefined values with ${rejectsUndefined} require a compiler profile`);
    if (typeof value === "number" && !Number.isFinite(value))
      unsupported("Non-finite validation data requires a compiler profile");
    if (!value || typeof value !== "object") return value;
    if (ancestors.has(value)) unsupported("Cyclic validation data requires a compiler profile");
    const array = Array.isArray(value);
    const prototype: object | null = Object.getPrototypeOf(value);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      unsupported("Validation data with a custom prototype requires a compiler profile");
    ancestors.add(value);
    const normalized: object = array ? [] : Object.create(prototype);
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor))
        unsupported("Validation data accessors require a compiler profile");
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: descriptor.enumerable === true,
        writable: true,
        value: visit(descriptor.value),
      });
    }
    ancestors.delete(value);
    if (array) {
      const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (typeof length !== "number") unsupported("Invalid validation array length");
      for (let index = 0; index < length; index++) {
        if (
          !Object.hasOwn(normalized, index) ||
          Object.getOwnPropertyDescriptor(normalized, index)?.value === undefined
        )
          unsupported("Sparse or undefined array entries require a compiler profile");
      }
      return normalized;
    }
    // AJV treats undefined properties as missing while still counting their enumerable keys.
    return new Proxy(normalized, {
      has(target, key) {
        const own = Object.getOwnPropertyDescriptor(target, key);
        return own && "value" in own ? own.value !== undefined : Reflect.has(target, key);
      },
    });
  };
  return visit(input);
}

export function prepareInterpretedSchema(
  input: unknown,
  dialect: keyof AjvMetaValidators,
  options: Record<string, unknown>,
  formats: ReadonlyMap<string, string>,
  unsupportedFormats: ReadonlySet<string>,
): Schema | boolean {
  let schema: unknown;
  try {
    schema = JSON.parse(canonicalSchema(input));
  } catch {
    unsupported("Schema must contain finite JSON values without cycles or accessors", input);
  }
  const strictSchema = options.strictSchema ?? options.strict ?? true;
  const visit = (node: unknown): void => {
    if (typeof node === "boolean") return;
    if (!node || typeof node !== "object" || Array.isArray(node))
      unsupported("Expected an object or boolean schema", input);
    const record = node as Record<string, unknown>;
    if (typeof record.$schema === "string" && options.validateSchema !== false) {
      const declared = record.$schema.replace(/#$/, "");
      const expected =
        dialect === "draft7"
          ? "http://json-schema.org/draft-07/schema"
          : `https://json-schema.org/draft/${dialect === "2020" ? "2020-12" : "2019-09"}/schema`;
      if (declared !== expected)
        unsupported(`Schema dialect ${declared} does not match AJV ${dialect}`, input);
    }
    for (const [key, value] of Object.entries(record)) {
      const inactive =
        dialect === "draft7"
          ? [
              "$recursiveRef",
              "$recursiveAnchor",
              "unevaluatedProperties",
              "unevaluatedItems",
              "dependentRequired",
              "dependentSchemas",
              "prefixItems",
              "minContains",
              "maxContains",
            ].includes(key)
          : dialect === "2019"
            ? key === "prefixItems"
            : key === "additionalItems";
      if (inactive) {
        if (strictSchema) unsupported(`Unknown AJV ${dialect} keyword ${key}`, input);
        delete record[key];
        continue;
      }
      if (rejectedKeywords.has(key)) unsupported(`Unsupported AJV schema keyword ${key}`, input);
      if (!keywords.has(key)) {
        if (strictSchema) unsupported(`Unknown AJV schema keyword ${key}`, input);
        delete record[key];
        continue;
      }
      if (key === "format") {
        if (options.validateFormats === false) delete record.format;
        else if (typeof value === "string" && unsupportedFormats.has(value))
          unsupported(`Unsupported AJV format ${value}`, input);
        else if (typeof value === "string" && formats.has(value)) {
          const alias = formats.get(value);
          if (alias) record.format = alias;
          else delete record.format;
        } else if (strictSchema) unsupported(`Unknown AJV format ${String(value)}`, input);
        else delete record.format;
      } else if (schemaMaps.has(key) && value && typeof value === "object")
        Object.values(value).forEach(visit);
      else if (schemaArrays.has(key) && Array.isArray(value)) value.forEach(visit);
      else if (schemaValues.has(key)) visit(value);
      else if (key === "dependencies" && value && typeof value === "object")
        Object.values(value).forEach((item) => {
          if (!Array.isArray(item)) visit(item);
        });
    }
  };
  visit(schema);
  return schema as Schema | boolean;
}

export function toAjvError(error: OutputUnit, schema: unknown): AjvCompatibleError {
  let keywordValue = schema;
  for (const part of decodeURI(error.keywordLocation).replace(/^#\/?/, "").split("/")) {
    if (!keywordValue || typeof keywordValue !== "object") {
      keywordValue = undefined;
      break;
    }
    keywordValue = (keywordValue as Record<string, unknown>)[
      part.replaceAll("~1", "/").replaceAll("~0", "~")
    ];
  }
  const params: Record<string, unknown> = {};
  if (error.keyword === "enum") params.allowedValues = keywordValue;
  else if (error.keyword === "const") params.allowedValue = keywordValue;
  else if (error.keyword === "type") params.type = keywordValue;
  else if (error.keyword === "format") params.format = keywordValue;
  else if (error.keyword === "pattern") params.pattern = keywordValue;
  else if (error.keyword === "required")
    params.missingProperty = error.error.slice(
      'Instance does not have required property "'.length,
      -2,
    );
  else if (error.keyword === "additionalProperties")
    params.additionalProperty = error.error.slice(
      'Property "'.length,
      error.error.indexOf('" does not match additional properties schema.'),
    );
  else if (/^(?:min|max|exclusive)/.test(error.keyword)) params.limit = keywordValue;
  return {
    keyword: error.keyword === "false" ? "false schema" : error.keyword,
    instancePath: decodeURI(error.instanceLocation).replace(/^#/, ""),
    schemaPath: error.keywordLocation,
    params,
    message: error.error,
  };
}

// These are structural wrappers in cfworker output; AJV reports their child constraint instead.
const errorWrappers = new Set([
  "properties",
  "patternProperties",
  "items",
  "prefixItems",
  "allOf",
  "$ref",
  "dependentSchemas",
]);

export function toAjvErrors(errors: readonly OutputUnit[], schema: unknown, allErrors: boolean) {
  const constraints = errors.filter((error) => !errorWrappers.has(error.keyword));
  return (allErrors ? constraints : constraints.slice(0, 1)).map((error) =>
    toAjvError(error, schema),
  );
}
