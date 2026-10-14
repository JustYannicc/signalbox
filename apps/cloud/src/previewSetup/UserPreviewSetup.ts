import { POOL_LINK_PATH } from "@t3tools/contracts/accountHub";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as GitHubConnection from "../github/GitHubConnection.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import { encodeLinkToken } from "../pool/poolLink.ts";
import * as UserPools from "../user/UserPools.ts";
import * as UserSections from "../user/UserSections.ts";
import type { PreviewSetup } from "./previewSetupWire.ts";

/**
 * A user's side of a preview taking their setup, in their own object. On
 * production: the one-time claims a preview redeems, and the setup each
 * hands over, with a fresh preview link into every pool the user owns. On a
 * preview: taking that setup in.
 *
 * Everything but pools is copied once per source; a preview's pools stay
 * links to production's (`pool/PoolLinks.ts`), which every hand-off renews.
 */

/** A claim is redeemed the moment the browser lands back on the preview. */
export const CODE_TTL_MS = 2 * 60_000;

/** How many pools are linked at once. */
const LINK_CONCURRENCY = 4;

export class PreviewSetupError extends Schema.TaggedError<PreviewSetupError>()(
  "PreviewSetupError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export type PreviewSetupRedemption =
  | { readonly _tag: "redeemed"; readonly setup: PreviewSetup }
  | { readonly _tag: "expired" };

export interface PreviewSetupApplied {
  /** Whether this run copied the setup, i.e. it was the first from this source. */
  readonly copied: boolean;
  /** The pools linked (or linked again) this run. */
  readonly linked: ReadonlyArray<string>;
}

export class UserPreviewSetup extends Context.Service<
  UserPreviewSetup,
  {
    /** Production: a claim for the preview at `origin`, redeemable with `challenge`'s verifier. */
    readonly issueCode: (input: {
      readonly origin: string;
      readonly challenge: string;
    }) => Effect.Effect<{ readonly gid: string; readonly expiresAt: number }, SqlError>;
    /** Production: spends a live claim on the setup, or answers `expired`. */
    readonly redeem: (input: {
      readonly gid: string;
      readonly origin: string;
      readonly challenge: string;
    }) => Effect.Effect<PreviewSetupRedemption, SqlError | PreviewSetupError>;
    /** A preview: takes in a setup from `source`, production's origin. Safe to repeat. */
    readonly apply: (input: {
      readonly setup: PreviewSetup;
      readonly source: string;
    }) => Effect.Effect<PreviewSetupApplied, SqlError | PreviewSetupError>;
  }
>()("@signalbox/cloud/previewSetup/UserPreviewSetup") {}

/** `UserStore`'s `0010` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE preview_setup_codes (
    gid TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  )`;
  yield* sql`CREATE TABLE preview_setup_imports (
    source TEXT PRIMARY KEY,
    imported_at INTEGER NOT NULL,
    refreshed_at INTEGER NOT NULL
  )`;
});

const failed = (detail: string) => (cause: unknown) =>
  Effect.logWarning("preview setup failed", detail, cause).pipe(
    Effect.andThen(Effect.fail(new PreviewSetupError({ detail }))),
  );

export const layer = Layer.effect(
  UserPreviewSetup,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const pools = yield* UserPools.UserPools;
    const directory = yield* PoolDirectory.PoolDirectory;
    const sections = yield* UserSections.UserSections;
    const github = yield* GitHubConnection.GitHubConnection;

    // `UserStore`'s profile, read here: importing it would be a cycle (it runs this migration).
    const signedInUser = Effect.flatMap(
      sql<{ readonly id: string }>`SELECT id FROM profile LIMIT 1`,
      ([profile]) =>
        profile === undefined
          ? Effect.fail(new PreviewSetupError({ detail: "Nobody signed in to this object." }))
          : Effect.succeed({ userId: profile.id }),
    );

    const issueCode: UserPreviewSetup["Service"]["issueCode"] = (input) =>
      Effect.gen(function* () {
        const gid = yield* Effect.orDie(crypto.randomUUIDv4);
        const now = yield* Clock.currentTimeMillis;
        yield* sql`DELETE FROM preview_setup_codes WHERE expires_at <= ${now}`;
        yield* sql`INSERT INTO preview_setup_codes (gid, origin, challenge, expires_at)
          VALUES (${gid}, ${input.origin}, ${input.challenge}, ${now + CODE_TTL_MS})`;
        return { gid, expiresAt: now + CODE_TTL_MS };
      });

    /** Setup only. A fresh link per pool replaces the one this origin had. */
    const exportSetup = (origin: string) =>
      Effect.gen(function* () {
        const actor = yield* signedInUser;
        const owned = yield* pools.list(actor).pipe(Effect.catch(failed("Could not list pools.")));
        const linked = yield* Effect.forEach(
          owned,
          (pool) =>
            directory
              .forPool(pool.objectName)
              .openLink(actor, { origin })
              .pipe(
                Effect.map((secret) => ({
                  id: pool.id,
                  name: pool.name,
                  personal: pool.personal,
                  token: encodeLinkToken(pool.objectName, secret),
                })),
              ),
          { concurrency: LINK_CONCURRENCY },
        ).pipe(Effect.catch(failed("Could not link the pools.")));
        return {
          userId: actor.userId,
          pools: linked,
          sections: yield* sections.rows,
          github: yield* github.recorded,
        } satisfies PreviewSetup;
      });

    const redeem: UserPreviewSetup["Service"]["redeem"] = (input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // One statement, so two redeems racing can't both spend it.
        const spent = yield* sql`UPDATE preview_setup_codes SET used_at = ${now}
          WHERE gid = ${input.gid} AND origin = ${input.origin}
            AND challenge = ${input.challenge} AND used_at IS NULL AND expires_at > ${now}
          RETURNING gid`;
        if (spent.length === 0) return { _tag: "expired" } as const;
        const setup = yield* exportSetup(input.origin).pipe(
          // Unspent again, so the preview can retry while the claim is live.
          Effect.onError(() =>
            sql`UPDATE preview_setup_codes SET used_at = NULL WHERE gid = ${input.gid}`.pipe(
              Effect.ignore,
            ),
          ),
        );
        return { _tag: "redeemed", setup } as const;
      });

    /** Sections, placements and the GitHub connection, never over what's already here. */
    const copy = (setup: PreviewSetup) =>
      Effect.andThen(
        sections.adopt(setup.sections),
        setup.github === null ? Effect.void : github.adopt(setup.github),
      );

    const apply: UserPreviewSetup["Service"]["apply"] = ({ setup, source }) =>
      Effect.gen(function* () {
        const actor = yield* signedInUser;
        if (actor.userId !== setup.userId) {
          return yield* new PreviewSetupError({ detail: "That setup belongs to someone else." });
        }
        const linkUrl = `${source}${POOL_LINK_PATH}`;
        const [imported] = yield* sql<{
          readonly imported_at: number;
        }>`SELECT imported_at FROM preview_setup_imports WHERE source = ${source}`;
        const first = imported === undefined;
        if (first) yield* copy(setup);
        // Every pool the first time; after that only the ones still linked, or new
        // since, so a pool someone pointed elsewhere here stays theirs.
        const current = yield* pools
          .list(actor)
          .pipe(Effect.catch(failed("Could not list pools.")));
        const toLink = setup.pools.filter((pool) => {
          const here = current.find((candidate) =>
            pool.personal ? candidate.personal : candidate.id === pool.id,
          );
          return (
            first ||
            here === undefined ||
            (here.backing.mode === "external" && here.backing.url === linkUrl)
          );
        });
        yield* Effect.forEach(
          toLink,
          (pool) => pools.link(actor, pool, { url: linkUrl, key: pool.token }),
          { concurrency: LINK_CONCURRENCY, discard: true },
        ).pipe(Effect.catch(failed("Could not link the pools.")));
        yield* pools.refresh(actor).pipe(Effect.ignore);
        // Last, so a run that failed part way copies and links everything again.
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO preview_setup_imports (source, imported_at, refreshed_at)
          VALUES (${source}, ${now}, ${now})
          ON CONFLICT (source) DO UPDATE SET refreshed_at = excluded.refreshed_at`;
        return { copied: first, linked: toLink.map((pool) => pool.id) };
      });

    return UserPreviewSetup.of({ issueCode, redeem, apply });
  }),
);
