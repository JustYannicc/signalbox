import { expect } from "@effect/vitest";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { catalogRootTables } from "../catalogHomeTables.ts";
import { CatalogPolicyFailure, type CatalogPolicyTarget } from "../catalogPolicy.ts";

const decodeFolder = Schema.decodeUnknownSync(catalogRootTables.folders.row);
export const top = { folderId: null, incarnation: 1 };
export const before = { folderId: FolderId.make("before"), incarnation: 1 };
export const after = { folderId: FolderId.make("after"), incarnation: 2 };
export const target = { folderId: FolderId.make("moving"), incarnation: 3 };
export const nested = { folderId: FolderId.make("nested"), incarnation: 4 };
export const folder = (id: string, extra = {}) =>
  decodeFolder({
    id,
    parentId: null,
    parentIncarnation: 1,
    incarnation: 1,
    name: id,
    position: 0,
    state: "active",
    ...extra,
  });
export const folders = [
  folder("before"),
  folder("after", { incarnation: 2 }),
  folder("moving", { incarnation: 3, parentId: "before" }),
  folder("nested", { incarnation: 4, parentId: "moving", parentIncarnation: 3 }),
];
export const grant = (
  scope: CatalogPolicyTarget,
  personId: string,
  role: "Admin" | "Member" | "Viewer",
) => ({ ...scope, personId, role });
export const denied = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => expect(error).toEqual(new CatalogPolicyFailure({ reason: "denied" }))),
  );
