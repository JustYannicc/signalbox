import type * as Effect from "effect/Effect";

import * as Environment from "../environment.ts";
import type { UserObjectApi } from "./UserDirectory.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserStore from "./UserStore.ts";

/**
 * A user object's answers, given a way to run store effects. The Durable
 * Object runs them on its own SQLite database; tests run the same code on an
 * in-memory one.
 */
export const makeUserObjectApi = (
  run: <A, E>(
    effect: Effect.Effect<A, E, UserStore.UserStore | UserContexts.UserContexts>,
  ) => Promise<A>,
): UserObjectApi => {
  const use = <A, E>(f: (store: UserStore.UserStore["Service"]) => Effect.Effect<A, E>) =>
    run(UserStore.UserStore.use(f));
  return {
    recordSignIn: (profile) => use((store) => store.recordSignIn(profile)),
    profile: () => use((store) => store.profile),
    createSession: (input) => use((store) => store.createSession(input)),
    findSession: (sid) => use((store) => store.findSession(sid)),
    revokeSession: (sid) => use((store) => store.revokeSession(sid)),
    issueGrant: (input) => use((store) => store.issueGrant(input)),
    redeemHandoff: (input) => use((store) => store.redeemHandoff(input)),
    exchangeCredential: (input) => use((store) => store.exchangeCredential(input)),
    syncOrganizations: (organizations) =>
      run(UserContexts.UserContexts.use((contexts) => contexts.syncOrganizations(organizations))),
    shellSnapshot: async () => Environment.emptyShellSnapshot,
  };
};
