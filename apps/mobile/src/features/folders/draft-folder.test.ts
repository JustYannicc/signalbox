import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";

import { restoredDraftFolderStart } from "./restored-draft-folder";
import { folderStart } from "./folder-filter";
import {
  ACME,
  ACME_FILES,
  ENVIRONMENT,
  PERSONAL_FILES,
  owners,
  snapshot,
} from "./folder-fixtures.test-support";

describe("restored draft folder starts", () => {
  it("restores a shared-file folder's filing target", () => {
    const start = folderStart(snapshot, owners, ENVIRONMENT, {
      _tag: "folder",
      folderId: FolderId.make("clients"),
    });
    expect(start).not.toBeNull();

    const target = restoredDraftFolderStart(
      {
        environmentId: ENVIRONMENT,
        projectId: PERSONAL_FILES,
        createdAt: "2026-10-18T00:00:00.000Z",
        folderStart: {
          folderId: start!.folderId,
          name: start!.name,
          file: start!.file,
          unfiledName: start!.unfiledName,
        },
      },
      { environmentId: ENVIRONMENT, id: PERSONAL_FILES },
    );

    expect(target).toEqual(start);
    expect(target).toMatchObject({ folderId: FolderId.make("clients"), file: true });
  });

  it("keeps an explicit owner top level distinct from no saved folder", () => {
    const start = folderStart(snapshot, owners, ENVIRONMENT, { _tag: "top", ownerId: ACME });
    expect(start).not.toBeNull();

    const stamp = {
      environmentId: ENVIRONMENT,
      projectId: ACME_FILES,
      createdAt: "2026-10-18T00:00:00.000Z",
      folderStart: {
        folderId: null,
        name: start!.name,
        file: start!.file,
        unfiledName: start!.unfiledName,
      },
    };
    expect(restoredDraftFolderStart(stamp, { environmentId: ENVIRONMENT, id: ACME_FILES })).toEqual(
      start,
    );
    expect(
      restoredDraftFolderStart(
        { ...stamp, folderStart: null },
        { environmentId: ENVIRONMENT, id: ACME_FILES },
      ),
    ).toBeNull();
  });

  it("does not restore a folder when its stamped environment or project is no longer selected", () => {
    const stamp = {
      environmentId: ENVIRONMENT,
      projectId: PERSONAL_FILES,
      createdAt: "2026-10-18T00:00:00.000Z",
      folderStart: {
        folderId: FolderId.make("clients"),
        name: "Clients",
        file: true,
        unfiledName: "Personal top level",
      },
    };

    expect(
      restoredDraftFolderStart(stamp, {
        environmentId: EnvironmentId.make("other-environment"),
        id: PERSONAL_FILES,
      }),
    ).toBeNull();
    expect(
      restoredDraftFolderStart(stamp, {
        environmentId: ENVIRONMENT,
        id: ProjectId.make("other-project"),
      }),
    ).toBeNull();
  });
});
