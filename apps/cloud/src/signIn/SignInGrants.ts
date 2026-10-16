import {
  type SignInAnswer,
  type SignInGrant,
  SignInGrantError,
  type SignInGrantInput,
  type SignInGrants as SignInGrantList,
  type SignInSource,
  SIGN_IN_EVERYWHERE,
} from "@t3tools/contracts/signalboxSignIn";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { makeProfileId } from "../user/profileId.ts";
import { makeTraced } from "../user/tracing.ts";
import * as UserFolders from "../user/UserFolders.ts";
import { askSiteOf, grantSiteOf, hostOf, narrowestCovering } from "./signInSites.ts";

/**
 * A person's standing sign-in grants (#575), in their own object: the
 * record the login service (#576) checks before every sign-in. Grants are
 * plain data the person reads and edits in Settings; "everywhere" is just
 * the grant whose site is `*`. Agents never reach these: granting is the
 * person deciding for their agents.
 */

/** Per source: plenty for a person's sites; stops a client from filling their storage. */
export const MAX_GRANTS = 200;

/** The answer for one sign-in, or why the page can't have one. */
export type SignInCheck = SignInAnswer | { readonly _tag: "refused"; readonly message: string };

const NOT_A_SITE = "Use a site's address, like example.com.";

export class SignInGrants extends Context.Service<
  SignInGrants,
  {
    /** Every grant in force: everywhere grants first, then by site. */
    readonly grants: Effect.Effect<SignInGrantList, SqlError>;
    /** The grants now and after every change. */
    readonly changes: Stream.Stream<SignInGrantList, SqlError>;
    /** Grants a site, or everywhere, for one of the person's sources. Granting it again changes nothing. */
    readonly grant: (
      input: SignInGrantInput,
    ) => Effect.Effect<SignInGrantList, SqlError | SignInGrantError>;
    /** Revokes a grant in force; the next sign-in it covered asks again. Unknown ids change nothing. */
    readonly revoke: (id: string) => Effect.Effect<SignInGrantList, SqlError>;
    /**
     * The login service's check before a sign-in at `origin`, for a turn
     * `requester` asked for. The person's own source signs in only for their
     * own turns; a folder's grants decide for its turns whoever is talking.
     */
    readonly check: (input: {
      readonly requester: string;
      readonly source: SignInSource;
      readonly origin: string;
    }) => Effect.Effect<SignInCheck, SqlError>;
  }
>()("@signalbox/cloud/signIn/SignInGrants") {}

const sourceKey = (source: SignInSource) =>
  source._tag === "person" ? "person" : `folder:${source.folderId}`;

const sourceOf = (key: string): SignInSource =>
  key.startsWith("folder:")
    ? { _tag: "folder", folderId: FolderId.make(key.slice("folder:".length)) }
    : { _tag: "person" };

const decodeRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      source: Schema.String,
      site: Schema.String,
      granted_by: Schema.String,
      granted_at: Schema.Number,
    }),
  ),
);

const checks = Metric.counter("signalbox_cloud_sign_in_checks_total", {
  description: "Sign-in grant checks, by answer and source kind.",
});

