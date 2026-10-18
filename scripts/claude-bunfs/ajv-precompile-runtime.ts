export interface PrecompiledValidator {
  (data: unknown): boolean | Promise<unknown>;
  errors?: unknown;
}

export interface AjvCompileSite {
  id: string;
  module: string;
  offset: number;
  reason?: string;
}

export interface PrecompiledSchema {
  site: AjvCompileSite;
  schema: unknown;
  validate: PrecompiledValidator;
}

// JSON ordering is irrelevant to AJV, but array order and schema values matter.
export function canonicalSchema(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(input: unknown): string {
    if (input === null || typeof input === "boolean" || typeof input === "string") {
      return JSON.stringify(input);
    }
    if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== "object" || input === null || ancestors.has(input)) {
      throw new TypeError("Schema must contain finite JSON values without cycles");
    }
    if (
      !Array.isArray(input) &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    ) {
      throw new TypeError("Schema must contain plain JSON objects");
    }
    ancestors.add(input);
    try {
      if (Array.isArray(input)) return `[${Array.from(input, encode).join(",")}]`;
      return `{${Object.keys(input)
        .sort()
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(input, key);
          if (!descriptor || !("value" in descriptor))
            throw new TypeError("Schema accessors are unsupported");
          return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
        })
        .join(",")}}`;
    } finally {
      ancestors.delete(input);
    }
  }
  return encode(value);
}

export class UnsupportedAjvSchemaError extends Error {
  readonly code = "AJV_SCHEMA_NOT_PRECOMPILED";
  readonly schemaId: string | undefined;
  readonly site: AjvCompileSite;
  readonly reason: string;

  constructor(site: AjvCompileSite, schema: unknown, reason: string) {
    super(`AJV schema at ${site.module}:${site.offset} is not precompiled: ${reason}`);
    this.site = site;
    this.reason = reason;
    this.name = "UnsupportedAjvSchemaError";
    const descriptor =
      schema && typeof schema === "object"
        ? Object.getOwnPropertyDescriptor(schema, "$id")
        : undefined;
    this.schemaId =
      descriptor && "value" in descriptor && typeof descriptor.value === "string"
        ? descriptor.value
        : undefined;
    recordUnsupportedAjvFailure(this);
  }

  toJSON() {
    return { code: this.code, site: this.site, schemaId: this.schemaId, reason: this.reason };
  }
}

// Claude catches compilation errors in optional validators. The host must check this before accepting a result.
let unsupportedAjvFailure: UnsupportedAjvSchemaError | undefined;

function recordUnsupportedAjvFailure(error: UnsupportedAjvSchemaError) {
  unsupportedAjvFailure ??= error;
}

export function assertAjvCompatibility() {
  if (unsupportedAjvFailure) throw unsupportedAjvFailure;
}

/** Reset only at the beginning of an isolated invocation, before any Claude code executes. */
export function resetAjvCompatibility() {
  unsupportedAjvFailure = undefined;
}

// This module deliberately has no AJV import. Workers only receive generated validators.
export function createPrecompiledAjvRegistry(
  entries: readonly PrecompiledSchema[],
  sites: readonly AjvCompileSite[],
) {
  const registered = new Map(
    entries.map((entry) => [entry.site.id, { ...entry, key: canonicalSchema(entry.schema) }]),
  );
  const locations = new Map(sites.map((site) => [site.id, site]));
  return (schema: unknown, siteId: string): PrecompiledValidator => {
    const site = locations.get(siteId) ?? { id: siteId, module: "unknown", offset: 0 };
    const entry = registered.get(siteId);
    if (!entry)
      throw new UnsupportedAjvSchemaError(
        site,
        schema,
        site.reason ?? "No generated validator for this call",
      );
    let key: string;
    try {
      key = canonicalSchema(schema);
    } catch {
      throw new UnsupportedAjvSchemaError(site, schema, "Runtime schema is not finite JSON");
    }
    if (key !== entry.key)
      throw new UnsupportedAjvSchemaError(
        site,
        schema,
        "Runtime schema differs from the build input",
      );
    return entry.validate;
  };
}
