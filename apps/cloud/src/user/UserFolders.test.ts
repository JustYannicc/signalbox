import { ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import {
  FolderId,
  OnePasswordEnvironmentId,
  type SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Environment from "../environment.ts";
import { layerMemoryStore } from "../testing.ts";
import { projectIdForDrive } from "./contextProjects.ts";
import * as LegacySections from "./legacySections.ts";
import * as OnePasswordAccount from "./OnePasswordAccount.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserDriveIndex from "./UserDriveIndex.ts";
import * as UserFolders from "./UserFolders.ts";
import * as UserStore from "./UserStore.ts";

const USER = "user_1";
const ACME = SignalboxContextId.make("org_acme");
const SCRATCH = Environment.SCRATCH_PROJECT_ID;
const CLIENT_DRIVE = "folder/personal/k1";
const ACME_DRIVE = "shared/org_acme/k2";

/** Each owner's folder names, nested under their parent's, in order. */
const outline = (snapshot: SignalboxFoldersSnapshot, ownerId: string = PERSONAL_CONTEXT_ID) => {
  const render = (parentId: string | null): Array<unknown> =>
    snapshot.folders
      .filter((folder) => folder.ownerId === ownerId && folder.parentId === parentId)
      .toSorted((left, right) => left.position - right.position)
      .map((folder) => {
        const children = render(folder.id);
        return children.length > 0 ? { [folder.name]: children } : folder.name;
      });
  return render(null);
};

const idOf = (snapshot: SignalboxFoldersSnapshot, name: string) => {
  const found = snapshot.folders.find((folder) => folder.name === name);
  if (!found) throw new Error(`no folder ${name}`);
  return found.id;
};

const reasonOf = <A, R>(effect: Effect.Effect<A, { readonly _tag: string }, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => ("reason" in error ? error.reason : error._tag)),
  );

const services = Effect.all({
  folders: UserFolders.UserFolders,
  contexts: UserContexts.UserContexts,
  drives: UserDriveIndex.UserDriveIndex,
  store: UserStore.UserStore,
  sql: SqlClient.SqlClient,
});

/** A thread in the user's index, as its object's summary would leave it. */
const indexThread = (threadId: string, contextId: string, projectId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`INSERT INTO thread_index (thread_id, context_id, revision, shell, updated_at)
      VALUES (${threadId}, ${contextId}, 1, ${JSON.stringify({ id: threadId, projectId })}, 0)`,
  );

const give = (driveId: string, name: string) =>
  UserDriveIndex.UserDriveIndex.use((drives) =>
    drives.record({ driveId, name, role: "editor", sharedBy: null, revision: 1 }),
  );

describe("UserFolders", () => {
  it.effect("nests folders at any depth, and moves them anywhere in their owner's tree", () =>
    Effect.gen(function* () {
      const { folders, contexts } = yield* services;
      yield* contexts.syncOrganizations([{ id: ACME, name: "Acme" }]);
      let snapshot = yield* folders.create({ name: "A", parentId: null });
      for (const name of ["B", "C", "D", "E", "F", "G"]) {
        const parent = String.fromCharCode(name.charCodeAt(0) - 1);
        snapshot = yield* folders.create({ name, parentId: idOf(snapshot, parent) });
      }
      expect(outline(snapshot)).toEqual([
        { A: [{ B: [{ C: [{ D: [{ E: [{ F: ["G"] }] }] }] }] }] },
      ]);

      // Lifted out, with everything under it.
      snapshot = yield* folders.move({ id: idOf(snapshot, "D"), parentId: null });
      expect(outline(snapshot)).toEqual([{ A: [{ B: ["C"] }] }, { D: [{ E: [{ F: ["G"] }] }] }]);
      // Before a sibling.
      snapshot = yield* folders.move({
        id: idOf(snapshot, "D"),
        parentId: null,
        beforeId: idOf(snapshot, "A"),
      });
      expect(outline(snapshot).map((node) => Object.keys(node as object)[0])).toEqual(["D", "A"]);

      expect(
        yield* reasonOf(folders.move({ id: idOf(snapshot, "D"), parentId: idOf(snapshot, "G") })),
      ).toBe("invalid");
      const payments = yield* folders.create({ name: "Payments", parentId: null, ownerId: ACME });
      expect(outline(payments, ACME)).toEqual(["Payments"]);
      expect(
        yield* reasonOf(
          folders.move({ id: idOf(payments, "Payments"), parentId: idOf(payments, "A") }),
        ),
      ).toBe("invalid");
      expect(yield* reasonOf(folders.delete({ id: "gone" as never }))).toBe("not-found");
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect(
    "gives every thread a home it can move out of, and deleting a folder moves its threads up",
    () =>
      Effect.gen(function* () {
        const { folders, contexts, store } = yield* services;
        yield* store.recordSignIn({ id: USER, email: "a@b.c" });
        yield* contexts.syncOrganizations([{ id: ACME, name: "Acme" }]);
        const scratchThread = ThreadId.make("thread-scratch");
        const acmeThread = ThreadId.make("thread-acme");
        yield* indexThread(scratchThread, PERSONAL_CONTEXT_ID, SCRATCH);
        yield* indexThread(acmeThread, ACME, "context:org_acme");

        let snapshot = yield* folders.create({ name: "Work", parentId: null });
        snapshot = yield* folders.create({ name: "Clients", parentId: idOf(snapshot, "Work") });
        const work = idOf(snapshot, "Work");
        const clients = idOf(snapshot, "Clients");
        // At the top level until filed.
        expect(snapshot.threadHomes).toEqual([]);
        expect(snapshot.projectHomes).toContainEqual({ projectId: SCRATCH, folderId: null });

        snapshot = yield* folders.moveThread({ threadId: scratchThread, folderId: clients });
        expect(snapshot.threadHomes).toEqual([{ threadId: scratchThread, folderId: clients }]);
        // A thread stays in its owner's tree.
        expect(yield* reasonOf(folders.moveThread({ threadId: acmeThread, folderId: work }))).toBe(
          "invalid",
        );

        // Deleting Clients: its thread goes up to Work.
        snapshot = yield* folders.delete({ id: clients });
        expect(outline(snapshot)).toEqual(["Work"]);
        expect(snapshot.threadHomes).toEqual([{ threadId: scratchThread, folderId: work }]);

        // A thread filed before it exists, never created: the next filing a day on drops it.
        yield* folders.moveThread({ threadId: ThreadId.make("never-created"), folderId: work });
        yield* TestClock.adjust("25 hours");
        snapshot = yield* folders.moveThread({
          threadId: ThreadId.make("just-filed"),
          folderId: work,
        });
        expect(snapshot.threadHomes.map((home) => home.threadId)).toEqual([
          scratchThread,
          "just-filed",
        ]);

        // Back to where its project would put it: no filing left.
        snapshot = yield* folders.moveThread({ threadId: scratchThread, folderId: null });
        expect(snapshot.threadHomes).toEqual([{ threadId: "just-filed", folderId: work }]);
      }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect(
    "resolves a thread's next turn from its home: the nearest pool, and AGENTS.md top first",
    () =>
      Effect.gen(function* () {
        const { folders, store } = yield* services;
        yield* store.recordSignIn({ id: USER, email: "a@b.c" });
        const threadId = ThreadId.make("thread-1");
        yield* indexThread(threadId, PERSONAL_CONTEXT_ID, SCRATCH);
        let snapshot = yield* folders.create({ name: "Work", parentId: null });
        snapshot = yield* folders.create({ name: "Clients", parentId: idOf(snapshot, "Work") });
        const work = idOf(snapshot, "Work");
        const clients = idOf(snapshot, "Clients");
        yield* folders.setInstructions({ level: { _tag: "top" }, instructions: "Be brief." });
        yield* folders.setInstructions({
          level: { _tag: "folder", folderId: clients },
          instructions: "Bill hourly.",
        });
        yield* folders.setInstructions({
          level: { _tag: "folder", folderId: work },
          instructions: "Write in English.",
        });

        const topOnly = [{ label: "Top level", text: "Be brief." }];
        expect(yield* folders.turn({ threadId, projectId: null })).toEqual({
          pools: { top: "personal", projects: { [SCRATCH]: "personal" } },
          instructions: { top: topOnly, projects: { [SCRATCH]: topOnly } },
          secrets: { top: [], projects: { [SCRATCH]: [] } },
        });

        // Filed in Clients: its own cascade, beside every project's for a thread it doesn't know.
        yield* folders.moveThread({ threadId, folderId: clients });
        const moved = yield* folders.turn({ threadId, projectId: null });
        expect(moved.instructions.thread).toEqual([
          { label: "Top level", text: "Be brief." },
          { label: "Work", text: "Write in English." },
          { label: "Work / Clients", text: "Bill hourly." },
        ]);
        expect(moved.instructions.projects[SCRATCH]).toEqual(topOnly);
        expect(moved.pools.thread).toBe("personal");

        // Clearing one drops it from the cascade.
        yield* folders.setInstructions({
          level: { _tag: "folder", folderId: work },
          instructions: "",
        });
        expect(
          (yield* folders.turn({ threadId, projectId: null })).instructions.thread?.map(
            (level) => level.label,
          ),
        ).toEqual(["Top level", "Work / Clients"]);
      }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("keeps where agents may always send a secret, shows it, and stops it on revoke", () =>
    Effect.gen(function* () {
      const { folders, store } = yield* services;
      yield* store.recordSignIn({ id: USER, email: "a@b.c" });
      const environmentId = OnePasswordEnvironmentId.make("env-work");
      const grant = {
        folderId: null,
        environmentId,
        name: "STRIPE_KEY",
        host: "api.stripe.com",
      };

      yield* folders.keepSends([grant]);
      // Keeping it again changes nothing.
      yield* folders.keepSends([grant]);
      expect(
        (yield* folders.snapshot).secretSends?.map(({ folderId, environmentId, name, host }) => ({
          folderId,
          environmentId,
          name,
          host,
        })),
      ).toEqual([grant]);
      expect([
        ...(yield* folders.allowedSends("api.stripe.com", [
          { folderId: null, environmentId, name: "STRIPE_KEY" },
        ])),
      ]).toEqual(["STRIPE_KEY"]);
      expect(
        (yield* folders.allowedSends("api.stripe.com", [
          {
            folderId: undefined as never,
            environmentId,
            name: "STRIPE_KEY",
          },
        ])).size,
      ).toBe(0);

      const missingFolder = { ...grant, folderId: undefined as never };
      yield* folders.keepSends([missingFolder]);
      expect((yield* folders.snapshot).secretSends).toMatchObject([grant]);
      expect((yield* folders.revokeSecretSend(missingFolder)).secretSends).toMatchObject([grant]);

      // Another Environment's variable of the same name is another secret.
      expect(
        (yield* folders.allowedSends("api.stripe.com", [
          {
            folderId: null,
            environmentId: OnePasswordEnvironmentId.make("env-other"),
            name: "STRIPE_KEY",
          },
        ])).size,
      ).toBe(0);

      const revoked = yield* folders.revokeSecretSend(grant);
      expect(revoked.secretSends).toBeUndefined();
      expect(
        (yield* folders.allowedSends("api.stripe.com", [
          { folderId: null, environmentId, name: "STRIPE_KEY" },
        ])).size,
      ).toBe(0);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("keeps Always grants to their folder and only revokes that folder's grant", () =>
    Effect.gen(function* () {
      const { folders, store } = yield* services;
      yield* store.recordSignIn({ id: USER, email: "a@b.c" });
      let snapshot = yield* folders.create({ name: "A", parentId: null });
      snapshot = yield* folders.create({ name: "B", parentId: null });
      const folderA = FolderId.make(idOf(snapshot, "A"));
      const folderB = FolderId.make(idOf(snapshot, "B"));
      const environmentId = OnePasswordEnvironmentId.make("shared-environment");
      const send = { environmentId, name: "API_KEY", host: "api.example.test" };
      const grantA = { ...send, folderId: folderA };
      const grantB = { ...send, folderId: folderB };

      yield* folders.keepSends([grantA]);
      expect([...(yield* folders.allowedSends(send.host, [grantA]))]).toEqual(["API_KEY"]);
      expect([...(yield* folders.allowedSends(send.host, [grantB]))]).toEqual([]);

      yield* folders.keepSends([grantB]);
      snapshot = yield* folders.snapshot;
      expect(snapshot.secretSends).toMatchObject([grantA, grantB]);

      snapshot = yield* folders.revokeSecretSend(grantB);
      expect(snapshot.secretSends).toMatchObject([grantA]);
      expect([...(yield* folders.allowedSends(send.host, [grantA]))]).toEqual(["API_KEY"]);
      expect([...(yield* folders.allowedSends(send.host, [grantB]))]).toEqual([]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect(
    "gives a thread its chain's 1Password Environments top first, and shows only when 1Password was connected",
    () =>
      Effect.gen(function* () {
        const { folders, store } = yield* services;
        const account = yield* OnePasswordAccount.OnePasswordAccount;
        yield* store.recordSignIn({ id: USER, email: "a@b.c" });
        const threadId = ThreadId.make("thread-1");
        yield* indexThread(threadId, PERSONAL_CONTEXT_ID, SCRATCH);
        let snapshot = yield* folders.create({ name: "Work", parentId: null });
        snapshot = yield* folders.create({ name: "Clients", parentId: idOf(snapshot, "Work") });
        const work = idOf(snapshot, "Work");
        const clients = idOf(snapshot, "Clients");
        const env = OnePasswordEnvironmentId.make;
        yield* folders.setSecrets({
          level: { _tag: "top" },
          secrets: { environmentId: env("env-top") },
        });
        yield* folders.setSecrets({
          level: { _tag: "folder", folderId: clients },
          secrets: { environmentId: env("env-clients") },
        });
        snapshot = yield* folders.setSecrets({
          level: { _tag: "folder", folderId: work },
          secrets: { environmentId: env("env-work") },
        });
        expect(snapshot.top).toEqual({ secrets: { environmentId: "env-top" } });
        // Folders at different depths come in id order, which is random here.
        expect(
          Object.fromEntries(snapshot.folders.map((folder) => [folder.name, folder.secrets])),
        ).toEqual({
          Work: { environmentId: "env-work" },
          Clients: { environmentId: "env-clients" },
        });

        // Filed in Clients: every level up its chain, top level first.
        yield* folders.moveThread({ threadId, folderId: clients });
        expect((yield* folders.turn({ threadId, projectId: null })).secrets).toEqual({
          top: ["env-top"],
          projects: { [SCRATCH]: ["env-top"] },
          thread: ["env-top", "env-work", "env-clients"],
        });

        // Clearing a level drops it; setting the same again changes nothing.
        snapshot = yield* folders.setSecrets({
          level: { _tag: "folder", folderId: work },
          secrets: null,
        });
        expect(
          (yield* folders.setSecrets({
            level: { _tag: "top" },
            secrets: { environmentId: env("env-top") },
          })).revision,
        ).toBe(snapshot.revision);
        expect((yield* folders.turn({ threadId, projectId: null })).secrets.thread).toEqual([
          "env-top",
          "env-clients",
        ]);

        // Deleting Clients takes its reference with it; its thread goes up to Work.
        snapshot = yield* folders.delete({ id: clients });
        expect(snapshot.folders.map((folder) => folder.secrets)).toEqual([undefined]);
        expect((yield* folders.turn({ threadId, projectId: null })).secrets.thread).toEqual([
          "env-top",
        ]);
        expect(
          yield* reasonOf(
            folders.setSecrets({
              level: { _tag: "folder", folderId: clients },
              secrets: { environmentId: env("env-gone") },
            }),
          ),
        ).toBe("not-found");

        // 1Password: the snapshot says when it was connected, never the token.
        expect(snapshot.onePassword).toBeUndefined();
        const token = "ops_first-service-account-token";
        yield* TestClock.setTime(5_000);
        let connected = yield* folders.setOnePassword({ token });
        expect(connected.onePassword).toEqual({ connectedAt: 5_000 });
        expect(connected.revision).toBeGreaterThan(snapshot.revision);
        expect(JSON.stringify(connected)).not.toContain(token);
        expect(yield* account.token).toBe(token);
        // Replacing it moves the time; disconnecting removes both.
        yield* TestClock.setTime(9_000);
        connected = yield* folders.setOnePassword({ token: "ops_replacement-token" });
        expect(connected.onePassword).toEqual({ connectedAt: 9_000 });
        expect(yield* account.token).toBe("ops_replacement-token");
        const disconnected = yield* folders.setOnePassword({ token: null });
        expect(disconnected.onePassword).toBeUndefined();
        expect(disconnected.revision).toBeGreaterThan(connected.revision);
        expect(yield* account.token).toBeNull();
      }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("gives new folders their tree's phases, which people move, edit and clear", () =>
    Effect.gen(function* () {
      const { folders, contexts } = yield* services;
      yield* contexts.syncOrganizations([{ id: ACME, name: "Acme" }]);
      let snapshot = yield* folders.create({ name: "Trip", parentId: null });
      snapshot = yield* folders.create({ name: "Payments", parentId: null, ownerId: ACME });
      snapshot = yield* folders.create({ name: "Live", parentId: null, phases: null });
      const phaseOf = (name: string) =>
        snapshot.folders.find((folder) => folder.name === name)?.phase;
      expect(phaseOf("Trip")).toEqual({ phases: ["Idea", "Doing", "Done"], current: "Idea" });
      expect(phaseOf("Payments")).toEqual({
        phases: ["Proposal", "Initiative", "Implementation", "Testing", "Production"],
        current: "Proposal",
      });
      expect(phaseOf("Live")).toBeUndefined();

      // Skipping ahead, matched ignoring case, as an automation would on a first deploy.
      const payments = idOf(snapshot, "Payments");
      snapshot = yield* folders.setPhase({ id: payments, current: "production" });
      expect(phaseOf("Payments")?.current).toBe("Production");
      const revision = snapshot.revision;
      snapshot = yield* folders.setPhase({ id: payments, current: "Production" });
      expect(snapshot.revision).toBe(revision);

      // A new list keeps the current phase when it's still there, else starts at the first.
      snapshot = yield* folders.setPhase({
        id: payments,
        phases: ["Pilot", " Production ", "Sunset"],
      });
      expect(phaseOf("Payments")).toEqual({
        phases: ["Pilot", "Production", "Sunset"],
        current: "Production",
      });
      snapshot = yield* folders.setPhase({ id: payments, phases: ["Beta", "GA"] });
      expect(phaseOf("Payments")).toEqual({ phases: ["Beta", "GA"], current: "Beta" });

      expect(yield* reasonOf(folders.setPhase({ id: payments, current: "Shipped" }))).toBe(
        "invalid",
      );
      expect(yield* reasonOf(folders.setPhase({ id: payments, phases: ["A", "a"] }))).toBe(
        "invalid",
      );
      expect(yield* reasonOf(folders.setPhase({ id: payments, phases: [] }))).toBe("invalid");

      // Cleared, then given phases again.
      snapshot = yield* folders.setPhase({ id: payments, phases: null });
      expect(phaseOf("Payments")).toBeUndefined();
      expect(yield* reasonOf(folders.setPhase({ id: payments, current: "GA" }))).toBe("invalid");
      snapshot = yield* folders.setPhase({ id: payments, phases: ["Beta", "GA"], current: "GA" });
      expect(phaseOf("Payments")).toEqual({ phases: ["Beta", "GA"], current: "GA" });
      expect(yield* reasonOf(folders.setPhase({ id: "gone" as never, phases: null }))).toBe(
        "not-found",
      );
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("lends a GitHub account to a folder for CI steps, and takes it back (#641)", () =>
    Effect.gen(function* () {
      const { folders, store } = yield* services;
      yield* store.recordSignIn({ id: USER, email: "a@b.c" });
      yield* TestClock.setTime(1_000);
      yield* give(CLIENT_DRIVE, "Northwind");
      const repo = (yield* folders.snapshot).folders.find((folder) => folder.files)!;
      const lendOf = (snapshot: SignalboxFoldersSnapshot) =>
        snapshot.folders.find((folder) => folder.id === repo.id)?.githubLend;
      expect(repo.githubLend).toBeUndefined();

      expect(lendOf(yield* folders.setGitHubLend(repo.id, "octo"))).toEqual({
        login: "octo",
        lentAt: 1_000,
      });
      // The same account again keeps when it was lent; another replaces it.
      yield* TestClock.setTime(2_000);
      expect(lendOf(yield* folders.setGitHubLend(repo.id, "octo"))?.lentAt).toBe(1_000);
      expect(lendOf(yield* folders.setGitHubLend(repo.id, "hubot"))).toEqual({
        login: "hubot",
        lentAt: 2_000,
      });
      expect(lendOf(yield* folders.setGitHubLend(repo.id, null))).toBeUndefined();

      // The lend was for those files' repository: other files need lending again.
      yield* folders.setGitHubLend(repo.id, "octo");
      expect(lendOf(yield* folders.update({ id: repo.id, files: null }))).toBeUndefined();

      // A deleted folder's lend goes with it.
      yield* folders.setGitHubLend(repo.id, "octo");
      yield* folders.delete({ id: repo.id });
      const { bindings } = yield* folders.rows;
      expect(bindings.filter((row) => row.kind === "github-actions")).toEqual([]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("migrates sections, placements and pools into folders, once", () =>
    Effect.gen(function* () {
      const { contexts, store, sql } = yield* services;
      yield* store.recordSignIn({ id: USER, email: "a@b.c" });
      yield* contexts.syncOrganizations([{ id: ACME, name: "Acme" }]);
      yield* give(CLIENT_DRIVE, "Northwind files");
      yield* give(ACME_DRIVE, "Payments drive");

      // A user object from before folders: `0013` and later not run yet.
      yield* sql`DROP TABLE folders`;
      yield* sql`DROP TABLE folder_drives`;
      yield* sql`DROP TABLE thread_homes`;
      yield* sql`DROP TABLE folders_state`;
      yield* sql`DROP TABLE onepassword_account`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN (13, 15, 20)`;
      yield* sql`INSERT INTO sections (id, context_id, parent_id, name, position) VALUES
        ('work', 'personal', NULL, 'Work', 0),
        ('clients', 'personal', 'work', 'Clients', 0),
        ('ops', 'org_acme', NULL, 'Ops', 0)`;
      yield* sql`INSERT INTO project_placements (project_id, section_id, position) VALUES
        (${projectIdForDrive(CLIENT_DRIVE)}, 'clients', 0),
        (${SCRATCH}, 'work', 0)`;
      yield* sql`INSERT INTO resource_bindings
        (level_kind, level_id, kind, resource_id, reach, created_at)
        VALUES ('section', 'clients', 'pool', 'personal', 'below', 1)`;
      const scratchThread = ThreadId.make("thread-scratch");
      const clientThread = ThreadId.make("thread-client");
      yield* indexThread(scratchThread, PERSONAL_CONTEXT_ID, SCRATCH);
      yield* indexThread(clientThread, PERSONAL_CONTEXT_ID, projectIdForDrive(CLIENT_DRIVE));

      yield* UserStore.migrate;
      const folders = yield* UserFolders.UserFolders;
      const snapshot = yield* folders.snapshot;

      // Sections keep their ids; the drive takes its place in Clients; Acme's stays Acme's.
      expect(outline(snapshot)).toEqual([{ Work: [{ Clients: ["Northwind files"] }] }]);
      // Folders that already existed, and drives' folders, start with no phase.
      expect(snapshot.folders.filter((folder) => folder.phase !== undefined)).toEqual([]);
      expect(outline(snapshot, ACME)).toEqual(["Ops", "Payments drive"]);
      const northwind = snapshot.folders.find((folder) => folder.name === "Northwind files")!;
      expect(northwind.files).toEqual({ projectId: projectIdForDrive(CLIENT_DRIVE) });
      // The My Drive's threads stay in Work; the drive's live in its folder without filing.
      expect(snapshot.threadHomes).toEqual([{ threadId: scratchThread, folderId: "work" }]);
      expect(snapshot.projectHomes).toContainEqual({
        projectId: projectIdForDrive(CLIENT_DRIVE),
        folderId: northwind.id,
      });
      // The pool at the section is the folder's now, and reaches the drive's folder.
      expect(snapshot.folders.find((folder) => folder.id === "clients")?.poolId).toBe("personal");
      expect(snapshot.pools.folders.find((entry) => entry.folderId === northwind.id)?.pool).toEqual(
        { poolId: "personal", from: { _tag: "folder", folderId: "clients" } },
      );

      // Again changes nothing: the migration is recorded, the drive marked.
      yield* UserStore.migrate;
      yield* folders.move({ id: northwind.id, parentId: null });
      yield* folders.update({ id: northwind.id, files: null });
      const again = yield* folders.snapshot;
      expect(again.folders.map((folder) => folder.name).toSorted()).toEqual(
        snapshot.folders.map((folder) => folder.name).toSorted(),
      );
      expect(again.folders.find((folder) => folder.id === northwind.id)?.files).toBeUndefined();
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("serves older clients the folders as sections and project placements", () =>
    Effect.gen(function* () {
      const { folders, store } = yield* services;
      yield* store.recordSignIn({ id: USER, email: "a@b.c" });
      yield* give(CLIENT_DRIVE, "Northwind files");
      let snapshot = yield* folders.create({ name: "Clients", parentId: null });
      const clients = idOf(snapshot, "Clients");
      const northwind = snapshot.folders.find((folder) => folder.name === "Northwind files")!.id;
      yield* folders.move({ id: northwind, parentId: clients });
      // A folder inside one with files has no place in sections: it shows one level up.
      snapshot = yield* folders.create({ name: "Notes", parentId: northwind });

      const legacy = yield* LegacySections.LegacySections.use((service) => service.snapshot);
      expect(legacy.sections.map((section) => [section.name, section.parentId])).toEqual([
        ["Clients", null],
        ["Notes", clients],
      ]);
      expect(legacy.projectPlacements).toEqual([
        { projectId: projectIdForDrive(CLIENT_DRIVE), sectionId: clients, position: 0 },
      ]);

      // Their moves still land: the drive's project goes back to the top level.
      const moved = yield* LegacySections.LegacySections.use((service) =>
        service.moveProject({ projectId: projectIdForDrive(CLIENT_DRIVE), sectionId: null }),
      );
      expect(moved.projectPlacements[0]?.sectionId).toBeNull();
      expect(
        yield* LegacySections.LegacySections.use((service) =>
          service.moveProject({ projectId: SCRATCH, sectionId: clients }).pipe(
            Effect.flip,
            Effect.map((error) => ("code" in error ? error.code : error._tag)),
          ),
        ),
      ).toBe("project-not-found");
    }).pipe(Effect.provide(layerMemoryStore)),
  );
});
