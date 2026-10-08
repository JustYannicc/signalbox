import {
  type AuthEnvironmentScope,
  AuthEnvironmentScopes,
  type OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellJson,
  type ServerAuthSessionMethod,
  ThreadId,
} from "@t3tools/contracts";
import type { AccountProfile } from "@t3tools/contracts/account";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as GitHubConnection from "../github/GitHubConnection.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserSections from "./UserSections.ts";
import type { ThreadSummary } from "../thread/ThreadEngine.ts";

/**
 * Everything one user's Durable Object persists: their WorkOS profile, their
 * environment sessions, the one-time grants that turn a sign-in into a
 * session, and the index of their threads that the sidebar reads. Each user's
 * object has its own SQLite database, so no row here ever names another user.
 *
 * The thread index is derived: thread objects deliver their summaries through
 * an outbox, and dropping the index and pulling every member thread's summary
 * again rebuilds it. Membership is the record of which threads to pull.
 */

/** Wrong verifiers burn a handoff, as on the self-hosted server. */
const MAX_HANDOFF_ATTEMPTS = 5;

export interface SessionRecord {
  readonly sid: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type GrantKind = "handoff" | "credential";

export type HandoffRedemption =
  | {
      readonly _tag: "redeemed";
      readonly profile: AccountProfile;
      /** A fresh one-time credential grant, minted with the redemption. */
      readonly credential: { readonly gid: string; readonly expiresAt: number };
    }
  | { readonly _tag: "expired" }
  | { readonly _tag: "rejected" };

export class UserStore extends Context.Service<
  UserStore,
  {
    readonly recordSignIn: (profile: AccountProfile) => Effect.Effect<void, SqlError>;
    readonly profile: Effect.Effect<AccountProfile | null, SqlError>;
    readonly createSession: (input: {
      readonly method: ServerAuthSessionMethod;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly label?: string;
      readonly ttlMs: number;
    }) => Effect.Effect<SessionRecord, SqlError>;
    /** The session if it exists, is unrevoked, and has not expired. */
    readonly findSession: (sid: string) => Effect.Effect<SessionRecord | null, SqlError>;
    readonly revokeSession: (sid: string) => Effect.Effect<boolean, SqlError>;
    readonly issueGrant: (input: {
      readonly kind: GrantKind;
      /** Handoffs only: base64url(SHA-256(verifier)) the redeemer must match. */
      readonly challenge?: string;
      readonly ttlMs: number;
    }) => Effect.Effect<{ readonly gid: string; readonly expiresAt: number }, SqlError>;
    readonly redeemHandoff: (input: {
      readonly gid: string;
      readonly challenge: string;
      readonly credentialTtlMs: number;
    }) => Effect.Effect<HandoffRedemption, SqlError>;
    /**
     * Spends a live credential grant on a new session, in one transaction, so a
     * credential is never burned without its session. Null when the grant is
     * unknown, used or expired.
     */
    readonly exchangeCredential: (input: {
      readonly gid: string;
      readonly method: ServerAuthSessionMethod;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly label?: string;
      readonly ttlMs: number;
    }) => Effect.Effect<SessionRecord | null, SqlError>;
    /**
     * Records a thread's summary unless the index already holds that revision
     * or a newer one, so redelivery and reordering change nothing. Returns the
     * index's new sequence when the row changed, null otherwise.
     */
    readonly recordThreadSummary: (
      summary: ThreadSummary,
    ) => Effect.Effect<number | null, SqlError>;
    readonly threadIndex: Effect.Effect<
      { readonly sequence: number; readonly threads: ReadonlyArray<OrchestrationV2ThreadShell> },
      SqlError
    >;
    readonly threadMembers: Effect.Effect<ReadonlyArray<ThreadId>, SqlError>;
    /**
     * Replaces every indexed summary (not membership) with `summaries`, in one
     * transaction, so readers see the old index or the new one, never a part.
     * Returns each summary with the index sequence it was recorded at.
     */
    readonly replaceThreadIndex: (
      summaries: ReadonlyArray<ThreadSummary>,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly summary: ThreadSummary; readonly sequence: number }>,
      SqlError
    >;
  }
>()("@signalbox/cloud/user/UserStore") {}

const migrations = Migrator.fromRecord({
  "0001_identity": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE profile (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      avatar_url TEXT,
      signed_in_at INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE sessions (
      sid TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      scopes TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`;
    yield* sql`CREATE TABLE grants (
      gid TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      challenge TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    )`;
  }),
  // 0002 is unused: contexts took 0004 after this landed (#139).
  "0003_thread_index": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE thread_members (
      thread_id TEXT PRIMARY KEY,
      added_at INTEGER NOT NULL
    )`;
    // `context_id` is not read yet: contexts (#139) group the sidebar by it.
    yield* sql`CREATE TABLE thread_index (
      thread_id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      shell TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    // Orders shell updates for subscribers; every index change moves it.
    yield* sql`CREATE TABLE thread_index_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sequence INTEGER NOT NULL
    )`;
    yield* sql`INSERT INTO thread_index_state (id, sequence) VALUES (1, 0)`;
  }),
  "0004_contexts_sections": Effect.andThen(UserContexts.createTables, UserSections.createTables),
  "0005_remote_projects": Effect.andThen(
    UserContexts.createRemoteProjectTables,
    GitHubConnection.createTables,
  ),
});

/** Applies pending migrations. Ids only ever grow; never renumber one. */
export const migrate = Migrator.make({})({ loader: migrations });

const ProfileRow = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  first_name: Schema.NullOr(Schema.String),
  last_name: Schema.NullOr(Schema.String),
  avatar_url: Schema.NullOr(Schema.String),
});

const SessionRow = Schema.Struct({
  sid: Schema.String,
  method: Schema.Literals(["browser-session-cookie", "bearer-access-token", "dpop-access-token"]),
  scopes: Schema.fromJsonString(AuthEnvironmentScopes),
  label: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  expires_at: Schema.Number,
});

const GrantRow = Schema.Struct({
  kind: Schema.String,
  challenge: Schema.NullOr(Schema.String),
  attempts: Schema.Number,
  expires_at: Schema.Number,
  used_at: Schema.NullOr(Schema.Number),
});

const ShellJson = Schema.fromJsonString(OrchestrationV2ThreadShellJson);
const encodeShell = Schema.encodeSync(ShellJson);
const IndexRow = Schema.Struct({ shell: ShellJson });
const decodeIndexRows = Schema.decodeUnknownSync(Schema.Array(IndexRow));
const decodeMemberRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ thread_id: ThreadId })),
);
const decodeSequenceRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ sequence: Schema.Number })),
);

const decodeProfileRows = Schema.decodeUnknownSync(Schema.Array(ProfileRow));
const decodeSessionRows = Schema.decodeUnknownSync(Schema.Array(SessionRow));
const decodeGrantRows = Schema.decodeUnknownSync(Schema.Array(GrantRow));
const encodeScopes = Schema.encodeSync(Schema.fromJsonString(AuthEnvironmentScopes));

const toProfile = (row: typeof ProfileRow.Type): AccountProfile => ({
  id: row.id,
  email: row.email,
  ...(row.first_name ? { firstName: row.first_name } : {}),
  ...(row.last_name ? { lastName: row.last_name } : {}),
  ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  // Randomness failing is a defect, not a storage error.
  const randomUuid = Effect.orDie(crypto.randomUUIDv4);

  const recordSignIn: UserStore["Service"]["recordSignIn"] = Effect.fn("UserStore.recordSignIn")(
    function* (profile) {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO profile (id, email, first_name, last_name, avatar_url, signed_in_at)
        VALUES (${profile.id}, ${profile.email}, ${profile.firstName ?? null},
          ${profile.lastName ?? null}, ${profile.avatarUrl ?? null}, ${now})
        ON CONFLICT (id) DO UPDATE SET email = excluded.email, first_name = excluded.first_name,
          last_name = excluded.last_name, avatar_url = excluded.avatar_url,
          signed_in_at = excluded.signed_in_at`;
    },
  );

  const profile: UserStore["Service"]["profile"] = sql`SELECT id, email, first_name, last_name,
      avatar_url FROM profile LIMIT 1`.pipe(
    Effect.map((rows) => {
      const [row] = decodeProfileRows(rows);
      return row ? toProfile(row) : null;
    }),
  );

  const createSession: UserStore["Service"]["createSession"] = Effect.fn("UserStore.createSession")(
    function* (input) {
      const now = yield* Clock.currentTimeMillis;
      const record: SessionRecord = {
        sid: yield* randomUuid,
        method: input.method,
        scopes: input.scopes,
        ...(input.label ? { label: input.label } : {}),
        createdAt: now,
        expiresAt: now + input.ttlMs,
      };
      yield* sql`INSERT INTO sessions (sid, method, scopes, label, created_at, expires_at)
      VALUES (${record.sid}, ${record.method}, ${encodeScopes(record.scopes)},
        ${record.label ?? null}, ${record.createdAt}, ${record.expiresAt})`;
      return record;
    },
  );

  const findSession: UserStore["Service"]["findSession"] = Effect.fn("UserStore.findSession")(
    function* (sid) {
      const now = yield* Clock.currentTimeMillis;
      const [row] = decodeSessionRows(
        yield* sql`SELECT sid, method, scopes, label, created_at, expires_at FROM sessions
          WHERE sid = ${sid} AND revoked_at IS NULL AND expires_at > ${now}`,
      );
      if (!row) return null;
      return {
        sid: row.sid,
        method: row.method,
        scopes: row.scopes,
        ...(row.label ? { label: row.label } : {}),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      } satisfies SessionRecord;
    },
  );

  const revokeSession: UserStore["Service"]["revokeSession"] = Effect.fn("UserStore.revokeSession")(
    function* (sid) {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql`UPDATE sessions SET revoked_at = ${now}
      WHERE sid = ${sid} AND revoked_at IS NULL RETURNING sid`;
      return rows.length > 0;
    },
  );

  const issueGrant: UserStore["Service"]["issueGrant"] = Effect.fn("UserStore.issueGrant")(
    function* (input) {
      const now = yield* Clock.currentTimeMillis;
      const gid = yield* randomUuid;
      const expiresAt = now + input.ttlMs;
      yield* sql`INSERT INTO grants (gid, kind, challenge, expires_at)
        VALUES (${gid}, ${input.kind}, ${input.challenge ?? null}, ${expiresAt})`;
      return { gid, expiresAt };
    },
  );

  const liveGrant = (gid: string, kind: GrantKind, now: number) =>
    sql`SELECT kind, challenge, attempts, expires_at, used_at FROM grants WHERE gid = ${gid}`.pipe(
      Effect.map((rows) => {
        const [row] = decodeGrantRows(rows);
        return row && row.kind === kind && row.used_at === null && row.expires_at > now
          ? row
          : undefined;
      }),
    );

  /** Marks a live grant used. True exactly once per grant. */
  const claimGrant = (gid: string, kind: GrantKind, now: number) =>
    sql`UPDATE grants SET used_at = ${now}
      WHERE gid = ${gid} AND kind = ${kind} AND used_at IS NULL AND expires_at > ${now}
      RETURNING gid`.pipe(Effect.map((rows) => rows.length > 0));

  // Transactions keep each check-then-write whole even when the effect yields
  // between statements.
  const redeemHandoff: UserStore["Service"]["redeemHandoff"] = Effect.fn("UserStore.redeemHandoff")(
    function* (input) {
      const now = yield* Clock.currentTimeMillis;
      const grant = yield* liveGrant(input.gid, "handoff", now);
      if (!grant || grant.attempts >= MAX_HANDOFF_ATTEMPTS) return { _tag: "expired" } as const;
      if (grant.challenge !== input.challenge) {
        yield* sql`UPDATE grants SET attempts = attempts + 1 WHERE gid = ${input.gid}`;
        return { _tag: "rejected" } as const;
      }
      const account = yield* profile;
      if (!account || !(yield* claimGrant(input.gid, "handoff", now))) {
        return { _tag: "expired" } as const;
      }
      const credential = yield* issueGrant({ kind: "credential", ttlMs: input.credentialTtlMs });
      return { _tag: "redeemed", profile: account, credential } as const;
    },
    sql.withTransaction,
  );

  const exchangeCredential: UserStore["Service"]["exchangeCredential"] = Effect.fn(
    "UserStore.exchangeCredential",
  )(function* ({ gid, ...session }) {
    const now = yield* Clock.currentTimeMillis;
    if (!(yield* claimGrant(gid, "credential", now))) return null;
    return yield* createSession(session);
  }, sql.withTransaction);

  const bumpIndexSequence = sql`UPDATE thread_index_state SET sequence = sequence + 1
    WHERE id = 1 RETURNING sequence`.pipe(
    Effect.map((rows) => decodeSequenceRows(rows)[0]?.sequence ?? 0),
  );

  const recordThreadSummary: UserStore["Service"]["recordThreadSummary"] = Effect.fn(
    "UserStore.recordThreadSummary",
  )(function* (summary) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO thread_members (thread_id, added_at) VALUES (${summary.threadId}, ${now})
      ON CONFLICT (thread_id) DO NOTHING`;
    const written = yield* sql`INSERT INTO thread_index
        (thread_id, context_id, revision, shell, updated_at)
      VALUES (${summary.threadId}, ${summary.contextId}, ${summary.revision},
        ${encodeShell(summary.shell)}, ${now})
      ON CONFLICT (thread_id) DO UPDATE SET context_id = excluded.context_id,
        revision = excluded.revision, shell = excluded.shell, updated_at = excluded.updated_at
      WHERE excluded.revision > thread_index.revision
      RETURNING thread_id`;
    return written.length > 0 ? yield* bumpIndexSequence : null;
  }, sql.withTransaction);

  const threadIndex: UserStore["Service"]["threadIndex"] = Effect.all({
    sequence: sql`SELECT sequence FROM thread_index_state WHERE id = 1`.pipe(
      Effect.map((rows) => decodeSequenceRows(rows)[0]?.sequence ?? 0),
    ),
    threads: sql`SELECT shell FROM thread_index ORDER BY thread_id`.pipe(
      Effect.map((rows) => decodeIndexRows(rows).map((row) => row.shell)),
    ),
  }).pipe(sql.withTransaction);

  const threadMembers: UserStore["Service"]["threadMembers"] =
    sql`SELECT thread_id FROM thread_members ORDER BY thread_id`.pipe(
      Effect.map((rows) => decodeMemberRows(rows).map((row) => row.thread_id)),
    );

  const replaceThreadIndex: UserStore["Service"]["replaceThreadIndex"] = Effect.fn(
    "UserStore.replaceThreadIndex",
  )(function* (summaries) {
    yield* sql`DELETE FROM thread_index`;
    const recorded: Array<{ readonly summary: ThreadSummary; readonly sequence: number }> = [];
    for (const summary of summaries) {
      const sequence = yield* recordThreadSummary(summary);
      if (sequence !== null) recorded.push({ summary, sequence });
    }
    return recorded;
  }, sql.withTransaction);

  return UserStore.of({
    recordThreadSummary,
    threadIndex,
    threadMembers,
    replaceThreadIndex,
    recordSignIn,
    profile,
    createSession,
    findSession,
    revokeSession,
    issueGrant,
    redeemHandoff,
    exchangeCredential,
  });
});

export const layer = Layer.effect(UserStore, make);
