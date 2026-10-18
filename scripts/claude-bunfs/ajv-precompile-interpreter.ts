import {
  formatLimits,
  normalizeValidationData,
  prepareInterpretedSchema,
  toAjvErrors,
} from "./ajv-precompile-interpreter-schema.ts";
import { Validator, format } from "@cfworker/json-schema";
import type { SchemaDraft } from "@cfworker/json-schema";
import { canonicalSchema, UnsupportedAjvSchemaError } from "./ajv-precompile-runtime.ts";

export interface AjvCompatibleError {
  keyword: string;
  instancePath: string;
  schemaPath: string;
  params: Record<string, unknown>;
  // The interpreter keeps cfworker's wording; callers must not depend on AJV's exact message text.
  message: string;
}
export interface AjvCompatibleValidator {
  (data: unknown): boolean;
  errors: AjvCompatibleError[] | null;
  schema: unknown;
}
export interface AjvMetaValidator {
  (schema: unknown): boolean;
  errors?: readonly AjvCompatibleError[] | null;
  schema?: unknown;
}
export type AjvMetaValidators = Record<"draft7" | "2019" | "2020", AjvMetaValidator>;
type Format =
  | RegExp
  | ((value: string) => boolean)
  | { type?: string; async?: boolean; validate: RegExp | ((value: string) => boolean) };

let nextInstance = 0;

function restoreFormats(previous: ReadonlyMap<string, ((value: string) => boolean) | undefined>) {
  for (const [name, predicate] of previous) {
    if (predicate !== undefined) format[name] = predicate;
    else delete format[name];
  }
}

function unsupported(reason: string, schema?: unknown): never {
  throw new UnsupportedAjvSchemaError(
    { id: "ajv-interpreter", module: "dynamic-schema", offset: 0 },
    schema,
    reason,
  );
}

