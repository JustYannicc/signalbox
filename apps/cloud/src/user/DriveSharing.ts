import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type {
  SignalboxDrive,
  SignalboxDriveCreateInput,
  SignalboxDriveMember,
  SignalboxDriveShareFolderInput,
  SignalboxDriveShareInput,
  SignalboxDriveUnshareInput,
} from "@t3tools/contracts/signalboxDrives";
import { grantableDriveRoles, SignalboxDriveError } from "@t3tools/contracts/signalboxDrives";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";

import { contextAllows, folderDriveId, parseDriveId, sharedDriveId } from "../drive/driveAccess.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import type { DrivePerson } from "../drive/DriveMembers.ts";
import { isWithin, pathSegments } from "../drive/DriveReader.ts";
import { splitFolder } from "../drive/DriveSplit.ts";
import { DrivePacks } from "../drive/DrivePacks.ts";
import { DrivePeople } from "./DrivePeople.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserDriveIndex from "./UserDriveIndex.ts";
import * as UserDrives from "./UserDrives.ts";
import * as UserStore from "./UserStore.ts";

/**
 * Creating shared drives and sharing drives and folders, for the user whose
 * object this is. Each call checks the user's own access here and leaves the
 * drive to decide the rest: only its managers change who's in it.
 *
 * Sharing a folder from My Drive splits it into a drive of its own the first
 * time (`DriveSplit`), so the people it's shared with see only that folder
 * and its history. The split drive's id comes from the My Drive and the path,
 * so a retry after a failure finishes the same split instead of starting
 * another.
 */

type Failure = SignalboxDriveError;

export class DriveSharing extends Context.Service<
  DriveSharing,
  {
    readonly create: (input: SignalboxDriveCreateInput) => Effect.Effect<SignalboxDrive, Failure>;
    readonly members: (
      driveId: string,
    ) => Effect.Effect<ReadonlyArray<SignalboxDriveMember>, Failure>;
    readonly share: (
      input: SignalboxDriveShareInput,
    ) => Effect.Effect<SignalboxDriveMember, Failure>;
    readonly unshare: (input: SignalboxDriveUnshareInput) => Effect.Effect<void, Failure>;
    readonly shareFolder: (
      input: SignalboxDriveShareFolderInput,
    ) => Effect.Effect<SignalboxDrive, Failure>;
  }
>()("@signalbox/cloud/user/DriveSharing") {}

const refuse = (message: string) => Effect.fail(new SignalboxDriveError({ message }));
const UNAVAILABLE = "Drives are unavailable right now. Try again.";

/** Infrastructure failures become one message for the user; the cause goes to the logs. */
const unavailable = (cause: unknown) =>
  Effect.logError("drive sharing failed", { cause }).pipe(Effect.andThen(refuse(UNAVAILABLE)));

