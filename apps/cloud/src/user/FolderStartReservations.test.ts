import { describe, expect, it, vi } from "@effect/vitest";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { myDriveId } from "../drive/driveAccess.ts";
import { makeMemoryCloud } from "../testing.ts";
import { FolderStarts } from "./FolderStarts.ts";
import { UserFolders } from "./UserFolders.ts";

const USER = "user_alice";
const ACME = SignalboxContextId.make("org_acme");

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  const user = cloud.userDirectory.forUser(USER);
  yield* user.recordSignIn({ id: USER, email: "alice@acme.test" });
  yield* user.syncOrganizations([{ id: ACME, name: "Acme" }]);
  const folders = yield* UserFolders.use(Effect.succeed).pipe(Effect.provide(cloud.layerFor(USER)));
  const sql = yield* SqlClient.SqlClient.use(Effect.succeed).pipe(
    Effect.provide(cloud.layerFor(USER)),
  );
  const created = yield* folders.create({ name: "Alpha", ownerId: ACME, parentId: null });
  const alpha = created.folders.find((folder) => folder.name === "Alpha")!;
  const withBeta = yield* folders.create({ name: "Beta", ownerId: ACME, parentId: null });
  const beta = withBeta.folders.find((folder) => folder.name === "Beta")!;
  const start = (id: FolderId, newFolderId: FolderId) =>
    FolderStarts.use((starts) => starts.startFrom({ id, newFolderId })).pipe(
      Effect.provide(cloud.layerFor(USER)),
    );
  return { cloud, folders, sql, alpha, beta, start };
});

describe("folder start reservations", () => {
  it.effect("refuses a different source after history succeeds but the folder insert fails", () =>
    Effect.gen(function* () {
      const { folders, sql, alpha, beta, start } = yield* setup;
      const id = FolderId.make("interrupted-copy");
      yield* sql`CREATE TRIGGER interrupt_folder_start BEFORE INSERT ON folders
        WHEN NEW.id = 'interrupted-copy'
        BEGIN SELECT RAISE(FAIL, 'injected folder insert failure'); END`;
      expect((yield* start(alpha.id, id).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* folders.snapshot).folders.some((folder) => folder.id === id)).toBe(false);
      yield* sql`DROP TRIGGER interrupt_folder_start`;

      expect((yield* start(beta.id, id).pipe(Effect.result))._tag).toBe("Failure");
      const restored = (yield* start(alpha.id, id)).folders.find((folder) => folder.id === id)!;
      expect(restored.origin).toMatchObject({ folderId: alpha.id, name: "Alpha", head: null });
      expect(restored.name).toBe("Alpha (copy)");
    }).pipe(Effect.scoped),
  );

  it.effect("chooses distinct default names before concurrent history transfers finish", () =>
    Effect.gen(function* () {
      const { cloud, folders, alpha, start } = yield* setup;
      const source = cloud.drives.apiFor(myDriveId(ACME, USER));
      const history = source.history;
      const gate = Promise.withResolvers<void>();
      let arrived = 0;
      const spy = vi.spyOn(source, "history").mockImplementation(async (userId) => {
        if (++arrived === 2) gate.resolve();
        await gate.promise;
        return history(userId);
      });
      const ids = [FolderId.make("concurrent-one"), FolderId.make("concurrent-two")];
      yield* Effect.all(
        ids.map((id) => start(alpha.id, id)),
        { concurrency: "unbounded" },
      ).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
      const names = (yield* folders.snapshot).folders
        .filter((folder) => ids.includes(folder.id))
        .map((folder) => folder.name)
        .sort();
      expect(names).toEqual(["Alpha (copy 2)", "Alpha (copy)"]);
    }).pipe(Effect.scoped),
  );
});
