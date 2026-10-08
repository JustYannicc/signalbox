import type * as Effect from "effect/Effect";

import type { DriveObjectApi } from "./DriveDirectory.ts";
import * as DriveMembers from "./DriveMembers.ts";
import * as DriveStore from "./DriveStore.ts";

/**
 * A drive object's answers, given a way to run store effects. Tests run the
 * same code in memory. `afterAccessChange` runs after anything that leaves
 * membership changes to deliver.
 */
export const makeDriveObjectApi = (
  run: <A, E>(
    effect: Effect.Effect<A, E, DriveStore.DriveStore | DriveMembers.DriveMembers>,
  ) => Promise<A>,
  afterAccessChange: () => Promise<void> = async () => {},
): DriveObjectApi => {
  const store = DriveStore.DriveStore;
  const members = DriveMembers.DriveMembers;
  const changingAccess = async <A>(result: Promise<A>) => {
    const value = await result;
    await afterAccessChange();
    return value;
  };
  return {
    open: (writer) => run(store.use((s) => s.open(writer))),
    refs: (threadId, packsAfter) => run(store.use((s) => s.refs(threadId, packsAfter))),
    ref: (name) => run(store.use((s) => s.ref(name))),
    missing: (oids) => run(store.use((s) => s.missing(oids))),
    registerPack: (pack) => run(store.use((s) => s.registerPack(pack))),
    updateRefs: (writer, updates) => run(store.use((s) => s.updateRefs(writer, updates))),
    reconcile: (writer, request) => run(store.use((s) => s.reconcile(writer, request))),
    setRemote: (remote) => run(store.use((s) => s.setRemote(remote))),
    remote: () => run(store.use((s) => s.remote)),
    mirror: (writer, request) => run(store.use((s) => s.mirror(writer, request))),
    locate: (oids) => run(store.use((s) => s.locate(oids))),
    locateAt: (pack, offset) => run(store.use((s) => s.locateAt(pack, offset))),
    commits: (oids) => run(store.use((s) => s.commits(oids))),
    log: (from, limit) => run(store.use((s) => s.log(from, limit))),
    replaceMain: (userId, request) => run(store.use((s) => s.replaceMain(userId, request))),
    shortcuts: () => run(store.use((s) => s.shortcuts)),
    addShortcut: (userId, shortcut) => run(store.use((s) => s.addShortcut(userId, shortcut))),
    removeShortcut: (userId, path) => run(store.use((s) => s.removeShortcut(userId, path))),
    setup: (input) => changingAccess(run(members.use((m) => m.setup(input)))),
    driveName: () => run(members.use((m) => m.name)),
    role: (userId) => run(members.use((m) => m.role(userId))),
    members: () => run(members.use((m) => m.members)),
    share: (by, person, role) => changingAccess(run(members.use((m) => m.share(by, person, role)))),
    unshare: (by, userId) => changingAccess(run(members.use((m) => m.unshare(by, userId)))),
    pendingAccess: () => run(members.use((m) => m.pendingAccess)),
  };
};
