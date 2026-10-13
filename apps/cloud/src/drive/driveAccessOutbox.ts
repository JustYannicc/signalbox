import * as Effect from "effect/Effect";

import * as UserDirectory from "../user/UserDirectory.ts";
import * as DriveMembers from "./DriveMembers.ts";

/**
 * Delivers a drive's membership changes to each person's own object, which
 * lists the drives they can open (their Shared with me). Each delivery carries
 * the member's revision, so a repeat or a late one changes nothing. Access
 * itself never waits on this: every check asks the drive.
 *
 * True when everything pending was delivered.
 */
export const deliverAccess = (driveId: string) =>
  Effect.gen(function* () {
    const members = yield* DriveMembers.DriveMembers;
    const users = yield* UserDirectory.UserDirectory;
    const pending = yield* Effect.orDie(members.pendingAccess);
    if (pending.length === 0) return true;
    const name = yield* Effect.orDie(members.name);
    const results = yield* Effect.forEach(
      pending,
      (entry) =>
        users
          .forUser(entry.userId)
          .recordDriveAccess({
            driveId,
            name: name ?? "Drive",
            role: entry.role,
            sharedBy: entry.sharedBy,
            revision: entry.revision,
          })
          .pipe(
            Effect.andThen(Effect.orDie(members.acknowledgeAccess(entry.userId, entry.revision))),
            Effect.as(true),
            Effect.catchTags({
              UserObjectError: (error) =>
                Effect.logWarning("drive access delivery failed", { cause: error.cause }).pipe(
                  Effect.as(false),
                ),
            }),
          ),
      { concurrency: 4 },
    );
    return results.every(Boolean);
  });
