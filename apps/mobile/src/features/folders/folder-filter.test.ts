import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";

import {
  folderFilterKey,
  folderLevelName,
  folderResidency,
  folderResidentCounts,
  folderStart,
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

describe("folder filter keys", () => {
  it("round-trips a folder and an owner's top level, ids with colons included", () => {
    const folder = { _tag: "folder", folderId: FolderId.make("a:b") } as const;
    const top = { _tag: "top", ownerId: "org:1" } as const;
    expect(parseFolderFilterKey(folderFilterKey(ENVIRONMENT, folder))).toEqual({
      environmentId: ENVIRONMENT,
      level: folder,
    });
    expect(parseFolderFilterKey(folderFilterKey(ENVIRONMENT, top))).toEqual({
      environmentId: ENVIRONMENT,
      level: top,
    });
  });

  it("leaves other filter keys alone", () => {
    expect(parseFolderFilterKey("section-project:cloud:p")).toBeNull();
    expect(parseFolderFilterKey(null)).toBeNull();
    expect(parseFolderFilterKey("folder:cloud:elsewhere:x")).toBeNull();
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
  const residency = folderResidency(snapshot, owners);

  it("shows a thread only in its home, not in the folders above it", () => {
    const filed = thread("filed", PERSONAL_FILES);
    expect(residency.isAt({ _tag: "folder", folderId: FolderId.make("clients") }, filed)).toBe(
      true,
    );
    expect(residency.isAt({ _tag: "folder", folderId: FolderId.make("work") }, filed)).toBe(false);
    expect(residency.isAt({ _tag: "top", ownerId: PERSONAL }, filed)).toBe(false);
  });

  it("puts a thread in its project's folder unless it was filed elsewhere", () => {
    const inDrive = thread("plain", DRIVE);
    expect(residency.isAt({ _tag: "folder", folderId: FolderId.make("northwind") }, inDrive)).toBe(
      true,
    );
    const filedToTop = thread("unfiled", DRIVE);
    expect(residency.isAt({ _tag: "top", ownerId: PERSONAL }, filedToTop)).toBe(true);
  });

  it("keeps each owner's top level to its own threads, drafts included", () => {
    const acmeDraft = { projectId: ACME_FILES };
    expect(residency.isAt({ _tag: "top", ownerId: ACME }, acmeDraft)).toBe(true);
    expect(residency.isAt({ _tag: "top", ownerId: PERSONAL }, acmeDraft)).toBe(false);
  });

  it("counts the threads that live right at each level", () => {
    const counts = folderResidentCounts(snapshot, owners, [
      thread("filed", PERSONAL_FILES),
      thread("a", PERSONAL_FILES),
      thread("b", PERSONAL_FILES),
      thread("c", DRIVE),
      thread("d", ACME_FILES),
      thread("e", ProjectId.make("nobody")),
    ]);
    expect(Object.fromEntries(counts.folders)).toEqual({ clients: 1, northwind: 1 });
    expect(Object.fromEntries(counts.top)).toEqual({ personal: 2, org_acme: 1 });
  });

  it("names a folder by its name and a top level by its owner", () => {
    expect(folderLevelName(snapshot, owners, { _tag: "top", ownerId: ACME })).toBe("Acme");
    expect(
      folderLevelName(snapshot, owners, { _tag: "folder", folderId: FolderId.make("work") }),
    ).toBe("Work");
    expect(
      folderLevelName(snapshot, owners, { _tag: "folder", folderId: FolderId.make("gone") }),
    ).toBeNull();
  });
});

describe("starting a task in a folder", () => {
  it("works in the folder's files, where its threads already live", () => {
    expect(
      folderStart(snapshot, owners, ENVIRONMENT, {
        _tag: "folder",
        folderId: FolderId.make("northwind"),
      }),
    ).toEqual({
      environmentId: ENVIRONMENT,
      folderId: "northwind",
      name: "Northwind",
      projectId: DRIVE,
      file: false,
    });
  });

  it("works in the owner's own files and is filed in a folder without files", () => {
    expect(
      folderStart(snapshot, owners, ENVIRONMENT, {
        _tag: "folder",
        folderId: FolderId.make("ops"),
      }),
    ).toMatchObject({ name: "Ops", projectId: ACME_FILES, file: true });
  });

  it("starts at an owner's top level in its own files", () => {
    expect(folderStart(snapshot, owners, ENVIRONMENT, { _tag: "top", ownerId: PERSONAL })).toEqual({
      environmentId: ENVIRONMENT,
      folderId: null,
      name: "Personal",
      projectId: PERSONAL_FILES,
      file: false,
    });
  });

  it("waits until the owner and the folder are known", () => {
    expect(folderStart(snapshot, null, ENVIRONMENT, { _tag: "top", ownerId: PERSONAL })).toBeNull();
    expect(
      folderStart(snapshot, owners, ENVIRONMENT, { _tag: "folder", folderId: FolderId.make("x") }),
    ).toBeNull();
  });
});
