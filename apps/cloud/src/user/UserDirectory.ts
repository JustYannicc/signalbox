import {
  type AuthEnvironmentScope,
  OrchestrationV2ShellSnapshot,
  type ServerAuthSessionMethod,
} from "@t3tools/contracts";
import type { WorkOSOrganization } from "@signalbox/account/WorkOSClient";
import type { ToolResult } from "@signalbox/runner-protocol/AutomationProtocol";
import type { PublishRequest, PublishResult } from "@signalbox/runner-protocol/BranchProtocol";
import type {
  BrowserSessionAnswer,
  BrowserSignInAnswer,
} from "@signalbox/runner-protocol/BrowserProtocol";
import type { CommitAuthor } from "@signalbox/runner-protocol/DriveProtocol";
import type { AccountProfile } from "@t3tools/contracts/account";
import type { SignalboxContext, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type { SignalboxDrive, SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import type { SignInSource } from "@t3tools/contracts/signalboxSignIn";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { AutomationHostCall } from "../automations/CloudAutomations.ts";
import type { HookAnswer, HookRequest } from "../automations/webhookRequest.ts";
import type { ConnectionLink, CreatedLink } from "../connections/ConnectionLinks.ts";
import type {
  LinkedConnections,
  LinkedProvider,
  LinkedToken,
} from "../connections/linkedConnections.ts";
import type { ConnectResult, ConnectStart } from "../github/GitHubConnection.ts";
import { API_HEADER, type ApiCredential, encodeApiCredential } from "../api/apiObject.ts";
import type { CreatedKey, KeyOptions } from "../localKeys/LocalKeys.ts";
import type { LocalKeysView } from "../localKeys/localModelAccess.ts";
import type { LocalModelAuthorization } from "../models/ModelProtocol.ts";
import type { ModelUsage } from "../modelGateway/modelGatewayRecord.ts";
import type { PreviewSetup } from "../previewSetup/previewSetupWire.ts";
import type { SignInCheck } from "../signIn/SignInGrants.ts";
import type {
  PreviewSetupApplied,
  PreviewSetupRedemption,
} from "../previewSetup/UserPreviewSetup.ts";
import { jsonCodec } from "../thread/threadWire.ts";
import type { DriveAccessEntry } from "./UserDriveIndex.ts";
import type { GrantKind, HandoffRedemption, SessionRecord } from "./UserStore.ts";

/**
 * How the Worker reaches one user's Durable Object. Every WorkOS user has
 * exactly one, named by their WorkOS user id and always created in the EU
 * jurisdiction. Calls are Durable Object RPC; the object runs them against its
 * own SQLite database (see `UserObject.ts`).
 */

export const USER_OBJECT_JURISDICTION = "eu";

/**
 * Carries an upgraded socket's session from the Worker to the object. Objects
 * are not reachable from the internet, so only the Worker can set it.
 */
export const CONNECTION_HEADER = "x-signalbox-connection";

const ConnectionInfo = Schema.Struct({ sid: Schema.String });
const encodeConnectionInfo = Schema.encodeSync(Schema.fromJsonString(ConnectionInfo));
export const decodeConnectionInfo = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionInfo));

export class UserObjectError extends Schema.TaggedError<UserObjectError>()("UserObjectError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `User object call failed (${this.operation}).`;
  }
}

/** The shell crosses Durable Object RPC in its JSON encoding, which keeps its dates. */
export const shellSnapshotWire = jsonCodec(OrchestrationV2ShellSnapshot);

