import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeGitHubApi } from "./GitHubApi.ts";
import { pollReleases, type ReleasePollStore } from "./githubReleasePoll.ts";
import type { SubscriptionRow } from "./githubWebhookStore.ts";

const repository = "owner/repo";

interface Release {
  readonly id: number;
  readonly tag_name: string;
  readonly name: string | null;
  readonly html_url: string;
  readonly prerelease: boolean;
  readonly draft: boolean;
  readonly published_at: string | null;
}

const release = (id: number, fields: Partial<Release> = {}): Release => ({
  id,
  tag_name: `v${id}`,
  name: null,
  html_url: `https://github.test/${repository}/releases/tag/v${id}`,
  prerelease: false,
  draft: false,
  published_at: "2026-10-16T12:00:00Z",
  ...fields,
});

const row = (poll_seeded: number): SubscriptionRow => ({
  id: "subscription-1",
  project_id: "project-1",
  repository,
  secret: "secret",
  hook_id: null,
  events_json: '["release"]',
  enabled: 1,
  error: null,
  retry_at: null,
  mode: "release-poll",
  poll_seeded,
});

const makeStore = (initialSeen: ReadonlyArray<number> = []) => {
  const seenIds = new Set(initialSeen);
  const checked: Array<number> = [];
  const marked: Array<number> = [];
  const polled: Array<string> = [];
  const store = {
    seen: (_subscriptionId: string, releaseId: number) =>
      Effect.sync(() => {
        checked.push(releaseId);
        return seenIds.has(releaseId);
      }),
    see: (_subscriptionId: string, releaseId: number) =>
      Effect.sync(() => {
        seenIds.add(releaseId);
        marked.push(releaseId);
      }),
    polled: (subscriptionId: string) =>
      Effect.sync(() => {
        polled.push(subscriptionId);
      }),
  } satisfies ReleasePollStore;
  return { store, checked, marked, polled };
};

const makeApi = (respond: (url: URL) => Response) => {
  const urls: Array<URL> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      urls.push(new URL(url));
      return HttpClientResponse.fromWeb(request, respond(url));
    }),
  );
  return {
    api: makeGitHubApi(client, { web: "https://github.test", api: "https://api.github.test" }),
    urls,
  };
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const poll = (
  api: ReturnType<typeof makeGitHubApi>,
  store: ReleasePollStore,
  subscription: SubscriptionRow,
  enqueue: Parameters<typeof pollReleases>[0]["enqueue"],
) => pollReleases({ api, token: "token", row: subscription, store, enqueue });

describe("GitHub release polling", () => {
  it.effect("seeds existing published releases without emitting historical events", () =>
    Effect.gen(function* () {
      const { api } = makeApi(() =>
        json([
          release(3),
          release(2, { draft: true }),
          release(1),
          release(4, { published_at: null }),
        ]),
      );
      const { store, checked, marked, polled } = makeStore();
      const enqueued: Array<{ key: string }> = [];

      yield* poll(api, store, row(0), (delivery) =>
        Effect.sync(() => {
          enqueued.push(delivery);
        }),
      );

      expect(enqueued).toEqual([]);
      expect(checked).toEqual([1, 3]);
      expect(marked).toEqual([1, 3]);
      expect(polled).toEqual(["subscription-1"]);
    }),
  );

  it.effect("enqueues each new release once across repeated polls", () =>
    Effect.gen(function* () {
      const { api } = makeApi(() => json([release(2), release(1)]));
      const { store } = makeStore([1]);
      const enqueued: Array<{ key: string; payload: { event: string; body: string } }> = [];
      const enqueue = (delivery: (typeof enqueued)[number]) =>
        Effect.sync(() => {
          enqueued.push(delivery);
        });

      yield* poll(api, store, row(1), enqueue);
      yield* poll(api, store, row(1), enqueue);

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]?.key).toBe("release:2");
      expect(enqueued[0]?.payload.event).toBe("release");
      expect(JSON.parse(enqueued[0]!.payload.body)).toMatchObject({
        action: "published",
        repository: { full_name: repository },
        release: { id: 2, tag_name: "v2" },
      });
    }),
  );

  it.effect("finds releases after a full page", () =>
    Effect.gen(function* () {
      const firstPage = Array.from({ length: 100 }, (_, index) => release(index + 1));
      const { api, urls } = makeApi((url) =>
        json(url.searchParams.get("page") === "1" ? firstPage : [release(101)]),
      );
      const { store } = makeStore();
      const enqueued: Array<{ key: string }> = [];

      yield* poll(api, store, row(1), (delivery) =>
        Effect.sync(() => {
          enqueued.push(delivery);
        }),
      );

      expect(urls.map((url) => url.searchParams.get("page"))).toEqual(["1", "2"]);
      expect(urls.map((url) => url.searchParams.get("per_page"))).toEqual(["100", "100"]);
      expect(enqueued.map(({ key }) => key)).toContain("release:101");
    }),
  );

  it.effect("fails before processing when the bounded release list is incomplete", () =>
    Effect.gen(function* () {
      const fullPage = Array.from({ length: 100 }, (_, index) => release(index + 1));
      const { api, urls } = makeApi(() => json(fullPage));
      const { store, checked, polled } = makeStore();
      const enqueued: Array<{ key: string }> = [];

      const error = yield* Effect.flip(
        poll(api, store, row(1), (delivery) =>
          Effect.sync(() => {
            enqueued.push(delivery);
          }),
        ),
      );

      expect(error.message).toContain("release list was incomplete");
      expect(urls).toHaveLength(10);
      expect(checked).toEqual([]);
      expect(enqueued).toEqual([]);
      expect(polled).toEqual([]);
    }),
  );
});
