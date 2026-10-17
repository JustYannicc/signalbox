import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeGitHubWebhookStore } from "./githubWebhookStore.ts";

const input = {
  id: "subscription-1",
  projectId: "folder-1",
  repository: "owner/repo",
  secret: "test-secret",
  events: ["pull_request"],
};

describe("GitHub subscription transitions", () => {
  it.effect("schedules immediate work with a timestamp Cloudflare accepts", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const store = yield* makeGitHubWebhookStore;
      expect(yield* store.nextAt).toBeNull();
      yield* store.insert(input);
      expect(yield* store.nextAt).toBe(1_000_000);
      yield* store.ready(input.id, 42, JSON.stringify(input.events));
      expect(yield* store.nextAt).toBeNull();
      yield* store.disable(input.id);
      expect(yield* store.nextAt).toBe(1_000_000);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("removes a hook installed while its automation was being paused", () =>
    Effect.gen(function* () {
      const store = yield* makeGitHubWebhookStore;
      yield* store.insert(input);
      yield* store.disable(input.id);
      yield* store.ready(input.id, 42, JSON.stringify(input.events));
      expect(yield* store.get(input.id)).toMatchObject({ enabled: 0, hook_id: 42, retry_at: 0 });
      yield* store.remove(input.id);
      expect(yield* store.get(input.id)).toBeUndefined();
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("reinstalls a hook when the automation resumes during remote removal", () =>
    Effect.gen(function* () {
      const store = yield* makeGitHubWebhookStore;
      yield* store.insert(input);
      yield* store.ready(input.id, 42, JSON.stringify(input.events));
      yield* store.disable(input.id);
      yield* store.want(input.id, input.events);
      yield* store.remove(input.id);
      expect(yield* store.get(input.id)).toMatchObject({ enabled: 1, hook_id: null, retry_at: 0 });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
