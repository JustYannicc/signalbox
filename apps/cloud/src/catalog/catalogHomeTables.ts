import { table } from "@signalbox/sync/table";

import {
  CatalogFolderRow,
  CatalogFolderHomeState,
  CatalogGrantRow,
  CatalogRootHomeState,
  CatalogRootState,
} from "./catalogHomeSchema.ts";

export const catalogFolderTables = {
  state: table({ row: CatalogFolderHomeState, key: ["key"], indexes: {} }),
};

/** Topology and grants have one authority: the owner's bound top home. */
export const catalogRootTables = {
  state: table({ row: CatalogRootHomeState, key: ["key"], indexes: {} }),
  root: table({ row: CatalogRootState, key: ["key"], indexes: {} }),
  folders: table({
    row: CatalogFolderRow,
    key: ["id"],
    indexes: { byParent: { fields: ["parentId", "parentIncarnation", "position", "id"] } },
  }),
  grants: table({
    row: CatalogGrantRow,
    // Old grants cannot attach to a recreated level.
    key: ["folderId", "incarnation", "personId"],
    indexes: { byPerson: { fields: ["personId", "folderId", "incarnation"] } },
  }),
};
