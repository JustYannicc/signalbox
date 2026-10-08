import {
  type AuthEnvironmentScope,
  OrchestrationV2ShellSnapshot,
  type ServerAuthSessionMethod,
} from "@t3tools/contracts";
import type { WorkOSOrganization } from "@signalbox/account/WorkOSClient";
import type { AccountProfile } from "@t3tools/contracts/account";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { ConnectResult, ConnectStart } from "../github/GitHubConnection.ts";
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
  /** Drops the thread index and rebuilds it from the user's thread objects. */
  readonly rebuildThreadIndex: () => Promise<number>;
  /** Starts connecting GitHub (`github/GitHubConnection.ts`); GitHub comes back to `redirectUri`. */
  readonly beginGitHubConnect: (redirectUri: string) => Promise<ConnectStart>;
  readonly completeGitHubConnect: (input: {
    readonly grantId: string;
    readonly code: string;
    readonly redirectUri: string;
  }) => Promise<ConnectResult>;
  readonly disconnectGitHub: () => Promise<void>;
  /** A token acting as the user on GitHub now, or null when not connected. Never leaves the cloud. */
  readonly githubAccessToken: () => Promise<string | null>;
  /** The user's current contexts, which every thread call acts within. */
  readonly contextIds: () => Promise<ReadonlyArray<SignalboxContextId>>;
  /** A drive object's membership delivery (`drive/driveAccessOutbox.ts`). Idempotent. */
  readonly recordDriveAccess: (entry: DriveAccessEntry) => Promise<void>;
  /** The user's role in a drive right now, or null when they can't open it (`UserDrives`). */
  readonly driveAccess: (driveId: string) => Promise<SignalboxDriveRole | null>;
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
  rebuildThreadIndex: true,
  beginGitHubConnect: true,
  completeGitHubConnect: true,
  disconnectGitHub: true,
  githubAccessToken: true,
  contextIds: true,
  recordDriveAccess: true,
  driveAccess: true,
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
export const layerDurableObjects = (
  namespace: UserObjectNamespace,
  options: { readonly localWorkerd: boolean },
) => {
  const ids = options.localWorkerd ? namespace : namespace.jurisdiction(USER_OBJECT_JURISDICTION);
  const stubFor = (userId: string) => namespace.get(ids.idFromName(userId));
  return Layer.succeed(
    UserDirectory,
    UserDirectory.of({
      forUser: (userId) => handleFor(stubFor(userId)),
      connect: (session, request) =>
        Effect.tryPromise({
          try: () => {
            const headers = new Headers(request.headers);
            headers.set(CONNECTION_HEADER, encodeConnectionInfo({ sid: session.sessionId }));
            return stubFor(session.userId).fetch(new Request(request, { headers }));
          },
          catch: (cause) => new UserObjectError({ operation: "connect", cause }),
        }),
    }),
  );
};
