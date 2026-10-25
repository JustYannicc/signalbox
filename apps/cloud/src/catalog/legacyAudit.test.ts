import { ProjectId } from "@t3tools/contracts";
import { AccountPoolId } from "@t3tools/contracts/accountHub";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import {
  FolderId,
  OnePasswordEnvironmentId,
  SignalboxFoldersSnapshot,
  type Folder,
} from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { auditLegacyCatalogSources, type LegacyCatalogAuditSource } from "./legacyAudit.ts";

const ORG = SignalboxContextId.make("org_acme");
const decodeSnapshot = Schema.decodeUnknownSync(SignalboxFoldersSnapshot);

const folder = (id: string, ownerId: SignalboxContextId, fields: Partial<Folder> = {}): Folder => ({
  id: FolderId.make(id),
  name: id,
  parentId: null,
  position: 0,
  ownerId,
  ...fields,
});

const snapshot = (input: {
  readonly folders?: ReadonlyArray<Folder>;
  readonly instructions?: string;
  readonly projectHomes?: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly folderId: FolderId | null;
  }>;
  readonly topPool?: string;
  readonly revision?: number;
}) =>
  decodeSnapshot({
    revision: input.revision ?? 1,
    top: input.instructions === undefined ? {} : { instructions: input.instructions },
    folders: input.folders ?? [],
    threadHomes: [],
    projectHomes: input.projectHomes ?? [],
    pools: {
      top:
        input.topPool === undefined
          ? null
          : { poolId: AccountPoolId.make(input.topPool), from: { _tag: "top" } },
      folders: [],
    },
  });

const ownerCopy = (
  personId: string,
  folders: ReturnType<typeof snapshot>,
  privateThreadCount: number,
): LegacyCatalogAuditSource => ({ personId, folders, privateThreadCount });

