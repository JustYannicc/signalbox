import { table } from "@signalbox/sync/table";

import {
  CatalogFolderRow,
  CatalogGrantRow,
  CatalogHomeState,
  CatalogRootState,
} from "./catalogHomeSchema.ts";

export const catalogLevelTables = {
  state: table({ row: CatalogHomeState, key: ["key"], indexes: {} }),
};

/** Topology and grants have one authority: the owner's bound top home. */
export const catalogRootTables = {
  ...catalogLevelTables,
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