/** What a user's object answers. `UserObject` implements it method for method. */
export interface UserObjectApi {
  readonly receiveHook: (request: HookRequest) => Promise<HookAnswer>;
  readonly recordSignIn: (profile: AccountProfile) => Promise<void>;
  readonly profile: () => Promise<AccountProfile | null>;
  readonly createSession: (input: {
    readonly method: ServerAuthSessionMethod;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly label?: string;
    readonly ttlMs: number;
  }) => Promise<SessionRecord>;
  readonly findSession: (sid: string) => Promise<SessionRecord | null>;
  readonly revokeSession: (sid: string) => Promise<boolean>;
  readonly issueGrant: (input: {
    readonly kind: GrantKind;
    readonly challenge?: string;
    readonly ttlMs: number;
  }) => Promise<{ readonly gid: string; readonly expiresAt: number }>;
  readonly redeemHandoff: (input: {
    readonly gid: string;
    readonly challenge: string;
    readonly credentialTtlMs: number;
  }) => Promise<HandoffRedemption>;
  readonly exchangeCredential: (input: {
    readonly gid: string;
    readonly method: ServerAuthSessionMethod;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly label?: string;
    readonly ttlMs: number;
  }) => Promise<SessionRecord | null>;
  /** Makes the user's work contexts exactly these organizations (see `UserContexts`). */
  readonly syncOrganizations: (organizations: ReadonlyArray<WorkOSOrganization>) => Promise<void>;
  /**
   * The user's sidebar, as `GET /api/orchestration/shell` and `subscribeShell`
   * serve it, in its JSON encoding (`shellSnapshotWire`).
   */
  readonly shellSnapshot: () => Promise<unknown>;
  /** A thread object's summary outbox delivery, in its JSON encoding. */
  readonly recordThreadSummary: (summary: unknown) => Promise<void>;
  /** A thread object's terminal outbox delivery, in `terminalSync.wire.delivery` encoding. */
  readonly recordTerminalEvents: (encoded: unknown) => Promise<void>;
  /**
   * A thread object's event outbox delivery (`thread/eventOutbox.ts`): the
   * user's thread's next domain events with their sequence, in order and in
   * their JSON encoding (`wire.events`), for the user's automations. Returns
   * once they're taken; a throw has the thread send them again.
   */
  readonly threadEvents: (input: {
    readonly threadId: string;
    readonly events: unknown;
  }) => Promise<void>;
  /**
   * A drive object's event outbox delivery (`drive/driveEventOutbox.ts`): the
   * drive's next ref moves (`DriveRefEvent`s) in order, for the user's
   * automations. Returns once they're taken; a throw has the drive send them again.
   */
  readonly driveEvents: (input: {
    readonly driveId: string;
    readonly events: ReadonlyArray<unknown>;
  }) => Promise<void>;
  /** Drops the thread index and rebuilds it from the user's thread objects. */
  readonly rebuildThreadIndex: () => Promise<number>;
  /** Starts connecting GitHub (`github/GitHubConnection.ts`); WorkOS comes back to `returnTo`. */
  readonly beginGitHubConnect: (input: {
    readonly grantId: string;
    readonly returnTo: string;
  }) => Promise<ConnectStart>;
  readonly completeGitHubConnect: (grantId: string) => Promise<ConnectResult>;
  /** Ends a connect attempt that came back in another browser, and what it connected. */
  readonly abortGitHubConnect: (grantId: string) => Promise<void>;
  readonly disconnectGitHub: () => Promise<void>;
  /** A token acting as the user on GitHub now, or null when not connected. */
  readonly githubAccessToken: () => Promise<string | null>;
  /** A new link for a tool outside Signalbox (`connections/ConnectionLinks.ts`). */
  readonly createConnectionLink: (label: string) => Promise<CreatedLink>;
  readonly connectionLinks: () => Promise<ReadonlyArray<ConnectionLink>>;
  readonly revokeConnectionLink: (id: string) => Promise<void>;
  /** What a link may see (`connections/connectionRoutes.ts`). */
  readonly linkedConnections: (secret: string) => Promise<LinkedConnections>;
  readonly linkedToken: (input: {
    readonly secret: string;
    readonly provider: LinkedProvider;
  }) => Promise<LinkedToken>;
  /** A new key for the harnesses on one of the user's computers (`localKeys/LocalKeys.ts`). */
  readonly createLocalKey: (label: string, options?: KeyOptions) => Promise<CreatedKey>;
  readonly localKeys: () => Promise<LocalKeysView>;
  readonly revokeLocalKey: (id: string) => Promise<void>;
  /** A ModelGateway request with a local key: which pool it may use (`localKeys/localModelAccess.ts`). */
  readonly authorizeLocalModel: (secret: string) => Promise<LocalModelAuthorization>;
  readonly recordLocalModelRequest: (input: {
    readonly keyId: string;
    readonly usage: ModelUsage | null;
  }) => Promise<void>;
  /** Production: a one-time claim on this user's setup for a preview (`previewSetup/`). */
  readonly issuePreviewSetupCode: (input: {
    readonly origin: string;
    readonly challenge: string;
  }) => Promise<{ readonly gid: string; readonly expiresAt: number }>;
  readonly redeemPreviewSetup: (input: {
    readonly gid: string;
    readonly origin: string;
    readonly challenge: string;
  }) => Promise<PreviewSetupRedemption>;
  /** A preview: takes in the setup production handed over. */
  readonly importPreviewSetup: (input: {
    readonly setup: PreviewSetup;
    readonly source: string;
  }) => Promise<PreviewSetupApplied>;
  /** Who the user's agents commit as, from their GitHub connection; null when not connected. */
  readonly githubCommitAuthor: () => Promise<CommitAuthor | null>;
  /**
   * The user's 1Password service account token, or null when none is
   * connected: only for their thread's machine (`ThreadRunner`'s `ThreadSecrets`).
   */
  readonly onePasswordToken: () => Promise<string | null>;
  /** The user's current contexts, which every thread call acts within. */
  readonly contextIds: () => Promise<ReadonlyArray<SignalboxContextId>>;
  /** A drive object's membership delivery (`drive/driveAccessOutbox.ts`). Idempotent. */
  readonly recordDriveAccess: (entry: DriveAccessEntry) => Promise<void>;
  /** The user's role in a drive right now, or null when they can't open it (`UserDrives`). */
  readonly driveAccess: (driveId: string) => Promise<SignalboxDriveRole | null>;
  /** The user's current contexts and every drive they can open in them (`UserDrives`). */
  readonly readableDrives: () => Promise<{
    readonly contexts: ReadonlyArray<SignalboxContext>;
    readonly drives: ReadonlyArray<SignalboxDrive>;
  }>;
  /** Pushes a thread's branch for its agent, as the git panel does (`drive/branchRoutes.ts`). */
  readonly publishBranch: (input: {
    readonly threadId: string;
    readonly driveId: string;
    readonly request: PublishRequest;
  }) => Promise<PublishResult>;
  /**
   * An automation tool a thread's agent called from its machine, for that
   * thread (`drive/automationRoutes.ts`). The engine's refusal is an answer.
   */
  readonly automationTool: (threadId: string, name: string, input: unknown) => Promise<ToolResult>;
  /**
   * What's going on in a thread's home folder, for its agent
   * (`drive/statusLineRoutes.ts`, `UserThreadStatus`), as `statusLineJson.folder` text.
   */
  readonly folderStatus: (threadId: string) => Promise<string>;
  /**
   * The person's browser for a thread's running turn (`drive/browserRoutes.ts`,
   * `browser/PersonBrowsers.ts`): its session, or a refusal in words.
   */
  readonly browserSession: (input: {
    readonly threadId: string;
    readonly requester: string;
  }) => Promise<BrowserSessionAnswer>;
  /**
   * The thread's agent signing in to `site` (#576, `signIn/LoginService.ts`):
   * the person's profile signed in from 1Password under a grant, answered as
   * a status only.
   */
  readonly browserSignIn: (input: {
    readonly threadId: string;
    readonly requester: string;
    readonly site: string;
  }) => Promise<BrowserSignInAnswer>;
  /**
   * The login service's check before signing a turn in (#575, #576): whether
   * a standing grant of this person's covers `origin` for `source`. Their
   * own 1Password answers only turns they requested; a folder's grants
   * decide for its turns whoever is talking.
   */
  readonly checkSignIn: (input: {
    readonly requester: string;
    readonly source: SignInSource;
    readonly origin: string;
  }) => Promise<SignInCheck>;
  /** Ends the thread's session in the person's browser, which saves its profile. */
  readonly endBrowser: (input: {
    readonly threadId: string;
    readonly sessionId: string;
  }) => Promise<void>;
  /**
   * A run's Workflow instance calling back (`automations/automationWorkflow.ts`).
   * Rejects for the instance to retry when the step can't start yet.
   */
  readonly automationHost: (call: AutomationHostCall) => Promise<unknown>;
  /** A version's code, for the dispatcher loading it as a Dynamic Worker. */
  readonly automationWorkerModule: (automationId: string, version: number) => Promise<string>;
  /**
   * The idle-chat sweep as of `asOfMs` instead of now, for previews' test
   * clock (`http/threadKindRoutes.ts`). What it archived.
   */
  readonly sweepThreadKinds: (
    asOfMs: number,
  ) => Promise<{ readonly archived: ReadonlyArray<string> }>;
}

