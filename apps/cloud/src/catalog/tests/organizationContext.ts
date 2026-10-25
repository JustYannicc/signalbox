import { pageCursorSchema, type Table, type Row, type WriteTable } from "@signalbox/sync/table";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  CatalogOrganizationRoot,
  type CatalogOrganizationProjectionContext,
  type CatalogOrganizationWriteContext,
} from "../catalogOrganizationPolicy.ts";
import { catalogOrganizationTables } from "../catalogOrganizationTables.ts";

type Tables = typeof catalogOrganizationTables;
type Value = string | number | null;
const compare = (a: Value, b: Value) =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;

/** Decodes every row like real storage, and pages any declared index in its field order. */
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
        const ordered = rows
          .filter((row) => prefix.every((value, at) => field(row, fields[at]!) === value))
          .toSorted((a, b) => {
            for (const name of fields) {
              const order = compare(field(a, name), field(b, name));
              if (order !== 0) return order;
            }
            return 0;
          });
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
  state: Schema.decodeUnknownSync(catalogOrganizationTables.state.row),
  root: Schema.decodeUnknownSync(catalogOrganizationTables.root.row),
  folders: Schema.decodeUnknownSync(catalogOrganizationTables.folders.row),
  grants: Schema.decodeUnknownSync(catalogOrganizationTables.grants.row),
  memberships: Schema.decodeUnknownSync(catalogOrganizationTables.memberships.row),
};
const decodeHome = Schema.decodeUnknownSync(CatalogOrganizationRoot);
export const organizationHome = (id = "org_one") =>
  decodeHome({ owner: { _tag: "organization", id }, level: { _tag: "top" } });

type Seeds = { readonly [K in keyof Tables]?: ReadonlyArray<unknown> };

/** An organization root's storage; omit `state`/`root` seeds for an unbootstrapped root. */
export const organizationContext = (seeds: Seeds = {}, home = organizationHome()) => {
  const tables = {
    state: memoryTable(catalogOrganizationTables.state, decoders.state, seeds.state ?? []),
    root: memoryTable(catalogOrganizationTables.root, decoders.root, seeds.root ?? []),
    folders: memoryTable(catalogOrganizationTables.folders, decoders.folders, seeds.folders ?? []),
    grants: memoryTable(catalogOrganizationTables.grants, decoders.grants, seeds.grants ?? []),
    memberships: memoryTable(
      catalogOrganizationTables.memberships,
      decoders.memberships,
      seeds.memberships ?? [],
    ),
  };
  const fences: Array<{ readonly scope: string; readonly epoch: number }> = [];
  const projection: CatalogOrganizationProjectionContext = {
    home,
    tables: {
      state: tables.state.table,
      root: tables.root.table,
      folders: tables.folders.table,
      grants: tables.grants.table,
      memberships: tables.memberships.table,
    },
    requireAuthorizationFence: (fence) => Effect.sync(() => void fences.push(fence)),
  };
  const as = (userId: string): CatalogOrganizationWriteContext => ({
    ...projection,
    actor: { userId },
  });
  return { ...tables, projection, as, fences };
};
