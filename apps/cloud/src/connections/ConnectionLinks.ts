import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as CloudTokens from "../auth/CloudTokens.ts";
import { randomKey } from "../pool/PoolLinks.ts";

/**
 * Links that let a tool outside Signalbox use the accounts a user connected
 * here, without connecting them again: Executor holds one and asks
 * `/api/connections` for a fresh token on every call (`connectionRoutes.ts`),
 * so it never keeps a copy. A link acts for the user who made it until they
 * revoke it. Only a hash of each secret is kept, in the user's own object.
 */

const TOKEN_PREFIX = "sbcl_";
/** Links live until revoked. Rotating `SESSION_SECRET` ends them too. */
const NEVER = Number.MAX_SAFE_INTEGER;
/** Plenty for one per tool; stops a session from filling the user's storage. */
export const MAX_LINKS = 20;
/** "Last used" is shown to the minute, so most checks needn't write it. */
const LAST_USED_PRECISION_MS = 60_000;

/** The bearer a tool holds: the user it acts for and the link's secret, signed by the cloud. */
export const signLinkToken = (userId: string, secret: string) =>
  CloudTokens.CloudTokens.use((tokens) =>
    tokens.sign({ _tag: "connection-link", u: userId, s: secret, exp: NEVER }),
  ).pipe(Effect.map((signed) => `${TOKEN_PREFIX}${signed}`));

/** The user and secret of a link this cloud signed, or null for anything else. */
export const verifyLinkToken = (token: string) =>
  token.startsWith(TOKEN_PREFIX)
    ? CloudTokens.CloudTokens.use((tokens) =>
        tokens.verify("connection-link", token.slice(TOKEN_PREFIX.length)),
      ).pipe(
        Effect.map((claims) => ({ userId: claims.u, secret: claims.s })),
        Effect.orElseSucceed(() => null),
      )
    : Effect.succeed(null);

export interface ConnectionLink {
  readonly id: string;
  /** Where it is used, e.g. the Executor's host. */
  readonly label: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

export type CreatedLink =
  | { readonly _tag: "created"; readonly secret: string }
  | { readonly _tag: "limit" };

export class ConnectionLinks extends Context.Service<
  ConnectionLinks,
  {
    /** A new link's secret, which is never stored; `signLinkToken` makes it a token. */
    readonly create: (label: string) => Effect.Effect<CreatedLink, SqlError>;
    /** Whether the secret belongs to a live link; records the use. */
    readonly check: (secret: string) => Effect.Effect<boolean, SqlError>;
    readonly list: Effect.Effect<ReadonlyArray<ConnectionLink>, SqlError>;
    readonly revoke: (id: string) => Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/connections/ConnectionLinks") {}

/** `UserStore`'s `0009` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE connection_links (
    secret_hash TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`;
});

const LinkRow = Schema.Struct({
  secret_hash: Schema.String,
  label: Schema.String,
  created_at: Schema.Number,
  last_used_at: Schema.NullOr(Schema.Number),
});
const decodeLinkRows = Schema.decodeUnknownSync(Schema.Array(LinkRow));

/** A link's public id: enough of its hash to tell links apart, nothing to use one. */
const ID_LENGTH = 16;
const idOf = (secretHash: string) => secretHash.slice(0, ID_LENGTH);
const isLinkId = (id: string) => new RegExp(`^[0-9a-f]{${ID_LENGTH}}$`).test(id);

export const layer = Layer.effect(
  ConnectionLinks,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const hash = (secret: string) =>
      crypto
        .digest("SHA-256", new TextEncoder().encode(secret))
        .pipe(Effect.map(Hex.encode), Effect.orDie);

    const create: ConnectionLinks["Service"]["create"] = (label) =>
      Effect.gen(function* () {
        const [count] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n
          FROM connection_links`;
        if ((count?.n ?? 0) >= MAX_LINKS) return { _tag: "limit" } as const;
        const secret = yield* randomKey.pipe(Effect.provideService(Crypto.Crypto, crypto));
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO connection_links (secret_hash, label, created_at)
          VALUES (${yield* hash(secret)}, ${label.trim() || "Executor"}, ${now})`;
        return { _tag: "created", secret } as const;
      });

    // Tools ask on every call, so a use is written at most once a minute.
    const check: ConnectionLinks["Service"]["check"] = (secret) =>
      Effect.gen(function* () {
        const secretHash = yield* hash(secret);
        const [found] = yield* sql<{ readonly last_used_at: number | null }>`SELECT last_used_at
          FROM connection_links WHERE secret_hash = ${secretHash}`;
        if (found === undefined) return false;
        const now = yield* Clock.currentTimeMillis;
        if (found.last_used_at === null || found.last_used_at <= now - LAST_USED_PRECISION_MS) {
          yield* sql`UPDATE connection_links SET last_used_at = ${now}
            WHERE secret_hash = ${secretHash}`;
        }
        return true;
      });

    const list: ConnectionLinks["Service"]["list"] = sql`SELECT secret_hash, label, created_at,
        last_used_at FROM connection_links ORDER BY created_at`.pipe(
      Effect.map((rows) =>
        decodeLinkRows(rows).map((row) => ({
          id: idOf(row.secret_hash),
          label: row.label,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
        })),
      ),
    );

    // Hashes are lowercase hex, so the ids' range is a primary-key scan.
    const revoke: ConnectionLinks["Service"]["revoke"] = (id) =>
      isLinkId(id)
        ? sql`DELETE FROM connection_links
            WHERE secret_hash >= ${id} AND secret_hash < ${`${id}g`}`.pipe(Effect.asVoid)
        : Effect.void;

    return ConnectionLinks.of({ create, check, list, revoke });
  }),
);
