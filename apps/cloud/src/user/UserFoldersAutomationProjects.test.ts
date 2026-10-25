import { ProjectId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { layerMemoryStore } from "../testing.ts";
import { myDriveId } from "../drive/driveAccess.ts";
import { projectIdForContext, projectIdForDrive } from "./contextProjects.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserDriveIndex from "./UserDriveIndex.ts";
import * as UserFolders from "./UserFolders.ts";
import * as UserStore from "./UserStore.ts";

const USER = "user_1";
const ACME = SignalboxContextId.make("org_acme");
const ACME_DRIVE = "shared/org_acme/k2";
const PARENT_DRIVE = "shared/org_acme/k3";
const PERSONAL_DRIVE = "folder/personal/k1";
const PERSONAL_HOME_DRIVE = myDriveId(PERSONAL_CONTEXT_ID, USER);

const give = (driveId: string, name: string) =>
  UserDriveIndex.UserDriveIndex.use((drives) =>
    drives.record({ driveId, name, role: "editor", sharedBy: null, revision: 1 }),
  );

describe("UserFolders automation project scopes", () => {
  it.effect("returns the current, ancestor, and owner top-level projects in order", () =>
    Effect.gen(function* () {
      const folders = yield* UserFolders.UserFolders;
      const contexts = yield* UserContexts.UserContexts;
      const store = yield* UserStore.UserStore;
      yield* store.recordSignIn({ id: USER, email: "a@b.c" });
      yield* contexts.syncOrganizations([{ id: ACME, name: "Acme" }]);
      yield* give(ACME_DRIVE, "Current drive");
      yield* give(PARENT_DRIVE, "Parent drive");
      yield* give(PERSONAL_DRIVE, "Personal drive");
      yield* give(PERSONAL_HOME_DRIVE, "Personal home");

      const state = yield* folders.state;
      const current = state.tree.folders.find((folder) => folder.driveId === ACME_DRIVE)!;
      const parent = state.tree.folders.find((folder) => folder.driveId === PARENT_DRIVE)!;
      const personal = state.tree.folders.find((folder) => folder.driveId === PERSONAL_DRIVE)!;
      const personalHome = state.tree.folders.find(
        (folder) => folder.driveId === PERSONAL_HOME_DRIVE,
      )!;
      const container = yield* folders.create({ name: "Container", ownerId: ACME, parentId: null });
      const containerId = container.folders.find((folder) => folder.name === "Container")!.id;
      yield* folders.move({ id: parent.id, parentId: containerId });
      yield* folders.move({ id: current.id, parentId: parent.id });
      yield* folders.move({ id: personal.id, parentId: personalHome.id });

      const scopes = yield* folders.automationProjects(projectIdForDrive(ACME_DRIVE));
      expect(scopes).toEqual([
        projectIdForDrive(ACME_DRIVE),
        projectIdForDrive(PARENT_DRIVE),
        projectIdForContext(ACME),
      ]);

      // The personal tree is a sibling owner, not an ancestor of this drive.
      expect(scopes).not.toContain(projectIdForContext(PERSONAL_CONTEXT_ID));
      // My Drive maps back to its context project, not the synthetic drive project id.
      expect(yield* folders.automationProjects(projectIdForDrive(PERSONAL_DRIVE))).toEqual([
        projectIdForDrive(PERSONAL_DRIVE),
        projectIdForContext(PERSONAL_CONTEXT_ID),
      ]);
      // The top-level project stays a single candidate when it is also the caller.
      expect(yield* folders.automationProjects(projectIdForContext(ACME))).toEqual([
        projectIdForContext(ACME),
      ]);
      // A project with no folder keeps its local scope and gains no guessed ancestry.
      expect(yield* folders.automationProjects(ProjectId.make("unmapped-project"))).toEqual([
        ProjectId.make("unmapped-project"),
      ]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );
});
