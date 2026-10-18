import * as Cloudflare from "alchemy/Cloudflare";

/** The portable Lunora manifest revision understood by this Alchemy adapter. */
export const LUNORA_BINDING_MANIFEST_VERSION = 1;

/** The small part of Lunora's manifest this adapter consumes. */
export interface BindingManifestInput {
  readonly version: number;
  readonly unknown: ReadonlyArray<string>;
  readonly bindings: ReadonlyArray<{
    readonly type: string;
    readonly binding: string;
    readonly className?: string;
    readonly sqlite?: boolean;
  }>;
}

/** Type-only allowlist of Worker class exports, supplied by the entry point owner. */
export type DurableObjectExports = Readonly<Record<string, true>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unsupportedBindingKeys = new Set(["binding", "className", "sqlite", "type"]);
const supportedManifestKeys = new Set([
  "bindings",
  "compatibilityDate",
  "compatibilityFlags",
  "crons",
  "unknown",
  "vars",
  "version",
]);

const validateManifest = (input: unknown) => {
  if (!isRecord(input)) {
    throw new Error("Invalid Lunora BindingManifest: expected an object.");
  }
  if (input.version !== LUNORA_BINDING_MANIFEST_VERSION) {
    throw new Error(
      `Unsupported Lunora BindingManifest version ${String(input.version)}; expected ${LUNORA_BINDING_MANIFEST_VERSION}.`,
    );
  }
  const extraKeys = Object.keys(input).filter((key) => !supportedManifestKeys.has(key));
  if (extraKeys.length > 0) {
    throw new Error(
      `Unsupported Lunora BindingManifest fields: ${extraKeys.toSorted().join(", ")}.`,
    );
  }
  if (!Array.isArray(input.unknown) || input.unknown.some((entry) => typeof entry !== "string")) {
    throw new Error("Invalid Lunora BindingManifest: unknown must be an array of strings.");
  }
  if (input.unknown.length > 0) {
    throw new Error(`Lunora BindingManifest has unmodelled config: ${input.unknown.join(", ")}.`);
  }
  if (!Array.isArray(input.bindings)) {
    throw new Error("Invalid Lunora BindingManifest: bindings must be an array.");
  }
  for (const key of ["crons", "vars"] as const) {
    if (key in input && (!Array.isArray(input[key]) || input[key].length > 0)) {
      throw new Error(
        `Unsupported Lunora BindingManifest ${key}: this Alchemy adapter does not configure ${key}.`,
      );
    }
  }

  const bindings: Array<{ readonly binding: string; readonly className: string }> = [];
  const names = new Set<string>();

  for (const [index, candidate] of input.bindings.entries()) {
    if (!isRecord(candidate) || typeof candidate.type !== "string") {
      throw new Error(`Invalid Lunora binding at index ${index}: expected an object with a type.`);
    }
    if (candidate.type !== "durable_object") {
      throw new Error(
        `Unsupported Lunora binding kind "${candidate.type}"; this Alchemy v2 adapter supports only durable_object bindings.`,
      );
    }

    const extraKeys = Object.keys(candidate).filter((key) => !unsupportedBindingKeys.has(key));
    if (extraKeys.length > 0) {
      throw new Error(
        `Unsupported fields on Lunora Durable Object binding: ${extraKeys.toSorted().join(", ")}.`,
      );
    }
    if (typeof candidate.binding !== "string" || candidate.binding.length === 0) {
      throw new Error(
        `Invalid Lunora Durable Object binding at index ${index}: binding must be nonempty.`,
      );
    }
    if (typeof candidate.className !== "string" || candidate.className.length === 0) {
      throw new Error(
        `Invalid Lunora Durable Object binding "${candidate.binding}": className must be nonempty.`,
      );
    }
    if (candidate.sqlite !== true) {
      throw new Error(
        `Unsupported storage mode for Lunora Durable Object "${candidate.className}": Alchemy v2 creates newly bound classes as SQLite and has no legacy-storage binding option.`,
      );
    }
    if (names.has(candidate.binding)) {
      throw new Error(`Duplicate Lunora binding name "${candidate.binding}".`);
    }
    names.add(candidate.binding);
    bindings.push({ binding: candidate.binding, className: candidate.className });
  }

  return bindings;
};

/**
 * Convert supported Lunora requirements into Alchemy v2 Worker `env` props.
 * The class map is an explicit allowlist of exports from the Worker entry; the
 * manifest cannot select an import or arbitrary Cloudflare binding config.
 */
export const toAlchemyBindings = (
  manifest: unknown,
  classExports: DurableObjectExports,
): Record<string, Cloudflare.DurableObjectLike<unknown>> => {
  const requirements = validateManifest(manifest);
  if (!isRecord(classExports)) {
    throw new Error(
      "Invalid supplied Worker class exports: expected an object of exported classes.",
    );
  }
  for (const requirement of requirements) {
    if (
      !Object.hasOwn(classExports, requirement.className) ||
      classExports[requirement.className] !== true
    ) {
      throw new Error(
        `Lunora Durable Object class "${requirement.className}" is not present in the supplied Worker export allowlist.`,
      );
    }
  }

  return Object.fromEntries(
    requirements.map(({ binding, className }) => [
      binding,
      Cloudflare.DurableObject<unknown>(binding, { className }),
    ]),
  );
};
