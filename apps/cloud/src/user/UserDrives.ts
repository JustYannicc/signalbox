import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type {
  SignalboxDrive,
  SignalboxDriveRole,
  SignalboxDrivesSnapshot,
} from "@t3tools/contracts/signalboxDrives";
import { SignalboxDriveId } from "@t3tools/contracts/signalboxDrives";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/sql/SqlError";

import { contextAllows, myDriveId, parseDriveId } from "../drive/driveAccess.ts";
import { DriveDirectory, type DriveObjectError } from "../drive/DriveDirectory.ts";
import { projectIdForContext, projectIdForDrive } from "./contextProjects.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserDriveIndex from "./UserDriveIndex.ts";
import * as UserStore from "./UserStore.ts";

/**
 * The drives one user can open, and whether they can open a given one, in
 * their own object. Access is two questions with two authorities: the user's
 * own contexts say whether they're still in the drive's organization, and the
 * drive says what role they have. Both are asked every time, so leaving an
 * organization or being removed from a drive ends access everywhere at once.
 */

export class UserDrives extends Context.Service<
  UserDrives,
  {
    readonly userId: Effect.Effect<string | null, SqlError>;
    /** Ids of the user's current contexts. */
    readonly contextIds: Effect.Effect<ReadonlyArray<SignalboxContextId>, SqlError>;
    /** Their My Drive in every context, then the drives others gave them, in current contexts. */
    readonly drives: Effect.Effect<ReadonlyArray<SignalboxDrive>, SqlError>;
    readonly changes: Stream.Stream<SignalboxDrivesSnapshot, SqlError>;
    /** Fires after any change to the user's contexts or drives. */
    readonly changed: Stream.Stream<void>;
    /** The user's role in `driveId` right now, or null when they can't open it. */
    readonly access: (
      driveId: string,
    ) => Effect.Effect<SignalboxDriveRole | null, SqlError | DriveObjectError>;
  }
>()("@signalbox/cloud/user/UserDrives") {}

/** A drive someone gave the user, as their drives list shows it; null for an id that names none. */
export const listedDrive = (drive: UserDriveIndex.IndexedDrive): SignalboxDrive | null => {
  const parsed = parseDriveId(drive.driveId);
  return parsed === null
    ? null
    : {
        id: SignalboxDriveId.make(drive.driveId),
        projectId: projectIdForDrive(drive.driveId),
        contextId: parsed.contextId,
        kind: parsed.kind,
        name: drive.name,
        role: drive.role,
        sharedBy: drive.sharedBy,
      };
};

const make = Effect.gen(function* () {
  const store = yield* UserStore.UserStore;
  const contexts = yield* UserContexts.UserContexts;
  const index = yield* UserDriveIndex.UserDriveIndex;
  const directory = yield* Effect.serviceOption(DriveDirectory);

  const userId = Effect.map(store.profile, (profile) => profile?.id ?? null);
  const contextIds = contexts.contextIds;

  const drives: UserDrives["Service"]["drives"] = Effect.gen(function* () {
    const user = yield* userId;
    if (user === null) return [];
    const current = yield* contexts.contexts;
    const ids = current.map((context) => context.id);
    const own = current.map((context): SignalboxDrive => ({
      id: SignalboxDriveId.make(myDriveId(context.id, user)),
      projectId: projectIdForContext(context.id),
      contextId: context.id,
      kind: "my",
      name: "My Drive",
      role: "owner",
      sharedBy: null,
    }));
    const given = (yield* index.drives).flatMap((drive) => {
      const listed = listedDrive(drive);
      return listed === null || !contextAllows(ids, listed.contextId) ? [] : [listed];
    });
    return [...own, ...given];
  });

  const access: UserDrives["Service"]["access"] = (driveId) =>
    Effect.gen(function* () {
      const user = yield* userId;
      const parsed = parseDriveId(driveId);
      if (user === null || parsed === null) return null;
      if (!contextAllows(yield* contextIds, parsed.contextId)) return null;
      // Nobody else is ever in a My Drive; its folders are shared as drives of their own.
      if (parsed.kind === "my") return parsed.owner === user ? "owner" : null;
      if (directory._tag === "None") return null;
      return yield* directory.value.forDrive(driveId).role(user);
    });

  // Contexts fire on drive index changes too (`UserContexts`).
  const changes: UserDrives["Service"]["changes"] = contexts.changes.pipe(
    Stream.mapEffect(() => Effect.map(drives, (current) => ({ drives: current }))),
  );

  return UserDrives.of({
    userId,
    contextIds,
    drives,
    changes,
    changed: contexts.contextsChanged,
    access,
  });
});

export const layer = Layer.effect(UserDrives, make);
