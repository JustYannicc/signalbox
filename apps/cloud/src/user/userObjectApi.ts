import { statusLineJson } from "@signalbox/runner-protocol/StatusLineProtocol";
import { AutomationError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { automationTool } from "../automations/automationTool.ts";
import * as PersonBrowsers from "../browser/PersonBrowsers.ts";
import * as CloudAutomations from "../automations/CloudAutomations.ts";
import * as ConnectionLinks from "../connections/ConnectionLinks.ts";
import { DriveRefEvent } from "../drive/DriveEvents.ts";
import { linkedConnections, linkedToken } from "../connections/linkedConnections.ts";
import { publishBranch } from "../github/branchPublishing.ts";
import type * as GitHubBranches from "../github/GitHubBranches.ts";
import * as GitHubConnection from "../github/GitHubConnection.ts";
import * as LocalKeys from "../localKeys/LocalKeys.ts";
import * as LoginService from "../signIn/LoginService.ts";
import * as SignInGrants from "../signIn/SignInGrants.ts";
import { authorizeExecutorToken as authorizeExecutorTokenNow } from "../executor/ExecutorTokenAuthority.ts";
import type { ExecutorTokenBinding } from "../executor/ExecutorTokenBindings.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import {
  authorizeLocalModel,
  localKeysView,
  recordLocalModelRequest,
} from "../localKeys/localModelAccess.ts";
import * as UserPreviewSetup from "../previewSetup/UserPreviewSetup.ts";
import { wire } from "../thread/threadWire.ts";
import { shellSnapshotWire, type UserObjectApi } from "./UserDirectory.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserFolders from "./UserFolders.ts";
import * as DrivePeople from "./DrivePeople.ts";
import * as OnePasswordAccount from "./OnePasswordAccount.ts";
import * as UserDriveIndex from "./UserDriveIndex.ts";
import * as UserDrives from "./UserDrives.ts";
import * as ResourceBindings from "./ResourceBindings.ts";
import * as UserShell from "./UserShell.ts";
import * as UserStore from "./UserStore.ts";
import * as UserThreadKinds from "./UserThreadKinds.ts";
import * as UserThreadStatus from "./UserThreadStatus.ts";

const decodeDriveEvents = Schema.decodeUnknownSync(Schema.Array(DriveRefEvent));

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
      | GitHubBranches.GitHubBranches
      | UserThreadKinds.UserThreadKinds
      | UserThreadStatus.UserThreadStatus
      | LocalKeys.LocalKeys
      | ResourceBindings.ResourceBindings
      | OnePasswordAccount.OnePasswordAccount
      | PersonBrowsers.PersonBrowsers
      | SignInGrants.SignInGrants
      | LoginService.LoginService
      | ThreadDirectory.ThreadDirectory
      | UserFolders.UserFolders
      | DrivePeople.DrivePeople
      | CloudAutomations.CloudAutomations
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
  /** A run's instance calling in; a rejection is its cue to retry. */
  const withAutomations = <A>(
    f: (
      automations: CloudAutomations.CloudAutomations["Service"],
    ) => Effect.Effect<A, AutomationError>,
  ) =>
    Effect.flatMap(Effect.serviceOption(CloudAutomations.CloudAutomations), (automations) =>
      Option.isNone(automations)
        ? Effect.fail(new AutomationError({ message: "Automations aren't running in this cloud." }))
        : f(automations.value),
    );
  return {
    receiveHook: (request) =>
      run(withAutomations((automations) => automations.receiveHook(request))),
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
    recordThreadSummary: (encoded) => {
      const summary = wire.summary.decode(encoded);
      return run(
        Effect.flatMap(UserShell.UserShell, (shell) =>
          UserThreadKinds.UserThreadKinds.use((kinds) =>
            kinds.recordSummary(summary, shell.recordThreadSummary(summary)),
          ),
        ).pipe(
          // Its status note (#670), once the index has the row it joins.
          Effect.andThen(
            UserThreadStatus.UserThreadStatus.use((status) => status.recordSummary(summary)),
          ),
        ),
      );
    },
    // An object without automations yet takes the events and drops them.
    threadEvents: ({ threadId, events }) =>
      run(
        Effect.flatMap(Effect.serviceOption(CloudAutomations.CloudAutomations), (automations) =>
          Option.isNone(automations)
            ? Effect.void
            : automations.value.threadEvents({ threadId, events: wire.events.decode(events) }),
        ).pipe(
          // Ids only, never what happened (#284).
          Effect.withSpan("UserObject.threadEvents", { attributes: { "thread.id": threadId } }),
        ),
      ),
    driveEvents: ({ driveId, events }) =>
      run(
        Effect.flatMap(Effect.serviceOption(CloudAutomations.CloudAutomations), (automations) =>
          Option.isNone(automations)
            ? Effect.void
            : automations.value.driveEvents({ driveId, events: decodeDriveEvents(events) }),
        ).pipe(
          // Ids only, never what changed (#284).
          Effect.withSpan("UserObject.driveEvents", { attributes: { "drive.id": driveId } }),
        ),
      ),
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
    createLocalKey: (label, options) =>
      run(LocalKeys.LocalKeys.use((keys) => keys.create(label, options))),
    localKeys: () => run(localKeysView),
    revokeLocalKey: (id) => run(LocalKeys.LocalKeys.use((keys) => keys.revoke(id))),
    authorizeLocalModel: (secret) => run(authorizeLocalModel(secret)),
    recordLocalModelRequest: (input) => run(recordLocalModelRequest(input)),
    issuePreviewSetupCode: (input) =>
      run(UserPreviewSetup.UserPreviewSetup.use((setup) => setup.issueCode(input))),
    redeemPreviewSetup: (input) =>
      run(UserPreviewSetup.UserPreviewSetup.use((setup) => setup.redeem(input))),
    importPreviewSetup: (input) =>
      run(UserPreviewSetup.UserPreviewSetup.use((setup) => setup.apply(input))),
    githubCommitAuthor: () => github((service) => service.commitAuthor),
    onePasswordToken: () =>
      run(OnePasswordAccount.OnePasswordAccount.use((account) => account.token)),
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
    publishBranch: (input) => run(publishBranch(input)),
    automationTool: (threadId, name, input) => run(automationTool(threadId, name, input)),
    folderStatus: (threadId) =>
      run(
        UserThreadStatus.UserThreadStatus.use((status) =>
          status.folderStatus(ThreadId.make(threadId)),
        ).pipe(Effect.map(statusLineJson.folder.encode)),
      ),
    browserSession: (input) =>
      run(PersonBrowsers.PersonBrowsers.use((browsers) => browsers.open(input))),
    browserSignIn: (input) => run(LoginService.LoginService.use((logins) => logins.signIn(input))),
    checkSignIn: (input) => run(SignInGrants.SignInGrants.use((grants) => grants.check(input))),
    authorizeExecutorToken: (claims, binding: ExecutorTokenBinding) =>
      run(authorizeExecutorTokenNow(claims, binding)),
    endBrowser: (input) =>
      run(PersonBrowsers.PersonBrowsers.use((browsers) => browsers.end(input))),
    automationHost: (call) => run(withAutomations((automations) => automations.host(call))),
    automationWorkerModule: (automationId, version) =>
      run(withAutomations((automations) => automations.workerModule(automationId, version))),
    sweepThreadKinds: async (asOfMs) => {
      const { archived } = await run(
        UserThreadKinds.UserThreadKinds.use((kinds) => kinds.sweep(asOfMs)),
      );
      return { archived };
    },
  };
};
