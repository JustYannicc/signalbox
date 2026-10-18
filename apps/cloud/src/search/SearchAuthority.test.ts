import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { projectIdForContext, projectIdForDrive } from "../user/contextProjects.ts";
import * as UserDriveIndex from "../user/UserDriveIndex.ts";
import { makeMemoryCloud } from "../testing.ts";
import type { ThreadSummary } from "../thread/ThreadEngine.ts";
import * as UserContexts from "../user/UserContexts.ts";
import * as UserStore from "../user/UserStore.ts";
import * as UserFolders from "../user/UserFolders.ts";
import * as SearchAuthority from "./SearchAuthority.ts";

const userId = "user_1";
const orgId = SignalboxContextId.make("org_acme");
const projectOne = ProjectId.make("scratch");
const sharedDrive = "folder/personal/shared-search";
const projectTwo = projectIdForDrive(sharedDrive);
const at = (millis: number) => DateTime.makeUnsafe(millis);

const shell = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: `Thread ${threadId}`,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: RunId.make(`run-${threadId}`),
  latestRunCompletedAt: at(10),
  activeRunId: null,
  status: "completed",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: at(0),
  updatedAt: at(10),
  archivedAt: null,
  settledOverride: null,
  settledAt: at(10),
  deletedAt: null,
  ...overrides,
});

const summary = (
  id: string,
  contextId: SignalboxContextId,
  projectId: ProjectId,
  shellOverrides: Partial<OrchestrationV2ThreadShell> = {},
): ThreadSummary => {
  const threadId = ThreadId.make(id);
  return {
    threadId,
    contextId,
    revision: 1,
    shell: shell(threadId, projectId, shellOverrides),
  };
};

const prepare = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  const userServices = cloud.userObject(userId);
  const { store, contexts, driveIndex, folders } = yield* Effect.all({
    store: UserStore.UserStore,
    folders: UserFolders.UserFolders,
    contexts: UserContexts.UserContexts,
    driveIndex: UserDriveIndex.UserDriveIndex,
  }).pipe(Effect.provide(userServices));

  yield* store.recordSignIn({ id: userId, email: "person@example.com" });
  yield* contexts.syncOrganizations([{ id: orgId, name: "Acme" }]);
  const drive = yield* DriveDirectory.use((directory) =>
    Effect.succeed(directory.forDrive(sharedDrive)),
  ).pipe(Effect.provide(cloud.drives.layer));
  const owner = { userId: "drive-owner", email: "owner@example.com", name: "Owner" };
  yield* drive.setup({
    name: "Shared search",
    members: [
      { ...owner, role: "owner" },
      { userId, email: "person@example.com", name: null, role: "viewer" },
    ],
  });
  yield* store.replaceThreadIndex([
    summary("personal-one", PERSONAL_CONTEXT_ID, projectOne),
    summary("personal-two", PERSONAL_CONTEXT_ID, projectTwo),
    summary("organization-thread", orgId, projectIdForContext(orgId)),
    summary("archived-thread", PERSONAL_CONTEXT_ID, projectOne, {
      archivedAt: at(20),
    }),
    summary("deleted-thread", PERSONAL_CONTEXT_ID, projectOne, {
      deletedAt: at(20),
    }),
  ]);

  const authority = yield* SearchAuthority.SearchAuthority.pipe(
    Effect.provide(SearchAuthority.layerUser.pipe(Layer.provide(userServices))),
  );
  return { authority, contexts, drive, owner, driveIndex, store, folders };
});

