import type {
  FolderStartFromInput,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import { SignalboxFolderError } from "@t3tools/contracts/signalboxFolders";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { folderDriveId, myDriveId } from "../drive/driveAccess.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import * as UserDriveIndex from "./UserDriveIndex.ts";
import * as UserDrives from "./UserDrives.ts";
import * as UserFolders from "./UserFolders.ts";
import * as UserStore from "./UserStore.ts";
import { makeTraced } from "./tracing.ts";

/** Starts independent files and a folder. No credentials, members or private threads cross. */
export class FolderStarts extends Context.Service<
  FolderStarts,
  {
    readonly startFrom: (
      input: FolderStartFromInput,
    ) => Effect.Effect<SignalboxFoldersSnapshot, SignalboxFolderError>;
  }
>()("@signalbox/cloud/user/FolderStarts") {}

const refuse = (message: string) => Effect.fail(new SignalboxFolderError({ message }));
const unavailable = (cause: unknown) =>
  Effect.logError("folder start failed", { cause }).pipe(
    Effect.andThen(refuse("Could not start the folder. Try again.")),
  );

const encodeKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);

const make = Effect.gen(function* () {
  const folders = yield* UserFolders.UserFolders;
  const drives = yield* UserDrives.UserDrives;
  const index = yield* UserDriveIndex.UserDriveIndex;
  const store = yield* UserStore.UserStore;
  const directory = yield* DriveDirectory;
  const crypto = yield* Crypto.Crypto;
  const traced = makeTraced(drives.userId);

  const startFrom: FolderStarts["Service"]["startFrom"] = (input) =>
    Effect.gen(function* () {
      if (input.id === input.newFolderId) return yield* refuse("Choose a new folder id.");
      const current = yield* folders.state;
      const existing = current.tree.folders.find((folder) => folder.id === input.newFolderId);
      if (existing !== undefined) {
        if (existing.origin?.folderId === input.id) {
          if (existing.driveId !== null) {
            const target = directory.forDrive(existing.driveId);
            const profile = yield* store.profile;
            const delivery = (yield* target.pendingAccess()).find(
              (entry) => entry.userId === profile?.id,
            );
            if (delivery?.role != null)
              yield* index.record({ driveId: existing.driveId, name: existing.name, ...delivery });
          }
          return yield* folders.snapshot;
        }
        return yield* refuse("That folder already exists.");
      }
      const source = current.tree.folders.find((folder) => folder.id === input.id);
      if (source === undefined) return yield* refuse("That folder no longer exists.");
      yield* Effect.annotateCurrentSpan("org.id", source.ownerId);
      const profile = yield* store.profile;
      if (profile === null) return yield* refuse("Sign in again to start a folder.");
      // A deterministic destination lets a retry finish after either object's write succeeded.
      const key = Hex.encode(
        yield* crypto.digest(
          "SHA-256",
          new TextEncoder().encode(encodeKey([profile.id, input.newFolderId])),
        ),
      );
      const sourceDriveId = source.driveId ?? myDriveId(source.ownerId, profile.id);
      const driveId = folderDriveId(source.ownerId, `fork-${key}`);
      let commit: string | null = null;
      const name = input.name ?? `${source.name.slice(0, 121)} (copy)`;
      {
        if ((yield* drives.access(sourceDriveId)) === null)
          return yield* refuse("You don't have access to that folder's files.");
        const target = directory.forDrive(driveId);
        yield* folders.reserveFiles(driveId);
        yield* target.setup({
          name,
          members: [
            {
              userId: profile.id,
              email: profile.email,
              name: profile.firstName ?? null,
              role: "manager",
            },
          ],
        });
        const prepared = yield* target.forkOrigin(profile.id);
        if (prepared !== null && prepared.driveId !== sourceDriveId)
          return yield* refuse("That folder id has a different origin.");
        if (prepared === null) {
          const snapshot = yield* directory.forDrive(sourceDriveId).forkSnapshot(profile.id);
          const started = yield* target.startFrom(profile.id, snapshot);
          if (started._tag === "refused") return yield* refuse(started.reason);
          commit = snapshot.main;
        } else commit = prepared.main;
      }
      yield* folders.createFrom({
        id: input.newFolderId,
        name,
        ownerId: source.ownerId,
        driveId,
        origin: {
          folderId: source.id,
          name: source.name,
          driveId: sourceDriveId,
          commit,
          createdAt: yield* Clock.currentTimeMillis,
        },
      });

      const target = directory.forDrive(driveId);
      const delivery = (yield* target.pendingAccess()).find((entry) => entry.userId === profile.id);
      if (delivery?.role != null) yield* index.record({ driveId, name, ...delivery });
      else if (!(yield* index.drives).some((entry) => entry.driveId === driveId))
        return yield* refuse("Could not list the new folder. Try again.");
      return yield* folders.snapshot;
    }).pipe(
      traced("FolderStarts.startFrom", {
        "folder.id": input.id,
        "folder.new_id": input.newFolderId,
      }),
      Effect.catchTags({
        SqlError: unavailable,
        PlatformError: unavailable,
        DriveObjectError: unavailable,
        FolderRefusedError: (error) => refuse(error.message),
      }),
    );
  return FolderStarts.of({ startFrom });
});

export const layer = Layer.effect(FolderStarts, make);
