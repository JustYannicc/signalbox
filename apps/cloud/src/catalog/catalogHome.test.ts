import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";

import { catalogHomeFromKey, catalogHomeKey, legacyCatalogHome } from "./catalogHome.ts";

const ORG = SignalboxContextId.make("org_1");

describe("catalog home identity", () => {
  it("keeps each person's legacy Personal top separate", () => {
    const first = legacyCatalogHome({
      personId: "person_1",
      contextId: PERSONAL_CONTEXT_ID,
      folderId: null,
    });
    const second = legacyCatalogHome({
      personId: "person_2",
      contextId: PERSONAL_CONTEXT_ID,
      folderId: null,
    });

    expect(first.owner).toEqual({ _tag: "person", id: "person_1" });
    expect(second.owner).toEqual({ _tag: "person", id: "person_2" });
    expect(catalogHomeKey(first)).not.toBe(catalogHomeKey(second));
  });

  it("preserves separate private org copies even when a drive gave them the same folder ID", () => {
    const folderId = FolderId.make("drive:shared/org_1/drive_1");
    const first = legacyCatalogHome({ personId: "person_1", contextId: ORG, folderId });
    const second = legacyCatalogHome({ personId: "person_2", contextId: ORG, folderId });
    const canonical = { owner: first.owner, level: first.level };

    expect(first.owner).toEqual(second.owner);
    expect(first.level).toEqual(second.level);
    expect(new Set([first, second, canonical].map(catalogHomeKey)).size).toBe(3);
    expect(catalogHomeFromKey(catalogHomeKey(first))).toEqual(first);
  });

  it("distinguishes owner kinds, roots and arbitrary delimiter characters", () => {
    const homes = [
      { owner: { _tag: "person", id: "same" }, level: { _tag: "top" } },
      {
        owner: { _tag: "organization", id: SignalboxContextId.make("same") },
        level: { _tag: "top" },
      },
      {
        owner: { _tag: "person", id: "same" },
        level: { _tag: "folder", id: FolderId.make("top") },
      },
      legacyCatalogHome({ personId: 'a/"b', contextId: ORG, folderId: FolderId.make('c/"d') }),
      legacyCatalogHome({ personId: "a", contextId: ORG, folderId: FolderId.make('b/c/"d') }),
    ] as const;

    expect(new Set(homes.map(catalogHomeKey)).size).toBe(homes.length);
    for (const home of homes) expect(catalogHomeFromKey(catalogHomeKey(home))).toEqual(home);
  });

  it("rejects malformed or unknown-version identities instead of routing them elsewhere", () => {
    for (const key of [
      "personal",
      '["catalog",2,"person","person_1",null,null]',
      '["catalog",1,"person","",null,null]',
      '["search",1,"person","person_1",null,null]',
      '["catalog",1,"organization","personal",null,null]',
      '["catalog",1,"person","person_1","person_2",null]',
    ]) {
      expect(() => catalogHomeFromKey(key)).toThrow();
    }

    expect(() =>
      catalogHomeKey({
        owner: { _tag: "organization", id: PERSONAL_CONTEXT_ID },
        level: { _tag: "top" },
      }),
    ).toThrow();
    expect(() =>
      catalogHomeKey({
        owner: { _tag: "person", id: "person_1" },
        level: { _tag: "top" },
        legacySource: "person_2",
      }),
    ).toThrow();
  });
});