type Method = keyof UserObjectApi;

export type UserHandle = {
  readonly [K in Exclude<Method, "shellSnapshot">]: (
    ...args: Parameters<UserObjectApi[K]>
  ) => Effect.Effect<Awaited<ReturnType<UserObjectApi[K]>>, UserObjectError>;
} & {
  readonly shellSnapshot: () => Effect.Effect<OrchestrationV2ShellSnapshot, UserObjectError>;
};

export class UserDirectory extends Context.Service<
  UserDirectory,
  {
    readonly forUser: (userId: string) => UserHandle;
    /**
     * Forwards a WebSocket upgrade to the session owner's object, which checks
     * the session against its own record and serves it with that record's scopes.
     */
    readonly connect: (
      session: { readonly userId: string; readonly sessionId: string },
      request: Request,
    ) => Effect.Effect<Response, UserObjectError>;
    /**
     * Hands a public API call to the user's object (`api/apiObject.ts`). The
     * Worker checked only the credential's signature; the object checks the rest.
     */
    readonly callApi: (
      userId: string,
      request: Request,
      credential: ApiCredential,
    ) => Effect.Effect<Response, UserObjectError>;
  }
>()("@signalbox/cloud/user/UserDirectory") {}

// A record, so adding a method to `UserObjectApi` without wrapping it fails to compile.
const METHODS = Object.keys({
  recordSignIn: true,
  profile: true,
  createSession: true,
  findSession: true,
  revokeSession: true,
  issueGrant: true,
  redeemHandoff: true,
  exchangeCredential: true,
  syncOrganizations: true,
  shellSnapshot: true,
  recordThreadSummary: true,
  recordTerminalEvents: true,
  threadEvents: true,
  driveEvents: true,
  receiveHook: true,
  rebuildThreadIndex: true,
  beginGitHubConnect: true,
  completeGitHubConnect: true,
  abortGitHubConnect: true,
  disconnectGitHub: true,
  githubAccessToken: true,
  createConnectionLink: true,
  connectionLinks: true,
  revokeConnectionLink: true,
  linkedConnections: true,
  createLocalKey: true,
  localKeys: true,
  revokeLocalKey: true,
  authorizeLocalModel: true,
  recordLocalModelRequest: true,
  linkedToken: true,
  issuePreviewSetupCode: true,
  redeemPreviewSetup: true,
  importPreviewSetup: true,
  githubCommitAuthor: true,
  onePasswordToken: true,
  contextIds: true,
  recordDriveAccess: true,
  driveAccess: true,
  readableDrives: true,
  publishBranch: true,
  automationTool: true,
  folderStatus: true,
  browserSession: true,
  browserSignIn: true,
  checkSignIn: true,
  endBrowser: true,
  automationHost: true,
  automationWorkerModule: true,
  sweepThreadKinds: true,
} satisfies Record<Method, true>) as ReadonlyArray<Method>;

