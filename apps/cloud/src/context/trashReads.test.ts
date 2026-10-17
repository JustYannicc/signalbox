import { ProjectId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { threadEvent } from "../thread/threadEvents.ts";
import {
  freshDatabase,
  launch,
  owner,
  threadObjectApiFor,
  withObject,
} from "../thread/ThreadTestKit.ts";

it.effect("context reads include archived history and refuse trashed history immediately", () =>
  withObject(freshDatabase(), (engine, _runner, context) =>
    Effect.gen(function* () {
      yield* launch(engine);
      const projectId = ProjectId.make("scratch");
      const teammate = { ...owner, userId: "other-person" };
      expect(yield* engine.contextWorkVisible(teammate, projectId)).toBe(true);
      expect(yield* engine.contextWorkVisible({ ...teammate, contextIds: [] }, projectId)).toBe(
        false,
      );
      expect(yield* engine.contextWorkVisible(teammate, ProjectId.make("other-project"))).toBe(
        false,
      );
      const api = threadObjectApiFor(context);
      yield* engine.apply((projection, ctx) =>
        Effect.succeed({
          events: [
            threadEvent(ctx, "thread.archived", {
              ...projection!.thread,
              archivedAt: ctx.now,
              updatedAt: ctx.now,
            }),
          ],
          result: undefined,
        }),
      );
      expect(yield* Effect.promise(() => api.contextMatch(owner, ["hi"]))).not.toBeNull();
      expect((yield* Effect.promise(() => api.contextTurns(owner, 1)))?.turns).toHaveLength(1);
      // Delete commands are not exposed in cloud yet. Apply the persisted trash state directly.
      yield* engine.apply((projection, ctx) =>
        Effect.succeed({
          events: [
            threadEvent(ctx, "thread.deleted", {
              ...projection!.thread,
              deletedAt: ctx.now,
              updatedAt: ctx.now,
            }),
          ],
          result: undefined,
        }),
      );
      expect(yield* engine.contextWorkVisible(teammate, projectId)).toBe(false);
      expect(yield* Effect.promise(() => api.contextMatch(owner, ["hi"]))).toBeNull();
      expect(yield* Effect.promise(() => api.contextTurns(owner, 1))).toBeNull();
    }),
  ),
);
