import { describe, expect, it } from "@effect/vitest";
import {
  CatalogHome,
  CatalogLevelRef,
  CatalogOwner,
  CatalogPersonId,
  CatalogRootHome,
  catalogHomeFromKey,
  catalogHomeKey,
  catalogRootHome,
  legacyCatalogHome,
} from "@t3tools/contracts/signalboxCatalog";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Schema from "effect/Schema";

const ORG = SignalboxContextId.make("org_1");
const decodePersonId = Schema.decodeUnknownSync(CatalogPersonId);
const decodeOwner = Schema.decodeUnknownSync(CatalogOwner);
const decodeHome = Schema.decodeUnknownSync(CatalogHome);
const decodeLevel = Schema.decodeUnknownSync(CatalogLevelRef);
const decodeRootHome = Schema.decodeUnknownSync(CatalogRootHome);

describe("catalog home identity contract", () => {
  it("keeps canonical key bytes stable, including escaped delimiters", () => {
    expect(
      catalogHomeKey({ owner: { _tag: "person", id: "person_1" }, level: { _tag: "top" } }),
    ).toBe('["catalog",1,"person","person_1",null,null]');
    expect(
      catalogHomeKey(
        legacyCatalogHome({ personId: 'a/"b', contextId: ORG, folderId: FolderId.make('c/"d') }),
      ),
    ).toBe('["catalog",1,"organization","org_1","a/\\"b","c/\\"d"]');
    expect(catalogHomeFromKey('["catalog",1,"organization","org_1","a/\\"b","c/\\"d"]')).toEqual({
      owner: { _tag: "organization", id: ORG },
      level: { _tag: "folder", id: 'c/"d' },
      legacySource: 'a/"b',
    });
  });

  it("keeps legacy copies in private namespaces apart from the canonical home", () => {
    const folderId = FolderId.make("drive:shared/org_1/drive_1");
    const first = legacyCatalogHome({ personId: "person_1", contextId: ORG, folderId });
    const second = legacyCatalogHome({ personId: "person_2", contextId: ORG, folderId });
    const canonical = { owner: first.owner, level: first.level };
    const personal = legacyCatalogHome({
      personId: "person_1",
      contextId: PERSONAL_CONTEXT_ID,
      folderId: null,
    });

    expect(personal).toEqual({
      owner: { _tag: "person", id: "person_1" },
      level: { _tag: "top" },
      legacySource: "person_1",
    });
    const keys = [first, second, canonical, personal].map(catalogHomeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.map(catalogHomeFromKey)).toEqual([first, second, canonical, personal]);
  });

  it("rejects non-canonical, malformed or unknown-version keys", () => {
    for (const key of [
      "personal",
      '["catalog",2,"person","person_1",null,null]',
      '["search",1,"person","person_1",null,null]',
      '["catalog",1,"person","",null,null]',
      '["catalog",1,"organization","personal",null,null]',
      '["catalog",1,"person","person_1","person_2",null]',
      '["catalog", 1,"person","person_1",null,null]',
      '["catalog",1,"person"," person_1",null,null]',
      '["catalog",1,"person","person\\u005f1",null,null]',
    ]) {
      expect(() => catalogHomeFromKey(key)).toThrow();
    }
  });

  it("rejects padded, empty or oversized identities instead of normalizing them", () => {
    expect(decodePersonId("p".repeat(256))).toBe("p".repeat(256));
    for (const id of ["", " ", " person_1", "person_1 ", "p".repeat(257)]) {
      expect(() => decodePersonId(id)).toThrow();
    }
    expect(() =>
      legacyCatalogHome({
        personId: "person_1",
        contextId: SignalboxContextId.make(" org_1"),
        folderId: null,
      }),
    ).toThrow();
    expect(() =>
      legacyCatalogHome({
        personId: "person_1",
        contextId: ORG,
        folderId: FolderId.make("folder_1 "),
      }),
    ).toThrow();
  });

  it("keeps organizations out of Personal and persons on their own source", () => {
    expect(() => decodeOwner({ _tag: "organization", id: PERSONAL_CONTEXT_ID })).toThrow();
    expect(decodeOwner({ _tag: "person", id: PERSONAL_CONTEXT_ID })).toEqual({
      _tag: "person",
      id: PERSONAL_CONTEXT_ID,
    });
    expect(() =>
      decodeHome({
        owner: { _tag: "person", id: "person_1" },
        level: { _tag: "top" },
        legacySource: "person_2",
      }),
    ).toThrow();
    expect(
      decodeHome({
        owner: { _tag: "organization", id: ORG },
        level: { _tag: "top" },
        legacySource: "person_2",
      }).legacySource,
    ).toBe("person_2");
  });

  it("accepts only safe positive incarnations on level refs", () => {
    const home = legacyCatalogHome({ personId: "person_1", contextId: ORG, folderId: null });
    expect(decodeLevel({ home, incarnation: 1 }).incarnation).toBe(1);
    expect(decodeLevel({ home, incarnation: Number.MAX_SAFE_INTEGER }).incarnation).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const incarnation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decodeLevel({ home, incarnation })).toThrow();
    }
  });

  it("routes any home to its own top without dropping the legacy source", () => {
    const child = legacyCatalogHome({
      personId: "person_1",
      contextId: ORG,
      folderId: FolderId.make("folder_1"),
    });
    expect(() => decodeRootHome(child)).toThrow();
    const root = catalogRootHome(child);
    expect(root).toEqual({ ...child, level: { _tag: "top" } });
    expect(decodeRootHome(root)).toEqual(root);
    expect(catalogHomeKey(root)).not.toBe(
      catalogHomeKey({ owner: child.owner, level: { _tag: "top" } }),
    );
  });
});
