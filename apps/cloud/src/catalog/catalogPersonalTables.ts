import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { table } from "@signalbox/sync/table";
import * as Schema from "effect/Schema";

import type { CatalogHome } from "./catalogHome.ts";
import { CatalogLevelRef } from "./catalogHomeSchema.ts";
import { catalogRootTables } from "./catalogHomeTables.ts";

type LevelRef = typeof CatalogLevelRef.Type;
type OrganizationTopRef = LevelRef & {
  readonly home: CatalogHome & {
    readonly owner: Extract<CatalogHome["owner"], { readonly _tag: "organization" }>;
    readonly level: Extract<CatalogHome["level"], { readonly _tag: "top" }>;
  };
};
type PersonalLevelRef = LevelRef & {
  readonly home: CatalogHome & {
    readonly owner: Extract<CatalogHome["owner"], { readonly _tag: "person" }>;
  };
};

/** An organization's canonical top; legacy per-user copies are never a reference target (#871). */
export const CatalogOrganizationTopRef = CatalogLevelRef.pipe(
  Schema.refine(
    (ref): ref is OrganizationTopRef =>
      ref.home.owner._tag === "organization" &&
      ref.home.level._tag === "top" &&
      ref.home.legacySource === undefined,
    { identifier: "CatalogOrganizationTopRef" },
  ),
);

/** A level in some person's canonical tree; operations still prove it is the bound owner's. */
export const CatalogPersonalLevelRef = CatalogLevelRef.pipe(
  Schema.refine(
    (ref): ref is PersonalLevelRef =>
      ref.home.owner._tag === "person" && ref.home.legacySource === undefined,
    { identifier: "CatalogPersonalLevelRef" },
  ),
);

/**
 * Where an organization's top is filed in one member's personal tree. Filing only: it grants
 * nothing, and it outlives membership so a rejoin restores the chosen placement.
 */
export const CatalogOrganizationReferenceRow = Schema.Struct({
  organizationId: Schema.toType(SignalboxContextId),
  // The personal root incarnation the reference was projected into; any other is corrupt.
  incarnation: CatalogLevelRef.fields.incarnation,
  target: CatalogOrganizationTopRef,
  filedUnder: CatalogPersonalLevelRef,
}).check(Schema.makeFilter((row) => row.target.home.owner.id === row.organizationId));

/** The personal root's own topology and grants, plus where member organizations are filed. */
export const catalogPersonalTables = {
  ...catalogRootTables,
  organizationReferences: table({
    row: CatalogOrganizationReferenceRow,
    key: ["organizationId"],
    indexes: { byIncarnation: { fields: ["incarnation", "organizationId"] } },
  }),
};
