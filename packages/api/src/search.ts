import { jsonSchemaOf, type Operation, operations } from "./catalog.ts";

/**
 * Finding an operation by what it does: the search half of search-then-call
 * (#335). Hundreds of operations stay out of an agent's context; it asks for
 * a few by intent and gets their input schemas.
 */

const words = (text: string) =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);

/** Light stemming, so "runs" finds "run" and "settings" finds "setting". */
const stem = (word: string) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);

interface Indexed {
  readonly operation: Operation;
  readonly name: ReadonlySet<string>;
  readonly summary: ReadonlySet<string>;
  readonly fields: ReadonlySet<string>;
}

const fieldNames = (operation: Operation) => {
  const properties = jsonSchemaOf(operation.input).schema.properties;
  return typeof properties === "object" && properties !== null ? Object.keys(properties) : [];
};

let index: ReadonlyArray<Indexed> | undefined;
const indexed = () =>
  (index ??= operations.map((operation) => ({
    operation,
    name: new Set(words(operation.name).map(stem)),
    summary: new Set(words(operation.summary ?? "").map(stem)),
    fields: new Set(fieldNames(operation).flatMap(words).map(stem)),
  })));

const matches = (set: ReadonlySet<string>, word: string) =>
  set.has(word) || [...set].some((candidate) => candidate.startsWith(word));

/** Operations ranked for `query`, best first; `include` drops what this caller may not use. */
export const searchOperations = (
  query: string,
  options: { readonly limit: number; readonly include: (operation: Operation) => boolean },
): ReadonlyArray<Operation> => {
  const terms = words(query).map(stem);
  if (terms.length === 0) return [];
  return indexed()
    .filter((entry) => options.include(entry.operation))
    .map((entry) => ({
      operation: entry.operation,
      score: terms.reduce(
        (total, term) =>
          total +
          (matches(entry.name, term) ? 3 : 0) +
          (matches(entry.summary, term) ? 2 : 0) +
          (matches(entry.fields, term) ? 1 : 0),
        // Operations someone took the time to describe are the ones people reach for.
        entry.operation.summary === undefined ? 0 : 0.5,
      ),
    }))
    .filter((entry) => entry.score > 0.5)
    .sort((a, b) => b.score - a.score || a.operation.name.localeCompare(b.operation.name))
    .slice(0, options.limit)
    .map((entry) => entry.operation);
};
