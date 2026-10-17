import * as Effect from "effect/Effect";

import type { DriveObjectApi } from "./DriveDirectory.ts";
import type * as DriveEvents from "./DriveEvents.ts";
import * as DriveMembers from "./DriveMembers.ts";
import * as DrivePacks from "./DrivePacks.ts";
import * as DriveStore from "./DriveStore.ts";

/**
 * A drive object's answers, given a way to run store effects. Tests run the
 * same code in memory. `afterOutboxChange` runs after anything that may leave
 * membership changes or ref moves (`DriveEvents`) to deliver.
 */
export const makeDriveObjectApi = (
  driveId: string,
  run: <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | DriveStore.DriveStore
      | DriveMembers.DriveMembers
      | DriveEvents.DriveEvents
      | DrivePacks.DrivePacks
    >,
  ) => Promise<A>,
  afterOutboxChange: () => Promise<void> = async () => {},
): DriveObjectApi => {
  const store = DriveStore.DriveStore;
  const members = DriveMembers.DriveMembers;
  const packs = DrivePacks.DrivePacks;
  const changingOutbox = async <A>(result: Promise<A>) => {
    const value = await result;
    await afterOutboxChange();
    return value;
  };
  return {
    open: (writer) => run(store.use((s) => s.open(writer))),
    refs: (threadId, packsAfter) => run(store.use((s) => s.refs(threadId, packsAfter))),
    ref: (name) => run(store.use((s) => s.ref(name))),
    missing: (oids, visibleTo) => run(store.use((s) => s.missing(oids, visibleTo))),
    promised: (oids) => run(store.use((s) => s.promised(oids))),
    registerPack: (pack) => run(store.use((s) => s.registerPack(pack))),
    // Only a thread's branch counts as a change; auto-saves and machine state don't.
    updateRefs: (writer, updates) => {
      const moved = run(store.use((s) => s.updateRefs(writer, updates)));
      return updates.some((update) => update.name === DriveStore.threadRef(writer.threadId))
        ? changingOutbox(moved)
        : moved;
    },
    reconcile: (writer, request) =>
      changingOutbox(run(store.use((s) => s.reconcile(writer, request)))),
    setRemote: (remote) => run(store.use((s) => s.setRemote(remote))),
    remote: () => run(store.use((s) => s.remote)),
    mirror: (writer, request) => changingOutbox(run(store.use((s) => s.mirror(writer, request)))),
    locate: (oids) => run(store.use((s) => s.locate(oids))),
    locateAt: (pack, offset) => run(store.use((s) => s.locateAt(pack, offset))),
    commits: (oids) => run(store.use((s) => s.commits(oids))),
    log: (from, limit) => run(store.use((s) => s.log(from, limit))),
    replaceMain: (userId, request) =>
      changingOutbox(run(store.use((s) => s.replaceMain(userId, request)))),
    shortcuts: () => run(store.use((s) => s.shortcuts)),
    addShortcut: (userId, shortcut) => run(store.use((s) => s.addShortcut(userId, shortcut))),
    removeShortcut: (userId, path) => run(store.use((s) => s.removeShortcut(userId, path))),
    unreconciled: (input) => run(store.use((s) => s.unreconciled(input))),
    setup: (input) => changingOutbox(run(members.use((m) => m.setup(input)))),
    driveName: () => run(members.use((m) => m.name)),
    role: (userId) => run(members.use((m) => m.role(userId))),
    members: () => run(members.use((m) => m.members)),
    share: (by, person, role) => changingOutbox(run(members.use((m) => m.share(by, person, role)))),
    unshare: (by, userId) => changingOutbox(run(members.use((m) => m.unshare(by, userId)))),
    pendingAccess: () => run(members.use((m) => m.pendingAccess)),
    purgeThread: (input) =>
      run(
        Effect.gen(function* () {
          const receipt = yield* store.use((s) => s.purgeThread(input));
          yield* packs.use((p) =>
            p.writePurgeManifest({
              driveId,
              purgeId: input.purgeId,
              stage: "purge",
              contents: new TextEncoder().encode(
                JSON.stringify({ schemaVersion: 1, stage: "purge", receipt }),
              ),
            }),
          );
          return receipt;
        }),
      ),
    collectPurgedPacks: (purgeId, now, limit) =>
      run(
        Effect.gen(function* () {
          const names = yield* store.use((s) => s.claimPurgedPacks(purgeId, now, limit));
          if (names === null) return null;
          if (names.length > 0) {
            yield* packs
              .use((p) => p.remove(driveId, names))
              .pipe(
                Effect.catchCause((cause) =>
                  store
                    .use((s) => s.releasePurgedPacks(purgeId, names))
                    .pipe(Effect.andThen(Effect.failCause(cause))),
                ),
              );
          }
          const receipt =
            names.length === 0
              ? yield* store.use((s) => s.purgeReceipt(purgeId))
              : yield* store.use((s) => s.finishPurgedPacks(purgeId, names));
          if (receipt === null) return null;
          yield* packs.use((p) =>
            p.writePurgeManifest({
              driveId,
              purgeId,
              stage: "gc",
              contents: new TextEncoder().encode(
                JSON.stringify({ schemaVersion: 1, stage: "gc", receipt }),
              ),
            }),
          );
          return receipt;
        }),
      ),
  };
};
