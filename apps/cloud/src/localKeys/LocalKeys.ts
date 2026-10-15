import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as CloudTokens from "../auth/CloudTokens.ts";
import { hashRangeOf, hashSecret, isPublicId, publicIdOf } from "../auth/hashedSecrets.ts";
import type { ModelUsage } from "../modelGateway/modelGatewayRecord.ts";
import { randomKey } from "../pool/PoolLinks.ts";

/**
 * Local keys: how the harnesses on someone's own computer (Claude Code,
 * Codex) run on their pool. A key goes where a provider API key would, and
 * the ModelGateway takes it as it takes a turn's model token
 * (`thread/runner/modelGrants.ts`): the user's object checks it, resolves
 * which pool their top level runs on, and that pool checks they may still use
 * it. So a key follows the folder model and the pool's membership, and
 * revoking it stops the next request.
 *
 * Only a hash of each secret is kept, in the user's own object, with what the
 * key has used so far.
 */

export const LOCAL_KEY_PREFIX = "sbk_";
/** Keys live until revoked. Rotating `SESSION_SECRET` ends them too. */
const NEVER = Number.MAX_SAFE_INTEGER;
/** Plenty for every computer someone uses; stops a session from filling their storage. */
export const MAX_KEYS = 20;

/** The key a harness holds: the user and the key's secret, signed by the cloud. */
export const signLocalKey = (userId: string, secret: string) =>
  CloudTokens.CloudTokens.use((tokens) =>
    tokens.sign({ _tag: "local-key", u: userId, s: secret, exp: NEVER }),
  ).pipe(Effect.map((signed) => `${LOCAL_KEY_PREFIX}${signed}`));

export const isLocalKey = (token: string) => token.startsWith(LOCAL_KEY_PREFIX);

/** The user and secret of a key this cloud signed, or null for anything else. */
export const verifyLocalKey = (token: string) =>
  isLocalKey(token)
    ? CloudTokens.CloudTokens.use((tokens) =>
        tokens.verify("local-key", token.slice(LOCAL_KEY_PREFIX.length)),
      ).pipe(
        Effect.map((claims) => ({ userId: claims.u, secret: claims.s })),
        Effect.orElseSucceed(() => null),
      )
    : Effect.succeed(null);

export interface LocalKey {
  readonly id: string;
  /** The computer it was made for, as the browser that made it says. */
  readonly label: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly requests: number;
  /** Input and output tokens, cache reads and writes included. */
  readonly tokens: number;
}

export type CreatedKey =
  | { readonly _tag: "created"; readonly secret: string }
  | { readonly _tag: "limit" };

export class LocalKeys extends Context.Service<
  LocalKeys,
  {
    /** A new key's secret, which is never stored; `signLocalKey` makes it a token. */
    readonly create: (label: string) => Effect.Effect<CreatedKey, SqlError>;
    /** The id of the live key with this secret, or null. */
    readonly check: (secret: string) => Effect.Effect<string | null, SqlError>;
    /** Adds one served request to a key; a revoked key's is dropped. */
    readonly record: (id: string, usage: ModelUsage | null) => Effect.Effect<void, SqlError>;
    readonly list: Effect.Effect<ReadonlyArray<LocalKey>, SqlError>;
    readonly revoke: (id: string) => Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/localKeys/LocalKeys") {}

/** `UserStore`'s `0014` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE local_keys (
    secret_hash TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    requests INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0
  )`;
});

const KeyRow = Schema.Struct({
  secret_hash: Schema.String,
  label: Schema.String,
  created_at: Schema.Number,
  last_used_at: Schema.NullOr(Schema.Number),
  requests: Schema.Number,
  tokens: Schema.Number,
});
const decodeKeyRows = Schema.decodeUnknownSync(Schema.Array(KeyRow));

const totalTokens = (usage: ModelUsage | null) =>
  usage === null ? 0 : usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

export const layer = Layer.effect(
  LocalKeys,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const hash = (secret: string) => hashSecret(crypto, secret);

    const create: LocalKeys["Service"]["create"] = (label) =>
      Effect.gen(function* () {
        const [count] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM local_keys`;
        if ((count?.n ?? 0) >= MAX_KEYS) return { _tag: "limit" } as const;
        const secret = yield* randomKey.pipe(Effect.provideService(Crypto.Crypto, crypto));
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO local_keys (secret_hash, label, created_at)
          VALUES (${yield* hash(secret)}, ${label.trim() || "Computer"}, ${now})`;
        return { _tag: "created", secret } as const;
      });

    const check: LocalKeys["Service"]["check"] = (secret) =>
      Effect.gen(function* () {
        const secretHash = yield* hash(secret);
        const [found] = yield* sql<{ readonly secret_hash: string }>`SELECT secret_hash
          FROM local_keys WHERE secret_hash = ${secretHash}`;
        return found === undefined ? null : publicIdOf(found.secret_hash);
      });

    const record: LocalKeys["Service"]["record"] = (id, usage) =>
      isPublicId(id)
        ? Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* sql`UPDATE local_keys SET last_used_at = ${now}, requests = requests + 1,
              tokens = tokens + ${totalTokens(usage)}
              WHERE secret_hash >= ${hashRangeOf(id)[0]} AND secret_hash < ${hashRangeOf(id)[1]}`;
          })
        : Effect.void;

    const list: LocalKeys["Service"]["list"] = sql`SELECT secret_hash, label, created_at,
        last_used_at, requests, tokens FROM local_keys ORDER BY created_at`.pipe(
      Effect.map((rows) =>
        decodeKeyRows(rows).map((row) => ({
          id: publicIdOf(row.secret_hash),
          label: row.label,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
          requests: row.requests,
          tokens: row.tokens,
        })),
      ),
    );

    const revoke: LocalKeys["Service"]["revoke"] = (id) =>
      isPublicId(id)
        ? sql`DELETE FROM local_keys
            WHERE secret_hash >= ${hashRangeOf(id)[0]} AND secret_hash < ${hashRangeOf(id)[1]}`.pipe(
            Effect.asVoid,
          )
        : Effect.void;

    return LocalKeys.of({ create, check, record, list, revoke });
  }),
);
