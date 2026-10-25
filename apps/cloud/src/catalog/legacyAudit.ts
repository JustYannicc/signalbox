import { NonNegativeInt } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { Folder } from "@t3tools/contracts/signalboxFolders";
import type { SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import * as Schema from "effect/Schema";

import { parseDriveId } from "../drive/driveAccess.ts";
import { CatalogHome, CatalogPersonId, catalogHomeKey } from "./catalogHome.ts";

const Count = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));

export const LegacyCatalogAuditResultSchema = Schema.Struct({
  sourceSnapshots: Count,
  orgCopies: Count,
  logicalOrgLevels: Count,
  duplicateOrgLevels: Count,
  divergentOrgLevels: Count,
  divergentFields: Schema.Struct({
    name: Count,
    parentId: Count,
    position: Count,
    instructions: Count,
    secrets: Count,
    phase: Count,
    files: Count,
    poolId: Count,
    githubLend: Count,
  }),
  ambiguousTopConfigurations: Count,
  privateThreadPlacements: Count,
});
export type LegacyCatalogAuditResult = typeof LegacyCatalogAuditResultSchema.Type;
const decodeResult = Schema.decodeSync(LegacyCatalogAuditResultSchema);

/** Server-side input only. `privateThreadCount` comes from the trusted importer. */
export interface LegacyCatalogAuditSource {
  readonly personId: string;
  readonly folders: SignalboxFoldersSnapshot;
  readonly privateThreadCount: number;
}

const DIVERGENT_FIELDS = [
  "name",
  "parentId",
  "position",
  "instructions",
  "secrets",
  "phase",
  "files",
  "poolId",
  "githubLend",
] as const satisfies ReadonlyArray<keyof Folder>;
const isPersonId = Schema.is(CatalogPersonId);
const isHome = Schema.is(CatalogHome);

type DivergentField = (typeof DIVERGENT_FIELDS)[number];

const invalidCount = () =>
  new Error("Legacy catalog audit count must be a non-negative safe integer.");

const add = (left: number, right: number) => {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw invalidCount();
  return total;
};

const fieldEquivalences = new Map(
  DIVERGENT_FIELDS.map(
    (field) =>
      [
        field,
        Schema.toEquivalence<Folder[DivergentField]>(Schema.UndefinedOr(Folder.fields[field])),
      ] as const,
  ),
);

const ownerContextsOf = (snapshot: SignalboxFoldersSnapshot) => {
  // Personal exists even when the source has no Personal folders.
  const owners = new Set<string>([PERSONAL_CONTEXT_ID]);
  for (const folder of snapshot.folders) owners.add(folder.ownerId);
  for (const { projectId } of snapshot.projectHomes) {
    if (projectId.startsWith("context:")) {
      const ownerId = projectId.slice("context:".length);
      if (ownerId !== "") owners.add(ownerId);
    } else if (projectId.startsWith("drive:")) {
      const drive = parseDriveId(projectId.slice("drive:".length));
      if (drive !== null) owners.add(drive.contextId);
    }
  }
  return owners;
};

/**
 * Counts legacy conflicts without returning source identifiers or values.
 * Keep this behind a trusted importer or maintainer path: numeric aggregates
 * still reveal cross-user state.
 */
export const auditLegacyCatalogSources = (
  sources: ReadonlyArray<LegacyCatalogAuditSource>,
): LegacyCatalogAuditResult => {
  const people = new Set<string>();
  const levels = new Map<string, Array<{ readonly personId: string; readonly folder: Folder }>>();
  let orgCopies = 0;
  let ambiguousTopConfigurations = 0;
  let privateThreadPlacements = 0;

  for (const source of sources) {
    if (!isPersonId(source.personId)) {
      throw new Error("Legacy catalog audit source identity must be a canonical person ID.");
    }
    if (people.has(source.personId)) {
      throw new Error("Duplicate legacy catalog audit source identity.");
    }
    people.add(source.personId);
    if (!Number.isSafeInteger(source.privateThreadCount) || source.privateThreadCount < 0) {
      throw invalidCount();
    }
    privateThreadPlacements = add(privateThreadPlacements, source.privateThreadCount);

    const topConfigured =
      source.folders.top.instructions !== undefined ||
      source.folders.top.secrets !== undefined ||
      source.folders.pools.top !== null;
    if (topConfigured && ownerContextsOf(source.folders).size > 1) {
      ambiguousTopConfigurations = add(ambiguousTopConfigurations, 1);
    }

    for (const folder of source.folders.folders) {
      if (folder.ownerId === PERSONAL_CONTEXT_ID) continue;
      orgCopies = add(orgCopies, 1);
      const home = {
        owner: { _tag: "organization", id: folder.ownerId },
        level: { _tag: "folder", id: folder.id },
      } as const;
      if (!isHome(home)) {
        throw new Error("Legacy catalog audit folder identity must be canonical.");
      }
      const key = catalogHomeKey(home);
      const copies = levels.get(key) ?? [];
      if (copies.some((copy) => copy.personId === source.personId)) {
        throw new Error("Duplicate organization folder in legacy catalog source.");
      }
      copies.push({ personId: source.personId, folder });
      levels.set(key, copies);
    }
  }

  const fieldCounts: Record<DivergentField, number> = {
    name: 0,
    parentId: 0,
    position: 0,
    instructions: 0,
    secrets: 0,
    phase: 0,
    files: 0,
    poolId: 0,
    githubLend: 0,
  };
  let duplicateOrgLevels = 0;
  let divergentOrgLevels = 0;

  for (const copies of levels.values()) {
    if (copies.length < 2) continue;
    const [first, ...others] = copies;
    if (first === undefined) continue;
    duplicateOrgLevels = add(duplicateOrgLevels, 1);
    let divergent = false;
    for (const [field, equivalent] of fieldEquivalences) {
      if (others.every(({ folder }) => equivalent(first.folder[field], folder[field]))) continue;
      fieldCounts[field] = add(fieldCounts[field], 1);
      divergent = true;
    }
    if (divergent) divergentOrgLevels = add(divergentOrgLevels, 1);
  }

  return decodeResult({
    sourceSnapshots: sources.length,
    orgCopies,
    logicalOrgLevels: levels.size,
    duplicateOrgLevels,
    divergentOrgLevels,
    divergentFields: fieldCounts,
    ambiguousTopConfigurations,
    privateThreadPlacements,
  });
};
