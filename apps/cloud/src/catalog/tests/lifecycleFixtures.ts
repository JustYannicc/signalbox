import { pageCursorSchema, type Row, type WriteTable } from "@signalbox/sync/table";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { CatalogHome } from "../catalogHome.ts";
import { catalogRootTables } from "../catalogHomeTables.ts";
import type { CatalogOrganizationWriteContext } from "../catalogOrganizationPolicy.ts";
import type { CatalogPersonalWriteContext } from "../catalogOrganizationReferences.ts";
import { organizationContext } from "./organizationContext.ts";
import { policyContext } from "./policyContext.ts";

type Folders = typeof catalogRootTables.folders;
type Value = string | number | null;
const compare = (a: Value, b: Value) =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
const field = (row: Row<Folders>, name: string) => (row as Record<string, Value>)[name] ?? null;

/** Pages folders like storage, including the range and descending order the shared fixtures skip. */
const storageOrderedFolders = (
  table: WriteTable<Folders>,
  rows: () => ReadonlyArray<Row<Folders>>,
): WriteTable<Folders> => ({
  ...table,
  page: (index, options) => {
    const decodeCursor = Schema.decodeUnknownSync(
      pageCursorSchema(catalogRootTables.folders, index),
    );
    return Effect.sync(() => {
      const fields = catalogRootTables.folders.indexes[index].fields;
      const prefix = (options.prefix ?? []) as ReadonlyArray<Value>;
      const range = options.range as { from?: Value; to?: Value } | undefined;
      const ranged = fields[prefix.length];
      const ordered = rows()
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
});

/** An organization root whose folder pages honour the full index contract. */
export const organizationLifecycle = (seeds: Parameters<typeof organizationContext>[0] = {}) => {
  const context = organizationContext(seeds);
  const folders = storageOrderedFolders(context.projection.tables.folders, context.folders.rows);
  const as = (userId: string): CatalogOrganizationWriteContext => ({
    ...context.as(userId),
    tables: { ...context.projection.tables, folders },
  });
  return { ...context, as };
};

/** A personal root owned by `owner`, shared by every actor that `as` returns. */
export const personalLifecycle = (seeds: Parameters<typeof policyContext>[1] = {}) => {
  const context = policyContext("owner", seeds);
  const ctx: CatalogPersonalWriteContext = {
    ...context.ctx,
    tables: {
      ...context.ctx.tables,
      folders: storageOrderedFolders(context.ctx.tables.folders, context.folders.rows),
    },
  };
  const as = (userId: string): CatalogPersonalWriteContext => ({ ...ctx, actor: { userId } });
  return { ...context, as };
};

/** The canonical child level the runtime provisions after a create commits. */
export const childLevel = (owner: CatalogHome["owner"], id: string, incarnation = 1) => ({
  home: { owner, level: { _tag: "folder" as const, id: FolderId.make(id) } },
  incarnation,
});

export const ref = (id: string, incarnation = 1) => ({
  folderId: FolderId.make(id),
  incarnation,
});

export const childRow = (id: string, extra = {}) => ({
  id,
  parentId: null,
  parentIncarnation: 1,
  incarnation: 1,
  name: id,
  position: 0,
  state: "active",
  ...extra,
});
