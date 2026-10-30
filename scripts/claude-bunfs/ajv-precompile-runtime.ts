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
  }

  toJSON() {
    return { code: this.code, site: this.site, schemaId: this.schemaId, reason: this.reason };
  }
}

export interface AjvCompatibilityState {
  readonly UnsupportedAjvSchemaError: new (
    site: AjvCompileSite,
    schema: unknown,
    reason: string,
  ) => UnsupportedAjvSchemaError;
  assertAjvCompatibility(): void;
  setAjvCompatibilityFailureReporter(reporter: (error: UnsupportedAjvSchemaError) => void): void;
}

/** Each JS realm owns one sticky compatibility latch for its lifetime. */
export function createAjvCompatibilityState(): AjvCompatibilityState {
  let unsupportedFailure: UnsupportedAjvSchemaError | undefined;
  let reporterFailure: AggregateError | undefined;
  let reporter: ((error: UnsupportedAjvSchemaError) => void) | undefined;
  let reporterInstalled = false;

  const recordReporterFailure = (cause: unknown) => {
    if (reporterFailure !== undefined || unsupportedFailure === undefined) return;
    reporterFailure = Object.assign(
      new AggregateError([unsupportedFailure, cause], unsupportedFailure.message, {
        cause: unsupportedFailure,
      }),
      { code: unsupportedFailure.code },
    );
  };

  const record = (error: UnsupportedAjvSchemaError) => {
    if (unsupportedFailure !== undefined) return;
    unsupportedFailure = error;
    try {
      reporter?.(error);
    } catch (cause) {
      recordReporterFailure(cause);
    }
  };

  class RealmUnsupportedAjvSchemaError extends UnsupportedAjvSchemaError {
    constructor(site: AjvCompileSite, schema: unknown, reason: string) {
      super(site, schema, reason);
      record(this);
    }
  }

  return {
    UnsupportedAjvSchemaError: RealmUnsupportedAjvSchemaError,
    assertAjvCompatibility() {
      if (reporterFailure !== undefined) throw reporterFailure;
      if (unsupportedFailure !== undefined) throw unsupportedFailure;
    },
    setAjvCompatibilityFailureReporter(nextReporter) {
      if (reporterInstalled) {
        if (reporter === nextReporter) return;
        throw new Error("AJV compatibility failure reporter is already installed");
      }
      reporterInstalled = true;
      reporter = nextReporter;
      if (unsupportedFailure !== undefined) {
        try {
          reporter(unsupportedFailure);
        } catch (cause) {
          recordReporterFailure(cause);
        }
      }
    },
  };
}

export const defaultAjvCompatibilityState = createAjvCompatibilityState();

export const assertAjvCompatibility = defaultAjvCompatibilityState.assertAjvCompatibility;
export const setAjvCompatibilityFailureReporter =
  defaultAjvCompatibilityState.setAjvCompatibilityFailureReporter;

// This module deliberately has no AJV import. Workers only receive generated validators.
export function createPrecompiledAjvRegistry(
  entries: readonly PrecompiledSchema[],
  sites: readonly AjvCompileSite[],
  compatibility: AjvCompatibilityState = defaultAjvCompatibilityState,
) {
  const registered = new Map(
    entries.map((entry) => [entry.site.id, { ...entry, key: canonicalSchema(entry.schema) }]),
  );
  const locations = new Map(sites.map((site) => [site.id, site]));
  return (schema: unknown, siteId: string): PrecompiledValidator => {
    const site = locations.get(siteId) ?? { id: siteId, module: "unknown", offset: 0 };
    const entry = registered.get(siteId);
    if (!entry)
      throw new compatibility.UnsupportedAjvSchemaError(
        site,
        schema,
        site.reason ?? "No generated validator for this call",
      );
    let key: string;
    try {
      key = canonicalSchema(schema);
    } catch {
      throw new compatibility.UnsupportedAjvSchemaError(
        site,
        schema,
        "Runtime schema is not finite JSON",
      );
    }
    if (key !== entry.key)
      throw new compatibility.UnsupportedAjvSchemaError(
        site,
        schema,
        "Runtime schema differs from the build input",
      );
    return entry.validate;
  };
}