/** Results that cross RPC encoded, decoded on arrival. */
const DECODERS: Partial<Record<Method, (value: unknown) => unknown>> = {
  shellSnapshot: shellSnapshotWire.decode,
};

/** Wraps any `UserObjectApi` (a Durable Object stub, or a test double) as Effects. */
export function handleFor(api: UserObjectApi): UserHandle {
  const call =
    (operation: Method) =>
    (...args: ReadonlyArray<unknown>) =>
      Effect.tryPromise({
        try: async () => {
          const result = await (
            api[operation] as (...input: ReadonlyArray<unknown>) => Promise<unknown>
          )(...args);
          const decode = DECODERS[operation];
          return decode ? decode(result) : result;
        },
        catch: (cause) => new UserObjectError({ operation, cause }),
      });
  return Object.fromEntries(METHODS.map((method) => [method, call(method)])) as UserHandle;
}

/** The `fetch` and RPC surface of a user object stub, as the Worker sees it. */
export type UserObjectStub = UserObjectApi & {
  readonly fetch: (request: Request) => Promise<Response>;
};

/** The slice of the `USERS` Durable Object namespace binding the Worker uses. */
export interface UserObjectNamespace {
  readonly idFromName: (name: string) => DurableObjectId;
  readonly jurisdiction: (name: typeof USER_OBJECT_JURISDICTION) => {
    readonly idFromName: (name: string) => DurableObjectId;
  };
  readonly get: (id: DurableObjectId) => UserObjectStub;
}

/**
 * `localWorkerd`: local workerd has no jurisdictions, so `wrangler dev` names
 * objects in the plain namespace. Deployments always use the EU one.
 */
export const userObjectStub = (
  namespace: UserObjectNamespace,
  userId: string,
  options: { readonly localWorkerd: boolean },
) => {
  const ids = options.localWorkerd ? namespace : namespace.jurisdiction(USER_OBJECT_JURISDICTION);
  return namespace.get(ids.idFromName(userId));
};

export const layerDurableObjects = (
  namespace: UserObjectNamespace,
  options: { readonly localWorkerd: boolean },
) => {
  const stubFor = (userId: string) => userObjectStub(namespace, userId, options);
  return Layer.succeed(
    UserDirectory,
    UserDirectory.of({
      forUser: (userId) => handleFor(stubFor(userId)),
      connect: (session, request) =>
        Effect.tryPromise({
          try: () => {
            const headers = new Headers(request.headers);
            // Only `callApi` may say a request is an API call; a client can't.
            headers.delete(API_HEADER);
            headers.set(CONNECTION_HEADER, encodeConnectionInfo({ sid: session.sessionId }));
            return stubFor(session.userId).fetch(new Request(request, { headers }));
          },
          catch: (cause) => new UserObjectError({ operation: "connect", cause }),
        }),
      callApi: (userId, request, credential) =>
        Effect.tryPromise({
          try: () => {
            const headers = new Headers(request.headers);
            headers.set(API_HEADER, encodeApiCredential(credential));
            return stubFor(userId).fetch(new Request(request, { headers }));
          },
          catch: (cause) => new UserObjectError({ operation: "callApi", cause }),
        }),
    }),
  );
};
