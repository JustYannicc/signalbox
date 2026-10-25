import { pageCursorSchema, type Row, type Table, type WriteTable } from "@signalbox/sync/table";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  CatalogPersonalProjectionContext,
  CatalogPersonalWriteContext,
} from "../catalogOrganizationReferences.ts";
import { catalogPersonalTables } from "../catalogPersonalTables.ts";
import { CatalogPersonalRoot } from "../catalogPolicy.ts";

type Tables = typeof catalogPersonalTables;
type Value = string | number | null;
const compare = (a: Value, b: Value) =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;

/** Decodes every row like storage and pages any declared index with prefix, range and order. */
const memoryTable = <T extends Table>(
  definition: T,
  decode: (input: unknown) => Row<T>,
  initial: ReadonlyArray<unknown>,
) => {
  const field = (row: Row<T>, name: string) => (row as Record<string, Value>)[name] ?? null;
  const keyOf = (row: Row<T>) =>
    definition.key.length === 1
      ? field(row, definition.key[0] as string)
      : Object.fromEntries(definition.key.map((name) => [name, field(row, name as string)]));
  let rows: Array<Row<T>> = initial.map((row) => decode(row));
  const matches = (row: Row<T>, key: unknown) => NodeUtil.isDeepStrictEqual(keyOf(row), key);
  const table: WriteTable<T> = {
    get: (key) => Effect.sync(() => Option.fromUndefinedOr(rows.find((row) => matches(row, key)))),
    unique: () => Effect.die("Unexpected unique lookup"),
    page: (index, options) => {
      const decodeCursor = Schema.decodeUnknownSync(pageCursorSchema(definition, index));
      return Effect.sync(() => {
        const fields = (definition.indexes as Record<string, { fields: Array<string> }>)[index]!
          .fields;
        const prefix = (options.prefix ?? []) as ReadonlyArray<Value>;
        const range = options.range as { from?: Value; to?: Value } | undefined;
        const ranged = fields[prefix.length];
        const ordered = rows
          .filter(
            (row) =>
              prefix.every((value, at) => field(row, fields[at]!) === value) &&
              (range === undefined ||
                ranged === undefined ||
                ((range.from === undefined || compare(field(row, ranged), range.from) >= 0) &&
                  (range.to === undefined || compare(field(row, ranged), range.to) <= 0))),
          )
          .toSorted((a, b) => {
            for (const name of fields) {
              const order = compare(field(a, name), field(b, name));
              if (order !== 0) return order;
            }
            return 0;
          });
        if (options.order === "desc") ordered.reverse();
        const offset = options.after === undefined ? 0 : Number(options.after);
        const end = offset + options.limit;
        return {
          rows: ordered.slice(offset, end),
          after: end < ordered.length ? decodeCursor(String(end)) : undefined,
        };
      });
    },
    insert: (row) => Effect.sync(() => void rows.push(decode(row))),
    replace: (key, value) =>
      Effect.sync(() => {
        rows = rows.map((row) => (matches(row, key) ? decode(value) : row));
      }),
    patch: (key, patch) =>
      Effect.sync(() => {
        rows = rows.map((row) => (matches(row, key) ? decode(Object.assign({}, row, patch)) : row));
      }),
    delete: (key) =>
      Effect.sync(() => {
        rows = rows.filter((row) => !matches(row, key));
      }),
  };
  return { table, rows: () => rows };
};

// Concrete decoders keep each table's row type; a generic decode widens to the Table constraint.
const decoders = {
  state: Schema.decodeUnknownSync(catalogPersonalTables.state.row),
  root: Schema.decodeUnknownSync(catalogPersonalTables.root.row),
  folders: Schema.decodeUnknownSync(catalogPersonalTables.folders.row),
  grants: Schema.decodeUnknownSync(catalogPersonalTables.grants.row),
  organizationReferences: Schema.decodeUnknownSync(
    catalogPersonalTables.organizationReferences.row,
  ),
};
const decodeHome = Schema.decodeUnknownSync(CatalogPersonalRoot);
export const personalHome = (id = "owner") =>
  decodeHome({ owner: { _tag: "person", id }, level: { _tag: "top" } });

type Seeds = { readonly [K in keyof Tables]?: ReadonlyArray<unknown> };

export const personalState = (extra = {}, home = personalHome()) => ({
  key: "state",
  level: { home, incarnation: 1 },
  revision: 0,
  storageState: "open",
  ...extra,
});
export const personalRoot = (extra = {}) => ({
  key: "root",
  topologyRevision: 0,
  authEpoch: 0,
  ...extra,
});

/** A personal root owned by `owner`; omit `state`/`root` seeds for an open root at incarnation 1. */
export const referenceContext = (seeds: Seeds = {}, home = personalHome()) => {
  const tables = {
    state: memoryTable(
      catalogPersonalTables.state,
      decoders.state,
      seeds.state ?? [personalState()],
    ),
    root: memoryTable(catalogPersonalTables.root, decoders.root, seeds.root ?? [personalRoot()]),
    folders: memoryTable(catalogPersonalTables.folders, decoders.folders, seeds.folders ?? []),
    grants: memoryTable(catalogPersonalTables.grants, decoders.grants, seeds.grants ?? []),
    organizationReferences: memoryTable(
      catalogPersonalTables.organizationReferences,
      decoders.organizationReferences,
      seeds.organizationReferences ?? [],
    ),
  };
  const fences: Array<{ readonly scope: string; readonly epoch: number }> = [];
  const projection: CatalogPersonalProjectionContext = {
    home,
    tables: {
      state: tables.state.table,
      root: tables.root.table,
      folders: tables.folders.table,
      grants: tables.grants.table,
      organizationReferences: tables.organizationReferences.table,
    },
    requireAuthorizationFence: (fence) => Effect.sync(() => void fences.push(fence)),
  };
  const as = (userId: string): CatalogPersonalWriteContext => ({
    ...projection,
    actor: { userId },
  });
  return { ...tables, projection, as, fences };
};