/** Only the non-mutating, synchronous AJV subset is accepted. Unknown behavior fails closed. */
export function createInterpretedAjv(
  metaValidators: AjvMetaValidators,
  dialect: keyof AjvMetaValidators = "draft7",
) {
  const metaId =
    dialect === "draft7"
      ? "http://json-schema.org/draft-07/schema"
      : `https://json-schema.org/draft/${dialect === "2020" ? "2020-12" : "2019-09"}/schema`;
  const isBuiltIn = (id: string) => id === metaId || id === "http://json-schema.org/schema";
  return class InterpretedAjv {
    readonly opts: Record<string, unknown> & { code: Record<string, unknown> };
    errors: AjvCompatibleError[] | null = null;
    private readonly schemaRegistry = new Map<string, unknown>();
    private readonly validators = new Map<unknown, AjvCompatibleValidator>();
    private readonly formatAliases = new Map<string, string>();
    private readonly formatPredicates = new Map<string, (value: string) => boolean>();
    private readonly unsupportedFormats = new Set<string>();
    private readonly instanceId = nextInstance++;
    private nextFormat = 0;
    private metaValidator: AjvCompatibleValidator | undefined;

    constructor(options: Record<string, unknown> = {}) {
      if (!options || typeof options !== "object" || Array.isArray(options))
        unsupported("AJV options must be a plain object");
      for (const name of Reflect.ownKeys(options)) {
        const descriptor = Object.getOwnPropertyDescriptor(options, name);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          unsupported("AJV options cannot contain accessors or non-enumerable properties");
      }
      let normalized: Record<string, unknown>;
      try {
        normalized = JSON.parse(canonicalSchema(options));
      } catch {
        unsupported("AJV options require plain finite JSON values without accessors");
      }
      const accepted = new Set([
        "allErrors",
        "strict",
        "strictSchema",
        "validateFormats",
        "validateSchema",
        "multipleOfPrecision",
      ]);
      for (const [name, value] of Object.entries(normalized)) {
        if (!accepted.has(name)) unsupported(`Unsupported AJV option ${name}`);
        if (name === "strict" && value === true)
          unsupported("AJV strict:true requires additional compile-time checks");
        if (name === "multipleOfPrecision") {
          if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
            unsupported("Invalid multipleOfPrecision");
        } else if (typeof value !== "boolean") unsupported(`Unsupported AJV option value ${name}`);
      }
      this.opts = { ...normalized, code: {} };
    }

    addFormat(name: string, definition: Format | true) {
      if (definition === true) {
        this.unsupportedFormats.delete(name);
        this.formatAliases.set(name, "");
        return this;
      }
      const implementation =
        typeof definition === "object" && !(definition instanceof RegExp)
          ? definition.validate
          : definition;
      if (
        typeof definition === "object" &&
        !(definition instanceof RegExp) &&
        (definition.async || (definition.type && definition.type !== "string"))
      ) {
        this.unsupportedFormats.add(name);
        return this;
      }
      if (implementation instanceof RegExp && (implementation.global || implementation.sticky)) {
        this.unsupportedFormats.add(name);
        return this;
      }
      if (!(implementation instanceof RegExp) && typeof implementation !== "function")
        unsupported(`Unsupported AJV format definition ${name}`);
      const alias = `signalbox-ajv-${this.instanceId}-${this.nextFormat++}`;
      const predicate: (value: string) => boolean =
        implementation instanceof RegExp
          ? (value) => {
              implementation.lastIndex = 0;
              return implementation.test(value);
            }
          : implementation;
      this.formatPredicates.set(alias, (value) => {
        const result = predicate(value);
        if (typeof result !== "boolean")
          unsupported(`AJV format ${name} did not return a synchronous boolean`);
        return result;
      });
      this.unsupportedFormats.delete(name);
      this.formatAliases.set(name, alias);
      return this;
    }

    addKeyword(definition: unknown) {
      const names =
        definition && typeof definition === "object" && "keyword" in definition
          ? definition.keyword
          : undefined;
      if (
        Array.isArray(names) &&
        names.length > 0 &&
        names.every((name) => typeof name === "string" && formatLimits.has(name))
      )
        return this;
      return unsupported("Custom AJV keywords require a compiler profile");
    }

    get logger(): never {
      return unsupported("AJV logger access requires a compiler profile");
    }
    set logger(_value: unknown) {
      unsupported("AJV logger assignment requires a compiler profile");
    }
    get scope(): never {
      return unsupported("AJV scope access requires a compiler profile");
    }
    set scope(_value: unknown) {
      unsupported("AJV scope assignment requires a compiler profile");
    }
    get refs(): never {
      return unsupported("AJV refs access requires a compiler profile");
    }
    set refs(_value: unknown) {
      unsupported("AJV refs assignment requires a compiler profile");
    }
    get schemas(): never {
      return unsupported("AJV schemas access requires a compiler profile");
    }
    set schemas(_value: unknown) {
      unsupported("AJV schemas assignment requires a compiler profile");
    }
    get formats(): never {
      return unsupported("AJV formats access requires a compiler profile");
    }
    set formats(_value: unknown) {
      unsupported("AJV formats assignment requires a compiler profile");
    }
    get RULES(): never {
      return unsupported("AJV RULES access requires a compiler profile");
    }
    set RULES(_value: unknown) {
      unsupported("AJV RULES assignment requires a compiler profile");
    }

    addMetaSchema(): never {
      return unsupported("AJV addMetaSchema requires a compiler profile");
    }
    defaultMeta() {
      return metaId;
    }
    removeSchema(): never {
      return unsupported("AJV removeSchema requires a compiler profile");
    }
    compileAsync(): never {
      return unsupported("AJV compileAsync requires a compiler profile");
    }
    addVocabulary(): never {
      return unsupported("AJV addVocabulary requires a compiler profile");
    }
    getKeyword(): never {
      return unsupported("AJV getKeyword requires a compiler profile");
    }
    removeKeyword(): never {
      return unsupported("AJV removeKeyword requires a compiler profile");
    }
    $dataMetaSchema(): never {
      return unsupported("AJV $dataMetaSchema requires a compiler profile");
    }

    private prepare(input: unknown) {
      return prepareInterpretedSchema(
        input,
        dialect,
        this.opts,
        this.formatAliases,
        this.unsupportedFormats,
      );
    }

    validateSchema(schema: unknown, throwOrLogError?: unknown): boolean {
      if (throwOrLogError)
        unsupported("AJV validateSchema throwOrLogError requires a compiler profile", schema);
      if (schema && typeof schema === "object" && "$schema" in schema) {
        const declared = Object.getOwnPropertyDescriptor(schema, "$schema");
        if (
          !declared ||
          !("value" in declared) ||
          typeof declared.value !== "string" ||
          !isBuiltIn(declared.value.replace(/#$/, ""))
        )
          unsupported(
            "AJV validateSchema requires a supported dialect $schema declaration",
            schema,
          );
      }
      const validate = this.builtInMetaValidator();
      const valid = validate(schema);
      this.errors = validate.errors;
      return valid;
    }

    private builtInMetaValidator(): AjvCompatibleValidator {
      if (this.metaValidator) return this.metaValidator;
      const meta = metaValidators[dialect];
      const validate: AjvCompatibleValidator = (schema) => {
        const valid = meta(schema);
        const errors = meta.errors ?? [
          {
            keyword: "schema",
            instancePath: "",
            schemaPath: "#",
            params: {},
            message: "schema does not match its meta-schema",
          },
        ];
        validate.errors = valid
          ? null
          : [...(this.opts.allErrors === true ? errors : errors.slice(0, 1))];
        return valid;
      };
      validate.schema = meta.schema;
      validate.errors = null;
      this.metaValidator = validate;
      return validate;
    }

    compile(schema: unknown): AjvCompatibleValidator {
      return this.compileSchema(schema);
    }

    private compileSchema(schema: unknown, registrationId?: string): AjvCompatibleValidator {
      try {
        canonicalSchema(schema);
      } catch {
        unsupported("Schema must contain finite JSON values without cycles or accessors", schema);
      }
      const cached = this.validators.get(schema);
      if (cached) return cached;
      if (this.opts.validateSchema !== false && !this.validateSchema(schema))
        throw new Error(`schema is invalid: ${this.errorsText(this.errors)}`);
      if (this.opts.validateSchema === false && !metaValidators[dialect](schema))
        unsupported(
          "Interpreter cannot accept malformed schemas with validateSchema:false",
          schema,
        );
      const prepared = this.prepare(schema);
      if (typeof prepared !== "boolean" && registrationId && !prepared.$id)
        prepared.$id = registrationId;
      const ownId = typeof prepared !== "boolean" ? prepared.$id?.replace(/#$/, "") : undefined;
      if (ownId && isBuiltIn(ownId))
        throw new Error(`schema with key or id "${ownId}" already exists`);
      if (ownId && this.schemaRegistry.has(ownId) && this.schemaRegistry.get(ownId) !== schema)
        throw new Error(`schema with key or id "${ownId}" already exists`);
      // AJV 8 applies $ref siblings in draft 7 too. The interpreter's draft 7 mode discards them.
      const draft: SchemaDraft = dialect === "2020" ? "2020-12" : "2019-09";
      const validator = this.buildValidator(prepared, draft, ownId, schema);
      const formatPredicates = new Map(this.formatPredicates);
      const schemaInputs = [prepared, ...this.schemaRegistry.values()];
      const validate: AjvCompatibleValidator = (data) => {
        const normalized = normalizeValidationData(data, schemaInputs);
        const previous = new Map<string, ((value: string) => boolean) | undefined>(
          [...formatPredicates].map(([name]) => [name, format[name]]),
        );
        try {
          for (const [name, predicate] of formatPredicates) format[name] = predicate;
          const result = validator.validate(normalized);
          validate.errors = result.valid
            ? null
            : toAjvErrors(result.errors, schema, this.opts.allErrors === true);
          return result.valid;
        } catch (error) {
          if (error instanceof UnsupportedAjvSchemaError) throw error;
          unsupported(
            `Interpreter could not evaluate this schema: ${error instanceof Error ? error.message : String(error)}`,
            schema,
          );
        } finally {
          restoreFormats(previous);
        }
      };
      validate.errors = null;
      validate.schema = schema;
      this.validators.set(schema, validate);
      if (schema && typeof schema === "object" && "$id" in schema && typeof schema.$id === "string")
        this.schemaRegistry.set(schema.$id.replace(/#$/, ""), schema);
      return validate;
    }

    private buildValidator(
      prepared: ConstructorParameters<typeof Validator>[0],
      draft: SchemaDraft,
      ownId: string | undefined,
      schema: unknown,
    ) {
      try {
        const validator = new Validator(prepared, draft, this.opts.allErrors !== true);
        for (const [id, registered] of this.schemaRegistry) {
          if (id === ownId) continue;
          const external = this.prepare(registered);
          validator.addSchema(
            typeof external === "boolean" ? (external ? {} : { not: {} }) : external,
            id,
          );
        }
        return validator;
      } catch (error) {
        if (error instanceof UnsupportedAjvSchemaError) throw error;
        unsupported(
          `Interpreter could not prepare this schema: ${error instanceof Error ? error.message : String(error)}`,
          schema,
        );
      }
    }

    addSchema(schema: unknown, id?: string) {
      if (Array.isArray(schema)) {
        schema.forEach((item) => this.addSchema(item));
        return this;
      }
      this.prepare(schema);
      if (this.opts.validateSchema !== false && !this.validateSchema(schema))
        throw new Error("schema is invalid");
      const key =
        id ??
        (schema && typeof schema === "object" && "$id" in schema && typeof schema.$id === "string"
          ? schema.$id
          : undefined);
      if (!key) unsupported("External schema requires an id", schema);
      const normalized = key.replace(/#$/, "");
      if (isBuiltIn(normalized))
        throw new Error(`schema with key or id "${normalized}" already exists`);
      if (
        id &&
        schema &&
        typeof schema === "object" &&
        "$id" in schema &&
        typeof schema.$id === "string" &&
        schema.$id.replace(/#$/, "") !== normalized
      )
        unsupported(
          "External schema aliases with a different $id require a compiler profile",
          schema,
        );
      if (this.schemaRegistry.has(normalized))
        throw new Error(`schema with key or id "${normalized}" already exists`);
      this.schemaRegistry.set(normalized, schema);
      return this;
    }

    getSchema(id: string) {
      if (id.includes("#") && !id.endsWith("#"))
        unsupported("AJV getSchema fragment lookup requires a compiler profile");
      const normalized = id.replace(/#$/, "");
      if (normalized === "")
        unsupported("AJV getSchema anonymous lookup requires a compiler profile");
      if (isBuiltIn(normalized)) return this.builtInMetaValidator();
      const schema = this.schemaRegistry.get(normalized);
      return schema === undefined ? undefined : this.compileSchema(schema, normalized);
    }

    validate(schema: unknown, data: unknown) {
      const validator = typeof schema === "string" ? this.getSchema(schema) : this.compile(schema);
      if (!validator) throw new Error(`no schema with key or ref "${String(schema)}"`);
      const valid = validator(data);
      this.errors = validator.errors;
      return valid;
    }

    // Formatting matches AJV's separator/dataVar options, but messages keep the interpreter's wording.
    errorsText(
      errors: AjvCompatibleError[] | null = this.errors,
      options: { separator?: string; dataVar?: string } = {},
    ) {
      if (!errors?.length) return "No errors";
      return (
        errors
          ?.map((error) => `${options.dataVar ?? "data"}${error.instancePath} ${error.message}`)
          .join(options.separator ?? ", ") ?? "No errors"
      );
    }
  };
}
