import { ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Environment from "../environment.ts";
import { layerMemoryStore } from "../testing.ts";
import * as LearnerHomes from "./LearnerHomes.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserFolders from "./UserFolders.ts";
import * as UserStore from "./UserStore.ts";

const COMPANY = SignalboxContextId.make("org_acme");
const personalThread = ThreadId.make("personal");
const folderThread = ThreadId.make("folder");
const companyThread = ThreadId.make("company");

const setup = Effect.gen(function* () {
  const store = yield* UserStore.UserStore;
  yield* store.recordSignIn({ id: "person_a", email: "a@example.com" });
  const contexts = yield* UserContexts.UserContexts;
  yield* contexts.syncOrganizations([{ id: COMPANY, name: "Acme" }]);
  const sql = yield* SqlClient.SqlClient;
  for (const [id, contextId] of [
    [personalThread, PERSONAL_CONTEXT_ID],
    [folderThread, PERSONAL_CONTEXT_ID],
    [companyThread, COMPANY],
  ] as const) {
    yield* sql`INSERT INTO thread_index (thread_id, context_id, revision, shell, updated_at)
      VALUES (${id}, ${contextId}, 1,
        ${JSON.stringify({ projectId: Environment.SCRATCH_PROJECT_ID })}, 0)`;
  }
  const folders = yield* UserFolders.UserFolders;
  const snapshot = yield* folders.create({ name: "Project", parentId: null });
  const folder = snapshot.folders.find((candidate) => candidate.name === "Project");
  if (!folder) return yield* Effect.die("Missing fixture folder");
  yield* sql`INSERT INTO thread_homes (thread_id, folder_id, filed_at)
    VALUES (${folderThread}, ${folder.id}, 0)`;
  return { homes: yield* LearnerHomes.LearnerHomes, folders, contexts, folderId: folder.id };
});

describe("learner homes", () => {
  it.effect(
    "resolves distinct person, folder and company stores from the thread's actual home",
    () =>
      Effect.gen(function* () {
        const { homes, folderId } = yield* setup;
        const person = yield* homes.home(personalThread);
        const folder = yield* homes.home(folderThread);
        const company = yield* homes.home(companyThread);
        expect(new Set([person.scope, folder.scope, company.scope]).size).toBe(3);
        expect(folder.folderId).toBe(folderId);
        expect(person.folderId).toBeNull();
        expect(company.treeId).toBe(COMPANY);
        expect(person.treeId).toBe(PERSONAL_CONTEXT_ID);
      }).pipe(Effect.provide(LearnerHomes.layer.pipe(Layer.provideMerge(layerMemoryStore)))),
  );

  it.effect("allows descendant summaries but refuses another tree, sibling and private root", () =>
    Effect.gen(function* () {
      const { homes, folders, folderId } = yield* setup;
      expect((yield* homes.lower(personalThread, folderId)).folderId).toBe(folderId);
      const snapshot = yield* folders.create({ name: "Sibling", parentId: null });
      const sibling = snapshot.folders.find((folder) => folder.name === "Sibling");
      if (!sibling) return yield* Effect.die("Missing sibling");
      for (const attempt of [
        homes.lower(folderThread, sibling.id),
        homes.lower(companyThread, folderId),
        homes.lower(folderThread, FolderId.make("not-a-folder")),
      ]) {
        expect((yield* Effect.flip(attempt))._tag).toBe("LearnerAccessError");
      }
    }).pipe(Effect.provide(LearnerHomes.layer.pipe(Layer.provideMerge(layerMemoryStore)))),
  );

  it.effect(
    "refuses revoked memberships and unknown threads instead of using the private root",
    () =>
      Effect.gen(function* () {
        const { homes, contexts } = yield* setup;
        yield* contexts.syncOrganizations([]);
        expect((yield* Effect.flip(homes.home(companyThread))).reason).toBe("not-member");
        expect((yield* Effect.flip(homes.home(ThreadId.make("foreign")))).reason).toBe(
          "unknown-thread",
        );
      }).pipe(Effect.provide(LearnerHomes.layer.pipe(Layer.provideMerge(layerMemoryStore)))),
  );
});
