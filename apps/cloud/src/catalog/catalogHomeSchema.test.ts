import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { catalogHomeKey, legacyCatalogHome } from "./catalogHome.ts";
import {
  CatalogLevelRef,
  CatalogRootHome,
  CatalogRootState,
  catalogRootHome,
} from "./catalogHomeSchema.ts";
import { catalogFolderTables, catalogRootTables } from "./catalogHomeTables.ts";

const ORG = SignalboxContextId.make("org_one");
const sourceFolder = (personId: string) =>
  legacyCatalogHome({ personId, contextId: ORG, folderId: FolderId.make("same-folder") });

describe("catalog home schema", () => {
  it("routes legacy folders only to their own source-qualified root", () => {
    const first = catalogRootHome(sourceFolder("person_one"));
    const second = catalogRootHome(sourceFolder("person_two"));
    const canonical = catalogRootHome({
      owner: first.owner,
      level: { _tag: "folder", id: FolderId.make("same-folder") },
    });

    expect(first).toEqual({
      owner: { _tag: "organization", id: ORG },
      level: { _tag: "top" },
      legacySource: "person_one",
    });
    expect(new Set([first, second, canonical].map(catalogHomeKey)).size).toBe(3);
    const personal = legacyCatalogHome({
      personId: "person_one",
      contextId: PERSONAL_CONTEXT_ID,
      folderId: FolderId.make("same-folder"),
    });
    expect(catalogRootHome(personal)).toEqual({ ...personal, level: { _tag: "top" } });
  });

  it("rejects child homes as root authority and unsafe lifecycle fences", () => {
    const decodeRootHome = Schema.decodeUnknownSync(CatalogRootHome);
    const decodeRoot = Schema.decodeUnknownSync(CatalogRootState);
    const decodeLevel = Schema.decodeUnknownSync(CatalogLevelRef);
    const child = sourceFolder("person_one");
    expect(() => decodeRootHome(child)).toThrow();
    for (const incarnation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decodeLevel({ home: child, incarnation })).toThrow();
    }
    for (const authEpoch of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        decodeRoot({
          key: "root",
          topologyRevision: 0,
          authEpoch,
        }),
      ).toThrow();
    }
  });

  it("requires root and child storage rows to match their table authority", () => {
    const decodeRoot = Schema.decodeUnknownSync(catalogRootTables.state.row);
    const decodeChild = Schema.decodeUnknownSync(catalogFolderTables.state.row);
    const child = sourceFolder("person_one");
    const rootRow = {
      key: "state",
      level: { home: catalogRootHome(child), incarnation: 1 },
      revision: 0,
      storageState: "open",
    };
    const childRow = { ...rootRow, level: { home: child, incarnation: 1 } };

    expect(decodeRoot(rootRow)).toEqual(rootRow);
    expect(decodeChild(childRow)).toEqual(childRow);
    expect(() => decodeRoot(childRow)).toThrow();
    expect(() => decodeChild(rootRow)).toThrow();
  });

  it("keeps grantable roles separate from ownership and rejects identity normalization", () => {
    const decodeGrant = Schema.decodeUnknownSync(catalogRootTables.grants.row);
    expect(
      decodeGrant({ folderId: null, incarnation: 1, personId: "person_one", role: "Admin" }),
    ).toEqual({
      folderId: null,
      incarnation: 1,
      personId: "person_one",
      role: "Admin",
    });
    for (const invalid of [
      { folderId: null, incarnation: 1, personId: "person_one", role: "Owner" },
      { folderId: " padded-folder", incarnation: 1, personId: "person_one", role: "Member" },
      { folderId: null, incarnation: 1, personId: " person_one", role: "Viewer" },
      { folderId: null, incarnation: 0, personId: "person_one", role: "Viewer" },
    ])
      expect(() => decodeGrant(invalid)).toThrow();

    const decodeFolder = Schema.decodeUnknownSync(catalogRootTables.folders.row);
    expect(() =>
      decodeFolder({
        id: "folder",
        parentId: null,
        parentIncarnation: 1,
        incarnation: 1,
        name: " Padded name ",
        position: 0,
        state: "active",
      }),
    ).toThrow();
    expect(() =>
      decodeFolder({
        id: "self",
        parentId: "self",
        parentIncarnation: 1,
        incarnation: 1,
        name: "Folder",
        position: 0,
        state: "active",
      }),
    ).toThrow();
  });
});
