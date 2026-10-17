import type {
  FolderOrigin,
  FolderStartFromInput,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import { SignalboxFolderError } from "@t3tools/contracts/signalboxFolders";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";

import {
  catalogHomeKey,
  legacyCatalogHome as makeLegacyCatalogHome,
} from "../catalog/catalogHome.ts";
import { folderDriveId, myDriveId } from "../drive/driveAccess.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import * as UserDriveIndex from "./UserDriveIndex.ts";
import * as UserDrives from "./UserDrives.ts";
import * as UserFolders from "./UserFolders.ts";
import * as UserStore from "./UserStore.ts";
import { makeTraced } from "./tracing.ts";

/** Starts a new top-level folder from a source the actor can still read. */
export class FolderStarts extends Context.Service<
  FolderStarts,
  {
    readonly startFrom: (
      input: FolderStartFromInput,
    ) => Effect.Effect<
      SignalboxFoldersSnapshot,
      SignalboxFolderError,
      | UserFolders.UserFolders
      | UserDrives.UserDrives
      | UserDriveIndex.UserDriveIndex
      | UserStore.UserStore
      | Crypto.Crypto
    >;
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

const MAX_FOLDER_NAME_LENGTH = 128;
const copyName = (source: string, used: ReadonlySet<string>) => {
  for (let copy = 1; ; copy++) {
    const suffix = copy === 1 ? " (copy)" : ` (copy ${copy})`;
    const name = `${source.slice(0, MAX_FOLDER_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(name)) return name;
  }
};

const traced = makeTraced(UserDrives.UserDrives.use((drives) => drives.userId));

const startFrom: FolderStarts["Service"]["startFrom"] = (input) =>
  Effect.gen(function* () {
    const folders = yield* UserFolders.UserFolders;
    const drives = yield* UserDrives.UserDrives;
    const index = yield* UserDriveIndex.UserDriveIndex;
    const store = yield* UserStore.UserStore;
    const directory = yield* Effect.serviceOption(DriveDirectory);
    if (directory._tag === "None") {
      return yield* refuse("Could not start the folder. Try again.");
    }
    const drivesDirectory = directory.value;
    const crypto = yield* Crypto.Crypto;

    const syncAccess = (driveId: string, name: string, userId: string) =>
      Effect.gen(function* () {
        const target = drivesDirectory.forDrive(driveId);
        const delivery = (yield* target.pendingAccess()).find((entry) => entry.userId === userId);
        if (delivery?.role != null) {
          yield* index.record({ driveId, name, ...delivery });
        } else if (!(yield* index.drives).some((entry) => entry.driveId === driveId)) {
          return yield* refuse("Could not list the new folder. Try again.");
        }
      });

    if (input.id === input.newFolderId) return yield* refuse("Choose a new folder id.");
    const current = yield* folders.state;
    const source = current.tree.folders.find((folder) => folder.id === input.id);
    if (source === undefined) return yield* refuse("That folder no longer exists.");
    const profile = yield* store.profile;
    if (profile === null) return yield* refuse("Sign in again to start a folder.");

    // A fileless folder works in its owner's top-level drive. Check the live drive role on every call.
    const sourceDriveId = source.driveId ?? myDriveId(source.ownerId, profile.id);
    if ((yield* drives.access(sourceDriveId)) === null) {
      return yield* refuse("You don't have access to that folder's files.");
    }

    const legacyCatalogHome = catalogHomeKey(
      makeLegacyCatalogHome({
        personId: profile.id,
        contextId: source.ownerId,
        folderId: source.id,
      }),
    );
    const destinationKey = Hex.encode(
      yield* crypto.digest(
        "SHA-256",
        new TextEncoder().encode(encodeKey([profile.id, input.newFolderId])),
      ),
    );
    const driveId = folderDriveId(source.ownerId, `start-${destinationKey}`);
    const existing = current.tree.folders.find((folder) => folder.id === input.newFolderId);
    if (existing !== undefined) {
      if (
        existing.ownerId !== source.ownerId ||
        existing.driveId !== driveId ||
        existing.origin?.legacyCatalogHome !== legacyCatalogHome ||
        existing.origin?.folderId !== source.id ||
        existing.origin?.driveId !== sourceDriveId
      ) {
        return yield* refuse("That folder already exists with a different source.");
      }
      yield* syncAccess(existing.driveId, existing.name, profile.id);
      return yield* folders.snapshot;
    }

    const siblingNames = new Set(
      current.tree.folders
        .filter((folder) => folder.ownerId === source.ownerId && folder.parentId === null)
        .map((folder) => folder.name),
    );
    let name = input.name?.trim() ?? copyName(source.name, siblingNames);
    // Reserve before setup: foldDrives must not create a second row for this drive.
    yield* folders.reserveFiles(driveId);
    const target = drivesDirectory.forDrive(driveId);
    // A retry can reach here after history was imported but before the folder row committed.
    // Read the destination's immutable origin before asking the source for a newer snapshot.
    const previousOrigin = yield* target.historyOrigin(profile.id);
    if (previousOrigin !== null && previousOrigin.sourceDriveId !== sourceDriveId) {
      return yield* refuse("That folder already exists with a different source.");
    }
    let head: string | null;
    if (previousOrigin !== null) {
      head = previousOrigin.head;
      name = (yield* target.driveName()) ?? name;
    } else {
      const history = yield* drivesDirectory.forDrive(sourceDriveId).history(profile.id);
      if (history._tag === "refused") {
        return yield* refuse("You don't have access to that folder's files.");
      }
      yield* target.setup({
        name,
        members: [
          {
            userId: profile.id,
            email: profile.email,
            name: profile.firstName ?? null,
            role: "owner",
          },
        ],
      });
      name = (yield* target.driveName()) ?? name;
      const started = yield* target.startFromHistory(profile.id, history.history);
      if (started._tag === "refused") return yield* refuse(started.reason);
      head = history.history.head;
    }

    const origin: FolderOrigin = {
      legacyCatalogHome,
      folderId: source.id,
      name: source.name,
      driveId: sourceDriveId,
      head,
    };
    yield* folders.createFrom({
      id: input.newFolderId,
      name,
      ownerId: source.ownerId,
      driveId,
      origin,
    });
    yield* syncAccess(driveId, name, profile.id);
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

export const layer = Layer.succeed(FolderStarts, FolderStarts.of({ startFrom }));
