import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AccountPoolId } from "@t3tools/contracts/accountHub";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type { SignalboxContextsSnapshot } from "@t3tools/contracts/signalboxContexts";
import {
  type Folder,
  FolderId,
  type SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";

export const ENVIRONMENT = EnvironmentId.make("cloud");
export const PERSONAL = SignalboxContextId.make("personal");
export const ACME = SignalboxContextId.make("org_acme");
export const PERSONAL_FILES = ProjectId.make("personal-files");
export const ACME_FILES = ProjectId.make("acme-files");
export const DRIVE = ProjectId.make("drive:northwind");

export const folder = (
  id: string,
  parentId: string | null,
  position = 0,
  extra: Partial<Folder> = {},
): Folder => ({
  id: FolderId.make(id),
  name: id[0]!.toUpperCase() + id.slice(1),
  parentId: parentId === null ? null : FolderId.make(parentId),
  position,
  ownerId: PERSONAL,
  ...extra,
});

/** Personal: Work › Clients › Northwind (with a drive), and Notes beside Work. Acme: Ops. */
export const snapshot: SignalboxFoldersSnapshot = {
  revision: 1,
  top: { instructions: "Be brief." },
  folders: [
    folder("notes", null, 1),
    folder("work", null, 0, { poolId: AccountPoolId.make("work") }),
    folder("clients", "work", 0),
    folder("northwind", "clients", 0, { files: { projectId: DRIVE } }),
    folder("ops", null, 0, { ownerId: ACME }),
  ],
  threadHomes: [
    { threadId: ThreadId.make("filed"), folderId: FolderId.make("clients") },
    { threadId: ThreadId.make("unfiled"), folderId: null },
  ],
  projectHomes: [{ projectId: DRIVE, folderId: FolderId.make("northwind") }],
  pools: {
    top: { poolId: AccountPoolId.make("personal"), from: { _tag: "top" } },
    folders: [
      {
        folderId: FolderId.make("work"),
        pool: {
          poolId: AccountPoolId.make("work"),
          from: { _tag: "folder", folderId: FolderId.make("work") },
        },
      },
      {
        folderId: FolderId.make("clients"),
        pool: {
          poolId: AccountPoolId.make("work"),
          from: { _tag: "folder", folderId: FolderId.make("work") },
        },
      },
      {
        folderId: FolderId.make("northwind"),
        pool: {
          poolId: AccountPoolId.make("work"),
          from: { _tag: "folder", folderId: FolderId.make("work") },
        },
      },
      {
        folderId: FolderId.make("notes"),
        pool: { poolId: AccountPoolId.make("personal"), from: { _tag: "top" } },
      },
      { folderId: FolderId.make("ops"), pool: null },
    ],
  },
};

export const owners: SignalboxContextsSnapshot = {
  contexts: [
    { id: PERSONAL, kind: "personal", name: "Personal", projectIds: [PERSONAL_FILES, DRIVE] },
    { id: ACME, kind: "organization", name: "Acme", projectIds: [ACME_FILES] },
  ],
};