describe("SearchAuthority", () => {
  it.effect(
    "hides a trashed subtree before its thread tombstones arrive and restores search access",
    () =>
      Effect.gen(function* () {
        const { authority, folders, store } = yield* prepare;
        const actor = { userId, contextIds: [PERSONAL_CONTEXT_ID] };
        let snapshot = yield* folders.create({ name: "Parent", parentId: null });
        const parent = snapshot.folders.find((folder) => folder.name === "Parent")!;
        snapshot = yield* folders.create({ name: "Child", parentId: parent.id });
        const child = snapshot.folders.find((folder) => folder.name === "Child")!;
        snapshot = yield* folders.create({ name: "Elsewhere", parentId: null });
        const elsewhere = snapshot.folders.find((folder) => folder.name === "Elsewhere")!;
        yield* folders.update({ id: parent.id, files: projectTwo });
        yield* folders.moveThread({ threadId: ThreadId.make("personal-one"), folderId: child.id });
        const before = yield* store.threadIndex;
        yield* store.replaceThreadIndex([
          ...before.threads.map((row) => ({ ...row, threadId: row.shell.id, revision: 1 })),
          summary("filed-elsewhere", PERSONAL_CONTEXT_ID, projectTwo),
        ]);
        yield* folders.moveThread({
          threadId: ThreadId.make("filed-elsewhere"),
          folderId: elsewhere.id,
        });
        expect((yield* authority.current(actor)).homes.flatMap((home) => home.threadIds)).toEqual(
          expect.arrayContaining(["personal-one", "personal-two", "filed-elsewhere"]),
        );

        // Stop after the folder commit, as a stalled cross-object Trash cascade does.
        const { trash } = yield* folders.trash({ id: parent.id });
        expect(
          (yield* store.threadIndex).threads.every(
            (row) =>
              (row.shell.id !== "personal-one" && row.shell.id !== "personal-two") ||
              row.shell.deletedAt === null,
          ),
        ).toBe(true);
        const hidden = (yield* authority.current(actor)).homes.flatMap((home) => home.threadIds);
        expect(hidden).not.toContain("personal-one");
        expect(hidden).not.toContain("personal-two");
        expect(hidden).toContain("filed-elsewhere");
        expect(hidden).toContain("archived-thread");
        yield* folders.moveThread({
          threadId: ThreadId.make("personal-two"),
          folderId: elsewhere.id,
        });
        expect((yield* authority.current(actor)).homes.flatMap((home) => home.threadIds)).toContain(
          "personal-two",
        );

        yield* folders.restoreTrash(trash.trashId);
        expect((yield* authority.current(actor)).homes.flatMap((home) => home.threadIds)).toEqual(
          expect.arrayContaining(["personal-one", "personal-two", "filed-elsewhere"]),
        );
      }),
  );

  it.effect("denies an actor whose user id does not own the user object", () =>
    Effect.gen(function* () {
      const { authority } = yield* prepare;
      const result = yield* authority.current({
        userId: "user_2",
        contextIds: [PERSONAL_CONTEXT_ID],
      });
      expect(result.homes).toEqual([]);
    }),
  );

  it.effect(
    "drops an organization grant after membership is revoked, even when the actor is stale",
    () =>
      Effect.gen(function* () {
        const { authority, contexts } = yield* prepare;
        const staleActor = { userId, contextIds: [PERSONAL_CONTEXT_ID, orgId] };
        const before = yield* authority.current(staleActor);
        expect(before.homes.flatMap((home) => home.threadIds)).toContain("organization-thread");

        yield* contexts.syncOrganizations([]);
        const after = yield* authority.current(staleActor);
        expect(after.actor.contextIds).toEqual([PERSONAL_CONTEXT_ID]);
        expect(after.homes.flatMap((home) => home.threadIds)).not.toContain("organization-thread");
      }),
  );

  it.effect("keeps a SearchActor's project bound when its current homes are resolved", () =>
    Effect.gen(function* () {
      const { authority } = yield* prepare;
      const result = yield* authority.current({
        userId,
        contextIds: [PERSONAL_CONTEXT_ID, orgId],
        projectIds: [projectOne],
      });

      expect(result.homes).toEqual([
        {
          home: { ownerId: userId, projectId: projectOne },
          threadIds: ["archived-thread", "personal-one"],
        },
      ]);
    }),
  );

  it.effect("revokes a shared folder before its stale membership and thread indexes catch up", () =>
    Effect.gen(function* () {
      const { authority, contexts, drive, owner, driveIndex, store } = yield* prepare;
      const actor = { userId, contextIds: [PERSONAL_CONTEXT_ID, orgId] };
      const before = yield* authority.current(actor);
      expect(before.homes.flatMap((home) => home.threadIds)).toContain("personal-two");
      const staleThreads = yield* store.threadIndex;
      yield* drive.unshare(owner, userId);
      yield* store.replaceThreadIndex(
        staleThreads.threads.map((row) => ({
          ...row,
          threadId: row.shell.id,
          revision: 1,
        })),
      );
      // The outbox may be delayed. Keep the derived list granting access while the drive denies it.
      yield* driveIndex.record({
        driveId: sharedDrive,
        name: "Shared search",
        role: "viewer",
        sharedBy: owner.userId,
        revision: 100,
      });
      expect(yield* contexts.contextIds).toContain(orgId);
      expect((yield* driveIndex.drives).some((entry) => entry.driveId === sharedDrive)).toBe(true);
      expect(
        (yield* store.threadIndex).threads.some((row) => row.shell.id === "personal-two"),
      ).toBe(true);
      const after = yield* authority.current(actor);
      expect(after.homes.flatMap((home) => home.threadIds)).not.toContain("personal-two");
      expect(after.homes.flatMap((home) => home.threadIds)).toContain("personal-one");
    }),
  );

  it.effect("keeps the grant fingerprint stable when a home's last thread disappears", () =>
    Effect.gen(function* () {
      const { authority, store } = yield* prepare;
      const actor = { userId, contextIds: [PERSONAL_CONTEXT_ID, orgId] };
      const before = yield* authority.current(actor);
      yield* store.replaceThreadIndex([]);
      const after = yield* authority.current(actor);
      expect(after.homes).toEqual([]);
      expect(after.grants).toEqual(before.grants);
      expect(after.grants.length).toBeGreaterThan(0);
    }),
  );

  it.effect("keeps archived threads searchable and excludes deleted threads", () =>
    Effect.gen(function* () {
      const { authority } = yield* prepare;
      const result = yield* authority.current({ userId, contextIds: [PERSONAL_CONTEXT_ID] });
      const ids = result.homes.flatMap((home) => home.threadIds);

      expect(ids).toContain("archived-thread");
      expect(ids).not.toContain("deleted-thread");
    }),
  );
});