const make = Effect.gen(function* () {
  const store = yield* UserStore.UserStore;
  const contexts = yield* UserContexts.UserContexts;
  const drives = yield* UserDrives.UserDrives;
  const index = yield* UserDriveIndex.UserDriveIndex;
  const directory = yield* DriveDirectory;
  const packs = yield* DrivePacks;
  const people = yield* DrivePeople;
  const crypto = yield* Crypto.Crypto;

  const me = Effect.gen(function* () {
    const profile = yield* store.profile;
    if (profile === null) return yield* refuse("Sign in again to share.");
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
    return { userId: profile.id, email: profile.email, name: name || null } satisfies DrivePerson;
  });

  /** The user's role in a drive they can open, or a refusal. */
  const opened = (driveId: string) =>
    Effect.flatMap(drives.access(driveId), (role) =>
      role === null ? refuse("You don't have access to that drive.") : Effect.succeed(role),
    );

  /** The person behind `email`, if they could open a drive of `contextId`. */
  const recipient = (email: string, contextId: SignalboxContextId) =>
    Effect.gen(function* () {
      const person = yield* people.findByEmail(email);
      if (person === null) return yield* refuse(`Nobody with ${email} uses Signalbox yet.`);
      // A work organization's files stay inside it; Personal files go to anyone.
      if (contextId === PERSONAL_CONTEXT_ID) return person;
      const organizations = (yield* people.organizationsOf(person.userId)).map((id) =>
        SignalboxContextId.make(id),
      );
      if (!contextAllows(organizations, contextId)) {
        const organization = (yield* contexts.contexts).find((context) => context.id === contextId);
        return yield* refuse(`${email} isn't in ${organization?.name ?? "this organization"}.`);
      }
      return person;
    });

  /**
   * The user's view of a drive they made. A new one is listed in their index
   * at once, from the drive's own pending delivery to them, so that delivery
   * changes nothing when it arrives.
   */
  const listNow = (driveId: string, userId: string) =>
    Effect.gen(function* () {
      const drive = directory.forDrive(driveId);
      const name = (yield* drive.driveName()) ?? "Drive";
      const entry = (yield* drive.pendingAccess()).find((pending) => pending.userId === userId);
      if (entry?.role) yield* index.record({ driveId, name, ...entry });
      const role = entry?.role ?? (yield* drive.role(userId));
      if (role === null) return yield* refuse(UNAVAILABLE);
      return UserDrives.listedDrive({ driveId, name, role, sharedBy: entry?.sharedBy ?? null })!;
    });

  const create: DriveSharing["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const context = (yield* contexts.contexts).find(
        (candidate) => candidate.id === input.contextId,
      );
      if (context?.kind !== "organization") {
        return yield* refuse("Shared drives belong to a work organization.");
      }
      const owner = yield* me;
      const key = (yield* Effect.orDie(crypto.randomUUIDv4)).replaceAll("-", "");
      const driveId = sharedDriveId(context.id, key);
      yield* directory
        .forDrive(driveId)
        .setup({ name: input.name, members: [{ ...owner, role: "manager" }] });
      return yield* listNow(driveId, owner.userId);
    }).pipe(Effect.catchTags({ SqlError: unavailable, DriveObjectError: unavailable }));

  const members: DriveSharing["Service"]["members"] = (driveId) =>
    Effect.gen(function* () {
      const role = yield* opened(driveId);
      if (parseDriveId(driveId)?.kind === "my") return [{ ...(yield* me), role }];
      return yield* directory.forDrive(driveId).members();
    }).pipe(Effect.catchTags({ SqlError: unavailable, DriveObjectError: unavailable }));

  const grant = (driveId: string, person: DrivePerson, role: SignalboxDriveMember["role"]) =>
    Effect.gen(function* () {
      const changed = yield* directory.forDrive(driveId).share(yield* me, person, role);
      return changed._tag === "ok" ? changed.member : yield* refuse(changed.reason);
    });

  const share: DriveSharing["Service"]["share"] = (input) =>
    Effect.gen(function* () {
      yield* opened(input.driveId);
      const parsed = parseDriveId(input.driveId)!;
      const person = yield* recipient(input.email, parsed.contextId);
      return yield* grant(input.driveId, person, input.role);
    }).pipe(
      Effect.catchTags({
        SqlError: unavailable,
        DriveObjectError: unavailable,
        DrivePeopleError: (error) => refuse(error.message),
      }),
    );

  const unshare: DriveSharing["Service"]["unshare"] = (input) =>
    Effect.gen(function* () {
      yield* opened(input.driveId);
      const removed = yield* directory.forDrive(input.driveId).unshare(yield* me, input.userId);
      if (removed._tag === "refused") return yield* refuse(removed.reason);
    }).pipe(Effect.catchTags({ SqlError: unavailable, DriveObjectError: unavailable }));

  const shareFolder: DriveSharing["Service"]["shareFolder"] = (input) =>
    Effect.gen(function* () {
      const owner = yield* me;
      const parsed = parseDriveId(input.driveId);
      if (parsed?.kind !== "my" || parsed.owner !== owner.userId) {
        return yield* refuse("Share folders from your own My Drive.");
      }
      yield* opened(input.driveId);
      const segments = pathSegments(input.path);
      if (segments === null || segments.length === 0) return yield* refuse("Choose a folder.");
      if (!grantableDriveRoles("folder").includes(input.role)) {
        return yield* refuse("That role doesn't exist on a shared folder.");
      }
      const path = segments.join("/");
      const name = segments.at(-1)!;
      const shortcuts = yield* directory.forDrive(input.driveId).shortcuts();
      const existing = shortcuts.find((shortcut) => shortcut.path === path);
      const outer = shortcuts.find(
        (shortcut) => shortcut.path !== path && isWithin(path, shortcut.path),
      );
      if (outer !== undefined) {
        return yield* refuse(`${path} is inside ${outer.path}, which is shared on its own.`);
      }
      if (shortcuts.some((shortcut) => shortcut.path !== path && isWithin(shortcut.path, path))) {
        return yield* refuse(`A folder inside ${path} is already shared on its own.`);
      }
      // Who it's for first: nothing is split for someone it can't be shared with.
      const person = yield* recipient(input.email, parsed.contextId);
      const targetId =
        existing?.target ??
        folderDriveId(
          parsed.contextId,
          (yield* Effect.orDie(
            crypto
              .digest("SHA-256", new TextEncoder().encode(`${input.driveId}\n${path}`))
              .pipe(Effect.map(Hex.encode)),
          )).slice(0, 32),
        );
      if (existing === undefined) {
        yield* directory.forDrive(targetId).setup({ name, members: [{ ...owner, role: "owner" }] });
        yield* splitFolder({
          sourceId: input.driveId,
          targetId,
          path,
          userId: owner.userId,
        }).pipe(
          Effect.provideService(DriveDirectory, directory),
          Effect.provideService(DrivePacks, packs),
          Effect.catchTags({
            DriveSplitError: (error) => refuse(error.message),
            DriveReadError: unavailable,
            DrivePackError: unavailable,
          }),
        );
      }
      const shared = yield* listNow(targetId, owner.userId);
      yield* grant(targetId, person, input.role);
      return shared;
    }).pipe(
      Effect.catchTags({
        SqlError: unavailable,
        DriveObjectError: unavailable,
        DrivePeopleError: (error) => refuse(error.message),
      }),
    );

  return DriveSharing.of({ create, members, share, unshare, shareFolder });
});

export const layer = Layer.effect(DriveSharing, make);
