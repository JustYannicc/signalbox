import {
  AuthSessionId,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type ServerAuthSessionMethod,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as UserDirectory from "../user/UserDirectory.ts";
import type { SessionRecord } from "../user/UserStore.ts";
import * as CloudTokens from "./CloudTokens.ts";

/**
 * Environment sessions for the cloud: the same model a self-hosted server
 * uses (a session per client, with a method, scopes and expiry, revocable),
 * stored in the session owner's user object. A token is only accepted while
 * its record there is live, so revocation and sign-out take effect at once.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * DAY_MS;
const TICKET_TTL_MS = 5 * 60 * 1000;
/** Account credentials are redeemed the moment they are minted. */
export const CREDENTIAL_TTL_MS = 2 * 60 * 1000;

/**
 * Account sessions get the standard client scopes. Access management (the
 * device list and pairing links) is not served by the cloud yet, so no session
 * may claim its scopes.
 */
export const CLOUD_SESSION_SCOPES: ReadonlyArray<AuthEnvironmentScope> = AuthStandardClientScopes;

/** Session subjects follow the self-hosted account convention. */
export const ACCOUNT_SUBJECT_PREFIX = "account:";

export interface CloudSession {
  readonly userId: string;
  readonly sessionId: AuthSessionId;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly expiresAt: number;
}

/** Who a signed token says it is, before anyone has checked the record behind it. */
export interface SessionClaims {
  readonly userId: string;
  readonly sessionId: AuthSessionId;
}

type Credentials = {
  readonly cookie?: string | undefined;
  readonly bearer?: string | undefined;
};

export class CloudCredentialError extends Schema.TaggedError<CloudCredentialError>()(
  "CloudCredentialError",
  { reason: Schema.Literals(["missing_credential", "invalid_credential"]) },
) {
  override get message(): string {
    return `The cloud rejected the credential (${this.reason}).`;
  }
}

export class CloudSessions extends Context.Service<
  CloudSessions,
  {
    /**
     * Signature and expiry only, no round trip. For callers whose next step is
     * the user object, which checks the record itself. A session cookie wins
     * over a bearer token, as on the self-hosted server.
     */
    readonly claims: (
      credentials: Credentials,
    ) => Effect.Effect<SessionClaims, CloudCredentialError>;
    readonly ticketClaims: (ticket: string) => Effect.Effect<SessionClaims, CloudCredentialError>;
    /** Claims plus a live record in the owner's object. */
    readonly authenticate: (
      credentials: Credentials,
    ) => Effect.Effect<CloudSession, CloudCredentialError | UserDirectory.UserObjectError>;
    readonly create: (input: {
      readonly userId: string;
      readonly method: ServerAuthSessionMethod;
      readonly label?: string;
    }) => Effect.Effect<
      { readonly session: CloudSession; readonly token: string },
      UserDirectory.UserObjectError
    >;
    /** Redeems a one-time credential. Its user is the session's user. */
    readonly exchangeCredential: (
      credential: string,
      input: {
        readonly method: ServerAuthSessionMethod;
        readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
        readonly label?: string;
      },
    ) => Effect.Effect<
      { readonly session: CloudSession; readonly token: string },
      CloudCredentialError | UserDirectory.UserObjectError
    >;
    /** A one-time credential for a user, as a handoff redemption returns. */
    readonly signCredential: (input: {
      readonly userId: string;
      readonly gid: string;
      readonly expiresAt: number;
    }) => Effect.Effect<string>;
    /** A short-lived WebSocket ticket. Reusable until it expires, like the server's. */
    readonly issueTicket: (
      session: Pick<CloudSession, "userId" | "sessionId" | "expiresAt">,
    ) => Effect.Effect<{ readonly ticket: string; readonly expiresAt: number }>;
    /** Revokes the session behind `credentials`, which also closes its sockets. */
    readonly revoke: (
      credentials: Credentials,
    ) => Effect.Effect<void, CloudCredentialError | UserDirectory.UserObjectError>;
  }
>()("@signalbox/cloud/auth/CloudSessions") {}

const toSession = (userId: string, record: SessionRecord): CloudSession => ({
  userId,
  sessionId: AuthSessionId.make(record.sid),
  method: record.method,
  scopes: record.scopes,
  expiresAt: record.expiresAt,
});

const make = Effect.gen(function* () {
  const tokens = yield* CloudTokens.CloudTokens;
  const users = yield* UserDirectory.UserDirectory;

  const invalid = () => new CloudCredentialError({ reason: "invalid_credential" });
  const toClaims = (claims: { readonly u: string; readonly sid: string }): SessionClaims => ({
    userId: claims.u,
    sessionId: AuthSessionId.make(claims.sid),
  });

  const claims: CloudSessions["Service"]["claims"] = ({ cookie, bearer }) => {
    const token = cookie ?? bearer;
    if (!token) return Effect.fail(new CloudCredentialError({ reason: "missing_credential" }));
    return tokens
      .verify("session", token)
      .pipe(Effect.mapBoth({ onFailure: invalid, onSuccess: toClaims }));
  };

  const ticketClaims: CloudSessions["Service"]["ticketClaims"] = (ticket) =>
    tokens
      .verify("ticket", ticket)
      .pipe(Effect.mapBoth({ onFailure: invalid, onSuccess: toClaims }));

  const authenticate: CloudSessions["Service"]["authenticate"] = Effect.fn(
    "CloudSessions.authenticate",
  )(function* (credentials) {
    const { userId, sessionId } = yield* claims(credentials);
    const record = yield* users.forUser(userId).findSession(sessionId);
    if (!record) return yield* invalid();
    return toSession(userId, record);
  });

  const signSession = (userId: string, record: SessionRecord) =>
    tokens
      .sign({ _tag: "session", u: userId, sid: record.sid, exp: record.expiresAt })
      .pipe(Effect.map((token) => ({ session: toSession(userId, record), token })));

  const create: CloudSessions["Service"]["create"] = Effect.fn("CloudSessions.create")(
    function* (input) {
      const record = yield* users.forUser(input.userId).createSession({
        method: input.method,
        scopes: CLOUD_SESSION_SCOPES,
        ...(input.label ? { label: input.label } : {}),
        ttlMs: SESSION_TTL_MS,
      });
      return yield* signSession(input.userId, record);
    },
  );

  const exchangeCredential: CloudSessions["Service"]["exchangeCredential"] = Effect.fn(
    "CloudSessions.exchangeCredential",
  )(function* (credential, input) {
    const claims = yield* tokens.verify("credential", credential).pipe(Effect.mapError(invalid));
    const record = yield* users.forUser(claims.u).exchangeCredential({
      gid: claims.gid,
      method: input.method,
      scopes: input.scopes,
      ...(input.label ? { label: input.label } : {}),
      ttlMs: SESSION_TTL_MS,
    });
    if (!record) return yield* invalid();
    return yield* signSession(claims.u, record);
  });

  const signCredential: CloudSessions["Service"]["signCredential"] = (input) =>
    tokens.sign({ _tag: "credential", u: input.userId, gid: input.gid, exp: input.expiresAt });

  const issueTicket: CloudSessions["Service"]["issueTicket"] = Effect.fn(
    "CloudSessions.issueTicket",
  )(function* (session) {
    // A ticket never outlives its session.
    const expiresAt = Math.min((yield* Clock.currentTimeMillis) + TICKET_TTL_MS, session.expiresAt);
    const ticket = yield* tokens.sign({
      _tag: "ticket",
      u: session.userId,
      sid: session.sessionId,
      exp: expiresAt,
    });
    return { ticket, expiresAt };
  });

  const revoke: CloudSessions["Service"]["revoke"] = Effect.fn("CloudSessions.revoke")(
    function* (credentials) {
      const { userId, sessionId } = yield* claims(credentials);
      // Already revoked or expired: the credential was not a live session.
      if (!(yield* users.forUser(userId).revokeSession(sessionId))) return yield* invalid();
    },
  );

  return CloudSessions.of({
    claims,
    ticketClaims,
    authenticate,
    create,
    exchangeCredential,
    signCredential,
    issueTicket,
    revoke,
  });
});

export const layer = Layer.effect(CloudSessions, make);
