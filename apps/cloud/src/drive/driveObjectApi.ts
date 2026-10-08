import type * as Effect from "effect/Effect";

import type { DriveObjectApi } from "./DriveDirectory.ts";
import * as DriveStore from "./DriveStore.ts";

/** A drive object's answers, given a way to run store effects. Tests run the same code in memory. */
export const makeDriveObjectApi = (
  run: <A, E>(effect: Effect.Effect<A, E, DriveStore.DriveStore>) => Promise<A>,
): DriveObjectApi => {
  const store = DriveStore.DriveStore;
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
  };
};
