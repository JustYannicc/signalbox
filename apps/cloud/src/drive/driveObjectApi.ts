import type * as Effect from "effect/Effect";

import type { DriveObjectApi } from "./DriveDirectory.ts";
import type * as DriveEvents from "./DriveEvents.ts";
import * as DriveMembers from "./DriveMembers.ts";
import * as DriveStore from "./DriveStore.ts";

/**
 * A drive object's answers, given a way to run store effects. Tests run the
 * same code in memory. `afterOutboxChange` runs after anything that may leave
 * membership changes or ref moves (`DriveEvents`) to deliver.
 */
export const makeDriveObjectApi = (
  run: <A, E>(
    effect: Effect.Effect<
      A,
      E,
      DriveStore.DriveStore | DriveMembers.DriveMembers | DriveEvents.DriveEvents
    >,
  ) => Promise<A>,
  afterOutboxChange: () => Promise<void> = async () => {},
): DriveObjectApi => {
  const store = DriveStore.DriveStore;
  const members = DriveMembers.DriveMembers;
  const changingOutbox = async <A>(result: Promise<A>) => {
    const value = await result;
    await afterOutboxChange();
    return value;
  };
  return {
    beginPublication: (userId, request) =>
      run(store.use((s) => s.beginPublication(userId, request))),
    markPublicationCreating: (userId, id) =>
      run(store.use((s) => s.markPublicationCreating(userId, id))),
    releasePublicationCreating: (userId, id) =>
      run(store.use((s) => s.releasePublicationCreating(userId, id))),
    recordPublicationCreated: (userId, request) =>
      run(store.use((s) => s.recordPublicationCreated(userId, request))),
    bindPublication: (userId, request) => run(store.use((s) => s.bindPublication(userId, request))),
    finishPublication: (userId, id) => run(store.use((s) => s.finishPublication(userId, id))),
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
    recordCheckpoint: (writer, record) => run(store.use((s) => s.recordCheckpoint(writer, record))),
    checkpoint: (threadId, runId) => run(store.use((s) => s.checkpoint(threadId, runId))),
    forkCheckpoint: (userId, request) => run(store.use((s) => s.forkCheckpoint(userId, request))),
    restoreCheckpoint: (userId, request) =>
      changingOutbox(run(store.use((s) => s.restoreCheckpoint(userId, request)))),
    undoRestore: (userId, request) =>
      changingOutbox(run(store.use((s) => s.undoRestore(userId, request)))),
    updateToLatest: (userId, request) => run(store.use((s) => s.updateToLatest(userId, request))),
    setup: (input) => changingOutbox(run(members.use((m) => m.setup(input)))),
    driveName: () => run(members.use((m) => m.name)),
    role: (userId) => run(members.use((m) => m.role(userId))),
    members: () => run(members.use((m) => m.members)),
    share: (by, person, role) => changingOutbox(run(members.use((m) => m.share(by, person, role)))),
    unshare: (by, userId) => changingOutbox(run(members.use((m) => m.unshare(by, userId)))),
    pendingAccess: () => run(members.use((m) => m.pendingAccess)),
  };
};