describe("legacy catalog shadow audit", () => {
  it("counts divergent organization copies by logical level and field, excluding Personal folders", () => {
    const sharedId = "drive:shared/org_acme/drive_1";
    const left = folder(sharedId, ORG, {
      name: "Private client name one",
      parentId: FolderId.make("parent-one"),
      position: 1,
      instructions: "Private instructions one",
      secrets: { environmentId: OnePasswordEnvironmentId.make("vault-one") },
      phase: { phases: ["Plan", "Ship"], current: "Plan" },
      files: { projectId: ProjectId.make("drive:shared/org_acme/files-one") },
      poolId: AccountPoolId.make("pool-one"),
      githubLend: { login: "private-login-one", lentAt: 1 },
    });
    const right = folder(sharedId, ORG, {
      name: "Private client name two",
      parentId: FolderId.make("parent-two"),
      position: 2,
      instructions: "Private instructions two",
      secrets: { environmentId: OnePasswordEnvironmentId.make("vault-two") },
      phase: { phases: ["Plan", "Ship"], current: "Ship" },
      files: { projectId: ProjectId.make("drive:shared/org_acme/files-two") },
      poolId: AccountPoolId.make("pool-two"),
      githubLend: { login: "private-login-two", lentAt: 2 },
    });
    const first = snapshot({
      folders: [folder("same-personal-id", PERSONAL_CONTEXT_ID), left],
      instructions: "Private top instructions",
      projectHomes: [{ projectId: ProjectId.make("context:org_acme"), folderId: null }],
      topPool: "top-pool",
    });
    const second = snapshot({
      folders: [folder("same-personal-id", PERSONAL_CONTEXT_ID), right, folder("unique", ORG)],
      instructions: "Another private top instruction",
      projectHomes: [{ projectId: ProjectId.make("context:org_acme"), folderId: null }],
      topPool: "another-top-pool",
    });

    const result = auditLegacyCatalogSources([
      ownerCopy("person-one", first, 3),
      ownerCopy("person-two", second, 4),
    ]);

    expect(result).toEqual({
      sourceSnapshots: 2,
      orgCopies: 3,
      logicalOrgLevels: 2,
      duplicateOrgLevels: 1,
      divergentOrgLevels: 1,
      divergentFields: {
        name: 1,
        parentId: 1,
        position: 1,
        instructions: 1,
        secrets: 1,
        phase: 1,
        files: 1,
        poolId: 1,
        githubLend: 1,
      },
      ambiguousTopConfigurations: 2,
      privateThreadPlacements: 7,
    });
    const encoded = JSON.stringify(result);
    for (const privateValue of [
      "Private client name one",
      "Private instructions two",
      "Private top instructions",
      "Another private top instruction",
      "vault-one",
      "top-pool",
      "private-login-two",
      "person-one",
    ]) {
      expect(encoded).not.toContain(privateValue);
    }
  });

  it("counts top ambiguity when an organization context has no folders", () => {
    const source = ownerCopy(
      "person-one",
      snapshot({
        instructions: "Private top instructions",
        projectHomes: [{ projectId: ProjectId.make("context:org_acme"), folderId: null }],
      }),
      0,
    );

    expect(auditLegacyCatalogSources([source]).ambiguousTopConfigurations).toBe(1);
  });

  it("compares nested copies structurally and counts one-sided optional fields", () => {
    const copy = () =>
      folder("shared", ORG, {
        secrets: { environmentId: OnePasswordEnvironmentId.make("vault-one") },
        phase: { phases: ["Plan", "Ship"], current: "Plan" },
        files: { projectId: ProjectId.make("drive:shared/org_acme/files-one") },
        githubLend: { login: "login-one", lentAt: 1 },
      });
    const sources = [
      ownerCopy("person-one", snapshot({ folders: [copy()] }), 0),
      ownerCopy("person-two", snapshot({ folders: [copy()] }), 0),
    ];

    const equal = auditLegacyCatalogSources(sources);
    expect(equal.duplicateOrgLevels).toBe(1);
    expect(equal.divergentOrgLevels).toBe(0);
    expect(Object.values(equal.divergentFields)).toEqual(Array(9).fill(0));

    const differing = auditLegacyCatalogSources([
      ...sources,
      ownerCopy(
        "person-three",
        snapshot({ folders: [{ ...copy(), instructions: "Only one source has this" }] }),
        0,
      ),
    ]);
    expect(differing.duplicateOrgLevels).toBe(1);
    expect(differing.divergentOrgLevels).toBe(1);
    expect(differing.divergentFields).toEqual({ ...equal.divergentFields, instructions: 1 });
  });

  it("keeps equal folder IDs in different organisations separate", () => {
    const result = auditLegacyCatalogSources([
      ownerCopy("person-one", snapshot({ folders: [folder("same", ORG)] }), 0),
      ownerCopy(
        "person-two",
        snapshot({ folders: [folder("same", SignalboxContextId.make("org_other"))] }),
        0,
      ),
    ]);
    expect(result.logicalOrgLevels).toBe(2);
    expect(result.duplicateOrgLevels).toBe(0);
  });

  it("does not count a configured Personal-only top as ambiguous", () => {
    const result = auditLegacyCatalogSources([
      ownerCopy("person-one", snapshot({ instructions: "Personal", topPool: "pool-one" }), 0),
    ]);
    expect(result.ambiguousTopConfigurations).toBe(0);
  });

  it("rejects noncanonical source identities with a fixed message", () => {
    for (const personId of ["", " ", " person-one", "person-one ", "x".repeat(257)]) {
      expect(() => auditLegacyCatalogSources([ownerCopy(personId, snapshot({}), 0)])).toThrow(
        "Legacy catalog audit source identity must be a canonical person ID.",
      );
    }
  });

  it("rejects noncanonical folder identities without normalizing or revealing them", () => {
    for (const invalid of [
      folder(" shared", ORG),
      folder("shared", SignalboxContextId.make(" org_acme")),
    ]) {
      const folders = { ...snapshot({}), folders: [invalid] };
      expect(() => auditLegacyCatalogSources([ownerCopy("person-one", folders, 0)])).toThrow(
        new Error("Legacy catalog audit folder identity must be canonical."),
      );
    }
  });

  it("rejects repeated source identities with a fixed message", () => {
    const source = ownerCopy("person-one", snapshot({}), 0);
    expect(() =>
      auditLegacyCatalogSources([source, { ...source, folders: snapshot({ revision: 2 }) }]),
    ).toThrow(new Error("Duplicate legacy catalog audit source identity."));
  });

  it("rejects thread counts outside the non-negative safe integer range", () => {
    for (const privateThreadCount of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        auditLegacyCatalogSources([ownerCopy("person-one", snapshot({}), privateThreadCount)]),
      ).toThrow("Legacy catalog audit count must be a non-negative safe integer.");
    }
  });
});
