import { NonNegativeInt } from "@t3tools/contracts";
import { Folder, FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Schema from "effect/Schema";

import { CatalogHome, CatalogPersonId } from "./catalogHome.ts";

const Revision = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Incarnation = Revision.check(Schema.isGreaterThan(0));
const LevelId = Schema.toType(FolderId).check(Schema.isTrimmed());

export const CatalogRole = Schema.Literals(["Owner", "Admin", "Member", "Viewer"]);

export const CatalogLevelRef = Schema.Struct({ home: CatalogHome, incarnation: Incarnation });

export const CatalogRootHome = CatalogHome.check(
  Schema.makeFilter((home) => home.level._tag === "top"),
);

const decodeHome = Schema.decodeUnknownSync(CatalogHome);
const decodeRootHome = Schema.decodeUnknownSync(CatalogRootHome);

/** Routing to the root must preserve a legacy source's private namespace. */
export const catalogRootHome = (input: CatalogHome) => {
  const home = decodeHome(input);
  return decodeRootHome({ ...home, level: { _tag: "top" } });
};

export const CatalogHomeState = Schema.Struct({
  key: Schema.Literal("state"),
  level: CatalogLevelRef,
  revision: Revision,
  // Local storage retirement never substitutes for the root's access policy.
  storageState: Schema.Literals(["open", "retired"]),
});

export const CatalogRootState = Schema.Struct({
  key: Schema.Literal("root"),
  topologyRevision: Revision,
  authEpoch: Revision,
});

// Folder IDs and grants are local to the bound root, including its legacy source.
export const CatalogFolderRow = Schema.Struct({
  id: LevelId,
  parentId: Schema.NullOr(LevelId),
  // Recreating a parent must not adopt children from its previous incarnation.
  parentIncarnation: Incarnation,
  incarnation: Incarnation,
  name: Folder.fields.name,
  position: Revision,
  state: Schema.Literals(["active", "deleted"]),
}).check(Schema.makeFilter((folder) => folder.parentId !== folder.id));

export const CatalogGrantRow = Schema.Struct({
  folderId: Schema.NullOr(LevelId),
  incarnation: Incarnation,
  personId: CatalogPersonId,
  // Owner follows the tree's owner; an Admin cannot grant ownership.
  role: Schema.Literals(["Admin", "Member", "Viewer"]),
});
