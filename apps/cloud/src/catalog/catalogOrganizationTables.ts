import { NonNegativeInt } from "@t3tools/contracts";
import { table } from "@signalbox/sync/table";
import * as Schema from "effect/Schema";

import { CatalogPersonId } from "./catalogHome.ts";
import { catalogRootTables } from "./catalogHomeTables.ts";

const PositiveRevision = NonNegativeInt.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
// WorkOS role slugs; custom slugs are kept verbatim even though only built-ins map to roles.
export const CatalogRoleSlug = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const CatalogRoleSlugs = Schema.Array(CatalogRoleSlug).check(Schema.isMaxLength(64));

/** Sorted and deduplicated, so equal role sets compare equal across deliveries. */
export const normalizeRoleSlugs = (slugs: ReadonlyArray<string>) =>
  [...new Set(slugs)].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const isNormalized = (slugs: ReadonlyArray<string>) =>
  slugs.every((slug, at) => at === 0 || (slugs[at - 1] ?? "") < slug);

export const CatalogMembershipRow = Schema.Struct({
  personId: CatalogPersonId,
  // The root incarnation the membership was projected into; any other is corrupt.
  incarnation: PositiveRevision,
  // Removal keeps its revision so a late older delivery cannot resurrect the member.
  sourceRevision: PositiveRevision,
  roleSlugs: Schema.NullOr(CatalogRoleSlugs.check(Schema.makeFilter(isNormalized))),
});

/** The root's own topology and grants, plus its projection of the organization's membership. */
export const catalogOrganizationTables = {
  ...catalogRootTables,
  memberships: table({
    row: CatalogMembershipRow,
    key: ["personId"],
    // Lets bootstrap prove the root holds no membership it would otherwise adopt.
    indexes: { byIncarnation: { fields: ["incarnation", "personId"] } },
  }),
};
