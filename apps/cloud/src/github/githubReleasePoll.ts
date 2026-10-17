import { AutomationError } from "@t3tools/contracts";
import { toJson } from "@signalbox/automations/json";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { GitHubApi } from "./GitHubApi.ts";
import type { SqlError } from "effect/sql/SqlError";
import type { SubscriptionRow } from "./githubWebhookStore.ts";

export interface ReleasePollStore {
  readonly seen: (id: string, releaseId: number) => Effect.Effect<boolean, SqlError>;
  readonly see: (id: string, releaseId: number) => Effect.Effect<unknown, SqlError>;
  readonly polled: (id: string) => Effect.Effect<unknown, SqlError>;
}

const Release = Schema.Struct({
  id: Schema.Number,
  tag_name: Schema.String,
  name: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  prerelease: Schema.Boolean,
  draft: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Release)));

/** A read-only upstream repository cannot grant hook admin. Its published releases use the same inbox. */
export const pollReleases = (input: {
  readonly api: GitHubApi;
  readonly token: string;
  readonly row: SubscriptionRow;
  readonly store: ReleasePollStore;
  readonly enqueue: (payload: {
    readonly key: string;
    readonly payload: { readonly event: string; readonly body: string };
  }) => Effect.Effect<unknown, AutomationError>;
}) =>
  Effect.gen(function* () {
    const { api, token, row, store } = input;
    const releases: Array<typeof Release.Type> = [];
    for (let page = 1; page <= 10; page++) {
      const response = yield* api.rest(
        "githubReleases",
        token,
        `/repos/${row.repository}/releases`,
        {
          per_page: "100",
          page: String(page),
        },
      );
      if (response === null)
        return yield* new AutomationError({
          message: "GitHub couldn't read the repository's releases.",
        });
      const items = yield* decode(response);
      releases.push(...items);
      if (items.length < 100) break;
      if (page === 10)
        return yield* new AutomationError({ message: "GitHub's release list was incomplete." });
    }
    for (const release of releases.toReversed()) {
      if (release.draft || release.published_at === null) continue;
      if (yield* store.seen(row.id, release.id)) continue;
      // First read is a baseline, not a thousand historical release triggers.
      if (row.poll_seeded === 1)
        yield* input.enqueue({
          key: `release:${release.id}`,
          payload: {
            event: "release",
            body: toJson({
              action: "published",
              repository: { full_name: row.repository },
              release,
            }),
          },
        });
      yield* store.see(row.id, release.id);
    }
    yield* store.polled(row.id);
  });
