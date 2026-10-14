import * as Effect from "effect/Effect";

import * as ConnectionLinks from "../connections/ConnectionLinks.ts";
import { linkedConnections, linkedToken } from "../connections/linkedConnections.ts";
import * as GitHubConnection from "../github/GitHubConnection.ts";
import * as UserPreviewSetup from "../previewSetup/UserPreviewSetup.ts";
import { wire } from "../thread/threadWire.ts";
import { shellSnapshotWire, type UserObjectApi } from "./UserDirectory.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserDriveIndex from "./UserDriveIndex.ts";
import * as UserDrives from "./UserDrives.ts";
import * as UserShell from "./UserShell.ts";
import * as UserStore from "./UserStore.ts";

/**
 * A user object's answers, given a way to run its effects. The Durable Object
 * runs them on its own SQLite database; tests run the same code on an
 * in-memory one. Values with dates travel in their JSON encoding (see
 * `threadWire.ts`).
 */
export const makeUserObjectApi = (
  run: <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | UserStore.UserStore
      | UserShell.UserShell
      | UserContexts.UserContexts
      | GitHubConnection.GitHubConnection
      | ConnectionLinks.ConnectionLinks
      | UserDriveIndex.UserDriveIndex
      | UserDrives.UserDrives
      | UserPreviewSetup.UserPreviewSetup
    >,
  ) => Promise<A>,
): UserObjectApi => {
  const use = <A, E>(f: (store: UserStore.UserStore["Service"]) => Effect.Effect<A, E>) =>
    run(UserStore.UserStore.use(f));
  const shell = <A, E>(f: (service: UserShell.UserShell["Service"]) => Effect.Effect<A, E>) =>
    run(UserShell.UserShell.use(f));
  const github = <A, E>(
    f: (service: GitHubConnection.GitHubConnection["Service"]) => Effect.Effect<A, E>,
  ) => run(GitHubConnection.GitHubConnection.use(f));
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
    shellSnapshot: async () => shellSnapshotWire.encode(await shell((service) => service.snapshot)),
    recordThreadSummary: (summary) =>
      shell((service) => service.recordThreadSummary(wire.summary.decode(summary))),
    rebuildThreadIndex: () => shell((service) => service.rebuildThreadIndex),
    beginGitHubConnect: (input) => github((service) => service.begin(input)),
    completeGitHubConnect: (grantId) => github((service) => service.complete(grantId)),
    abortGitHubConnect: (grantId) => github((service) => service.abort(grantId)),
    disconnectGitHub: () => github((service) => service.disconnect),
    githubAccessToken: () => github((service) => service.accessToken),
    createConnectionLink: (label) =>
      run(ConnectionLinks.ConnectionLinks.use((links) => links.create(label))),
    connectionLinks: () => run(ConnectionLinks.ConnectionLinks.use((links) => links.list)),
    revokeConnectionLink: (id) =>
      run(ConnectionLinks.ConnectionLinks.use((links) => links.revoke(id))),
    linkedConnections: (secret) => run(linkedConnections(secret)),
    linkedToken: (input) => run(linkedToken(input)),
    issuePreviewSetupCode: (input) =>
      run(UserPreviewSetup.UserPreviewSetup.use((setup) => setup.issueCode(input))),
    redeemPreviewSetup: (input) =>
      run(UserPreviewSetup.UserPreviewSetup.use((setup) => setup.redeem(input))),
    importPreviewSetup: (input) =>
      run(UserPreviewSetup.UserPreviewSetup.use((setup) => setup.apply(input))),
    contextIds: () => run(UserDrives.UserDrives.use((drives) => drives.contextIds)),
    recordDriveAccess: (entry) =>
      run(UserDriveIndex.UserDriveIndex.use((index) => index.record(entry))),
    driveAccess: (driveId) => run(UserDrives.UserDrives.use((drives) => drives.access(driveId))),
    readableDrives: () =>
      run(
        Effect.all({
          contexts: UserContexts.UserContexts.use((contexts) => contexts.contexts),
          drives: UserDrives.UserDrives.use((drives) => drives.drives),
        }),
      ),
  };
};
