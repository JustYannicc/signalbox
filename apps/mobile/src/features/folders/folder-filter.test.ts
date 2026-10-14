import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";

import {
  filterLevelName,
  folderFilterKey,
  folderPlacement,
  folderStart,
  isAtLevel,
  ownedResidents,
  parseFolderFilterKey,
  withFolderFilterOption,
} from "./folder-filter";
import {
  ACME,
  ACME_FILES,
  DRIVE,
  ENVIRONMENT,
  PERSONAL,
  PERSONAL_FILES,
  owners,
  snapshot,
} from "./folder-fixtures.test-support";

const thread = (id: string, projectId: ProjectId) => ({ id: ThreadId.make(id), projectId });
const inFolder = (id: string) => ({ _tag: "folder", folderId: FolderId.make(id) }) as const;
const top = (ownerId: SignalboxContextId) => ({ _tag: "top", ownerId }) as const;

describe("folder filter keys", () => {
  it("round-trips a folder and an owner's top level, ids with colons included", () => {
    const folder = inFolder("a:b");
    const owner = top(SignalboxContextId.make("org:1"));
    expect(parseFolderFilterKey(folderFilterKey(ENVIRONMENT, folder))).toEqual({
      environmentId: ENVIRONMENT,
      level: folder,
    });
    expect(parseFolderFilterKey(folderFilterKey(ENVIRONMENT, owner))).toEqual({
      environmentId: ENVIRONMENT,
      level: owner,
    });
  });

  it("leaves other filter keys and malformed ones alone", () => {
    expect(parseFolderFilterKey("section-project:cloud:p")).toBeNull();
    expect(parseFolderFilterKey(null)).toBeNull();
    expect(parseFolderFilterKey("folder:cloud:elsewhere:x")).toBeNull();
    expect(parseFolderFilterKey("folder::in:x")).toBeNull();
    expect(parseFolderFilterKey("folder:cloud:in:%20")).toBeNull();
  });

  it("keeps the shown folder among the filter choices exactly once", () => {
    const options = [{ key: "a", label: "A" }];
    expect(withFolderFilterOption(options, null)).toBe(options);
    expect(withFolderFilterOption(options, { key: "f", label: "Work" })).toEqual([
      { key: "a", label: "A" },
      { key: "f", label: "Work" },
    ]);
    expect(withFolderFilterOption(options, { key: "a", label: "A" })).toBe(options);
  });
});

describe("where threads live", () => {
  it("shows a thread only in its home, not in the folders above it", () => {
    const filed = thread("filed", PERSONAL_FILES);
    expect(isAtLevel(snapshot, owners, inFolder("clients"), filed)).toBe(true);
    expect(isAtLevel(snapshot, owners, inFolder("work"), filed)).toBe(false);
    expect(isAtLevel(snapshot, owners, top(PERSONAL), filed)).toBe(false);
  });

  it("puts a thread in its project's folder unless it was filed elsewhere", () => {
    expect(isAtLevel(snapshot, owners, inFolder("northwind"), thread("plain", DRIVE))).toBe(true);
    expect(isAtLevel(snapshot, owners, top(PERSONAL), thread("unfiled", DRIVE))).toBe(true);
  });

  it("keeps each owner's top level to its own threads, drafts included", () => {
    const acmeDraft = { projectId: ACME_FILES };
    expect(isAtLevel(snapshot, owners, top(ACME), acmeDraft)).toBe(true);
    expect(isAtLevel(snapshot, owners, top(PERSONAL), acmeDraft)).toBe(false);
  });

  it("says whose a thread is and where it lives", () => {
    expect(folderPlacement(snapshot, owners, thread("filed", PERSONAL_FILES))).toEqual({
      ownerId: PERSONAL,
      home: "clients",
    });
    expect(folderPlacement(snapshot, owners, thread("x", ProjectId.make("nobody")))).toBeNull();
  });

  it("counts only the owners' threads", () => {
    const residents = [thread("a", PERSONAL_FILES), thread("b", ProjectId.make("nobody"))];
    expect(ownedResidents(owners, residents)).toEqual([residents[0]]);
  });

  it("names a folder by its name and a top level by its owner", () => {
    expect(filterLevelName(snapshot, owners, top(ACME))).toBe("Acme");
    expect(filterLevelName(snapshot, owners, inFolder("work"))).toBe("Work");
    expect(filterLevelName(snapshot, owners, inFolder("gone"))).toBeNull();
  });
});

describe("starting a task in a folder", () => {
  it("works in the folder's files, where its threads already live", () => {
    expect(folderStart(snapshot, owners, ENVIRONMENT, inFolder("northwind"))).toEqual({
      environmentId: ENVIRONMENT,
      folderId: "northwind",
      name: "Northwind",
      projectId: DRIVE,
      file: false,
      unfiledName: "Northwind",
    });
  });

  it("works in the owner's own files and is filed in a folder without files", () => {
    expect(folderStart(snapshot, owners, ENVIRONMENT, inFolder("ops"))).toMatchObject({
      name: "Ops",
      projectId: ACME_FILES,
      file: true,
      unfiledName: "the top level of Acme",
    });
  });

  it("starts at an owner's top level in its own files", () => {
    expect(folderStart(snapshot, owners, ENVIRONMENT, top(PERSONAL))).toMatchObject({
      folderId: null,
      name: "Personal",
      projectId: PERSONAL_FILES,
      file: false,
    });
  });

  it("waits until the owner and the folder are known", () => {
    expect(folderStart(snapshot, null, ENVIRONMENT, top(PERSONAL))).toBeNull();
    expect(folderStart(snapshot, owners, ENVIRONMENT, inFolder("x"))).toBeNull();
  });
});
