import { NonNegativeInt } from "@t3tools/contracts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import type { ReadContext, TransactionContext } from "@signalbox/sync/definition";
import * as Schema from "effect/Schema";

import { type CatalogHome, CatalogPersonId } from "./catalogHome.ts";
import { CatalogRootHome } from "./catalogHomeSchema.ts";
import type { catalogRootTables } from "./catalogHomeTables.ts";

export const CatalogPolicyActor = Schema.Struct({ userId: CatalogPersonId });
export const CatalogRole = Schema.Literals(["Owner", "Admin", "Member", "Viewer"]);
export type CatalogRole = typeof CatalogRole.Type;
export const CatalogGrantRole = Schema.Literals(["Admin", "Member", "Viewer"]);
const Incarnation = NonNegativeInt.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

export const CatalogPolicyTarget = Schema.Struct({
  folderId: Schema.NullOr(Schema.toType(FolderId).check(Schema.isTrimmed())),
  incarnation: Incarnation,
});
export type CatalogPolicyTarget = typeof CatalogPolicyTarget.Type;

type PersonalRoot = typeof CatalogRootHome.Type & {
  readonly owner: Extract<CatalogHome["owner"], { readonly _tag: "person" }>;
};

// Organization roots and activation of legacy copies need their own trusted authority.
export const CatalogPersonalRoot = CatalogRootHome.pipe(
  Schema.refine(
    (home): home is PersonalRoot => home.owner._tag === "person" && home.legacySource === undefined,
    { identifier: "CatalogPersonalRoot" },
  ),
);

export class CatalogPolicyFailure extends Schema.TaggedError<CatalogPolicyFailure>()(
  "CatalogPolicyFailure",
  { reason: Schema.Literals(["denied", "invalid_state"]) },
) {}

/** Shared root operations accept any root home whose authority supplies its own baseline. */
export type CatalogRootReadContext = ReadContext<
  typeof catalogRootTables,
  typeof CatalogPolicyActor.Type,
  typeof CatalogRootHome.Type
>;
export type CatalogRootWriteContext = TransactionContext<
  typeof catalogRootTables,
  typeof CatalogPolicyActor.Type,
  typeof CatalogRootHome.Type
>;

export type CatalogPolicyReadContext = ReadContext<
  typeof catalogRootTables,
  typeof CatalogPolicyActor.Type,
  typeof CatalogPersonalRoot.Type
>;
export type CatalogPolicyWriteContext = TransactionContext<
  typeof catalogRootTables,
  typeof CatalogPolicyActor.Type,
  typeof CatalogPersonalRoot.Type
>;