export const layer = Layer.effect(
  SignInGrants,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const folders = yield* UserFolders.UserFolders;
    const owner = yield* makeProfileId;
    const changed = yield* PubSub.sliding<void>(1);
    /** Spans carry ids and the decision, never a site: which sites a person uses is theirs (#285). */
    const traced = makeTraced(owner);
    const sourceAttributes = (source: SignInSource) => ({
      "sign_in.source": source._tag,
      "folder.id": source._tag === "folder" ? source.folderId : undefined,
    });

    const toGrants = (rows: ReadonlyArray<unknown>): ReadonlyArray<SignInGrant> =>
      decodeRows(rows).map((row) => ({
        id: row.id,
        source: sourceOf(row.source),
        site: row.site,
        grantedBy: row.granted_by,
        grantedAt: row.granted_at,
      }));
    const grants = Effect.map(
      sql`SELECT id, source, site, granted_by, granted_at FROM sign_in_grants
        WHERE revoked_at IS NULL ORDER BY site = ${SIGN_IN_EVERYWHERE} DESC, site, granted_at`,
      (rows) => ({ grants: toGrants(rows) }),
    );
    /** One source's grants in force: what a check reads, on the `(source, site)` index. */
    const inForceFor = (key: string) =>
      Effect.map(
        sql`SELECT id, source, site, granted_by, granted_at FROM sign_in_grants
          WHERE revoked_at IS NULL AND source = ${key}`,
        toGrants,
      );

    const changes: SignInGrants["Service"]["changes"] = Stream.unwrap(
      Effect.map(PubSub.subscribe(changed), (subscription) =>
        Stream.fromSubscription(subscription).pipe(
          Stream.prepend([undefined]),
          Stream.mapEffect(() => grants),
        ),
      ),
    );

    const refuse = (message: string) => Effect.fail(new SignInGrantError({ message }));

    const grant: SignInGrants["Service"]["grant"] = (input) =>
      Effect.gen(function* () {
        const person = yield* owner;
        if (person === null) return yield* refuse("Sign in to Signalbox first.");
        const site = grantSiteOf(input.site);
        if (site === null) return yield* refuse(NOT_A_SITE);
        if (input.source._tag === "folder") {
          const { folderId } = input.source;
          const tree = yield* folders.snapshot;
          if (!tree.folders.some((folder) => folder.id === folderId)) {
            return yield* refuse("That folder isn't one of yours anymore.");
          }
        }
        yield* Effect.annotateCurrentSpan(
          "sign_in.everywhere",
          String(site === SIGN_IN_EVERYWHERE),
        );
        const key = sourceKey(input.source);
        const added = yield* sql.withTransaction(
          Effect.gen(function* () {
            const [existing] = yield* sql<{ readonly id: string }>`SELECT id FROM sign_in_grants
              WHERE revoked_at IS NULL AND source = ${key} AND site = ${site}`;
            if (existing !== undefined) return false;
            const [held] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n
              FROM sign_in_grants WHERE revoked_at IS NULL AND source = ${key}`;
            if ((held?.n ?? 0) >= MAX_GRANTS) {
              return yield* refuse("Revoke a site agents no longer need first.");
            }
            const id = yield* Effect.orDie(crypto.randomUUIDv4());
            const now = yield* Clock.currentTimeMillis;
            yield* sql`INSERT INTO sign_in_grants (id, source, site, granted_by, granted_at)
              VALUES (${id}, ${key}, ${site}, ${person}, ${now})`;
            return true;
          }),
        );
        if (added) yield* PubSub.publish(changed, undefined);
        return yield* grants;
      }).pipe(traced("SignInGrants.grant", sourceAttributes(input.source)));

    const revoke: SignInGrants["Service"]["revoke"] = (id) =>
      Effect.gen(function* () {
        const person = yield* owner;
        const now = yield* Clock.currentTimeMillis;
        const revoked = yield* sql<{ readonly id: string }>`UPDATE sign_in_grants
          SET revoked_by = ${person}, revoked_at = ${now}
          WHERE id = ${id} AND revoked_at IS NULL RETURNING id`;
        if (revoked.length > 0) yield* PubSub.publish(changed, undefined);
        return yield* grants;
      }).pipe(traced("SignInGrants.revoke", { "sign_in.grant_id": id }));

    const check: SignInGrants["Service"]["check"] = (input) =>
      Effect.gen(function* () {
        const host = hostOf(input.origin);
        const site = host === null ? null : askSiteOf(host);
        if (host === null || site === null) {
          return { _tag: "refused", message: NOT_A_SITE } as const;
        }
        if (input.source._tag === "person" && input.requester !== (yield* owner)) {
          return { _tag: "not-owner" } as const;
        }
        const covering = narrowestCovering(yield* inForceFor(sourceKey(input.source)), host);
        return covering === null
          ? ({ _tag: "ask", site } as const)
          : ({ _tag: "allowed", grant: covering } as const);
      }).pipe(
        Effect.tap((answer) =>
          Effect.all([
            Effect.annotateCurrentSpan("sign_in.answer", answer._tag),
            Metric.update(
              Metric.withAttributes(checks, {
                answer: answer._tag,
                source: input.source._tag,
              }),
              1,
            ),
          ]),
        ),
        traced("SignInGrants.check", {
          ...sourceAttributes(input.source),
          "requester.id": input.requester,
        }),
      );

    return SignInGrants.of({ grants, changes, grant, revoke, check });
  }),
);
