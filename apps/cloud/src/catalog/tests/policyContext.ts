import {
  pageCursorSchema,
  type Key,
  type Row,
  type Table,
  type WriteTable,
} from "@signalbox/sync/table";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { catalogRootTables } from "../catalogHomeTables.ts";
import type { CatalogPersonalWriteContext } from "../catalogOrganizationReferences.ts";
import type { catalogPersonalTables } from "../catalogPersonalTables.ts";
import { CatalogPersonalRoot, CatalogPolicyActor } from "../catalogPolicy.ts";

const memoryTable = <T extends Table>(
  initial: ReadonlyArray<Row<T>>,
  keyFor: (row: Row<T>) => Key<T>,
) => {
  let rows = [...initial];
  const matches = (row: Row<T>, key: Key<T>) => NodeUtil.isDeepStrictEqual(keyFor(row), key);
  const table: WriteTable<T> = {
    get: (key) => Effect.sync(() => Option.fromUndefinedOr(rows.find((row) => matches(row, key)))),
    unique: () => Effect.die("Unexpected unique lookup"),
    page: () => Effect.die("Unexpected page lookup"),
    insert: (row) =>
      Effect.sync(() => {
        rows.push(row);
      }),
    replace: (key, value) =>
      Effect.sync(() => {
        rows = rows.map((row) => (matches(row, key) ? value : row));
      }),
    patch: (key, patch) =>
      Effect.sync(() => {
        rows = rows.map((row) => (matches(row, key) ? Object.assign({}, row, patch) : row));
      }),
    delete: (key) =>
      Effect.sync(() => {
        rows = rows.filter((row) => !matches(row, key));
      }),
  };
  return { table, rows: () => rows };
};

const decodeHome = Schema.decodeUnknownSync(CatalogPersonalRoot);
const decodeActor = Schema.decodeUnknownSync(CatalogPolicyActor);

type Seeds = {
  readonly folders?: ReadonlyArray<Row<typeof catalogRootTables.folders>>;
  readonly grants?: ReadonlyArray<Row<typeof catalogRootTables.grants>>;
  readonly state?: Partial<Row<typeof catalogRootTables.state>>;
  readonly root?: Partial<Row<typeof catalogRootTables.root>>;
};

export const policyContext = (userId = "owner", seeds: Seeds = {}) => {
  const home = decodeHome({
    owner: { _tag: "person", id: "owner" },
    level: { _tag: "top" },
  });
  const state = memoryTable<typeof catalogRootTables.state>(
    [
      {
        key: "state",
        level: { home, incarnation: 1 },
        revision: 0,
        storageState: "open",
        ...seeds.state,
      },
    ],
    (row) => row.key,
  );
  const root = memoryTable<typeof catalogRootTables.root>(
    [{ key: "root", topologyRevision: 0, authEpoch: 0, ...seeds.root }],
    (row) => row.key,
  );
  const folders = memoryTable<typeof catalogRootTables.folders>(
    seeds.folders ?? [],
    (row) => row.id,
  );
  const folderTable: WriteTable<typeof catalogRootTables.folders> = {
    ...folders.table,
    page: (index, options) => {
      const decodeCursor = Schema.decodeUnknownSync(
        pageCursorSchema(catalogRootTables.folders, index),
      );
      return Effect.sync(() => {
        const ordered = folders
          .rows()
          .filter(
            (row) =>
              row.parentId === options.prefix?.[0] && row.parentIncarnation === options.prefix?.[1],
          )
          .toSorted((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const offset = options.after === undefined ? 0 : Number(options.after);
        const end = offset + options.limit;
        return {
          rows: ordered.slice(offset, end),
          after: end < ordered.length ? decodeCursor(String(end)) : undefined,
        };
      });
    },
  };
  const grants = memoryTable<typeof catalogRootTables.grants>(
    seeds.grants ?? [],
    ({ folderId, incarnation, personId }) => ({ folderId, incarnation, personId }),
  );
  const references = memoryTable<typeof catalogPersonalTables.organizationReferences>(
    [],
    (row) => row.organizationId,
  );
  const fences: Array<{ readonly scope: string; readonly epoch: number }> = [];
  const ctx: CatalogPersonalWriteContext = {
    actor: decodeActor({ userId }),
    home,
    tables: {
      state: state.table,
      root: root.table,
      folders: folderTable,
      grants: grants.table,
      organizationReferences: references.table,
    },
    requireAuthorizationFence: (fence) =>
      Effect.sync(() => {
        fences.push(fence);
      }),
  };
  return { ctx, state, root, folders, grants, fences };
};
