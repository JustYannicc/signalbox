import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PoolDirectory from "../pool/PoolDirectory.ts";
import * as LearnerJev from "./LearnerJev.ts";
import * as LearnerSummary from "./LearnerSummary.ts";

const learned = {
  text: "When Acme asks about release 123, Alice waits for checks.",
  ownerStated: false,
  supports: 2,
  misses: 0,
  hitRate: 1,
};
const stated = { ...learned, text: "Wait for checks before releasing.", ownerStated: true };
const abstract = "When releasing, wait for checks.";
const decodeBody = Schema.decodeUnknownSync(Schema.Unknown);

const responseText = (text: string) => ({
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
});

const fixture = (reply: unknown, safe: boolean, status = 200) => {
  const calls: Array<{ objectName: string; userId: string; path: string; body: unknown }> = [];
  const directory = {
    forPool: () => ({
      models: () =>
        Effect.succeed({
          checkedAt: 1,
          models: [{ id: "gpt-6.1-sol", ownedBy: "openai", created: null }],
        }),
    }),
  } as unknown as PoolDirectory.PoolDirectory["Service"];
  const modelsOf = (objectName: string): PoolDirectory.PoolModelApi => ({
    forwardModel: async (actor, path, request) => {
      calls.push({
        objectName,
        userId: actor.userId,
        path,
        body: decodeBody(await request.json()),
      });
      return { _tag: "forwarded", response: Response.json(reply, { status }), upstreamMs: 1 };
    },
  });
  const judge = Layer.succeed(LearnerJev.LearnerJev, {
    ...LearnerJev.LearnerJev.of({
      classifyPair: () => Effect.succeedNone,
      matchDraft: () => Effect.succeedNone,
      relevance: () => Effect.succeed([]),
      outcome: () => Effect.succeedNone,
      coverage: () => Effect.succeedNone,
      summarySafe: () => Effect.succeed(safe),
    }),
  });
  const layer = LearnerSummary.layer(modelsOf).pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(PoolDirectory.PoolDirectory, directory), judge)),
  );
  return { calls, layer };
};

describe("learner summaries across levels", () => {
  it.effect(
    "uses the lower level's pool and returns checked abstractions with the original stats",
    () =>
      Effect.gen(function* () {
        const external = fixture(responseText(JSON.stringify({ text: abstract })), true);
        const result = yield* LearnerSummary.LearnerSummary.use((service) =>
          service.summarize({
            pool: { objectName: "lower-pool", userId: "owner" },
            lenses: [learned, stated],
          }),
        ).pipe(Effect.provide(external.layer));
        expect(result).toEqual([stated, { ...learned, text: abstract }]);
        expect(external.calls).toHaveLength(1);
        expect(external.calls[0]).toMatchObject({
          objectName: "lower-pool",
          userId: "owner",
          path: "/v1/responses",
          body: { model: "gpt-6.1-sol", store: false },
        });
        expect(result.map((lens) => lens.text).join(" ")).not.toContain("Alice");
      }),
  );

  it.effect("omits a private echo or a failed abstraction instead of returning raw evidence", () =>
    Effect.gen(function* () {
      for (const [reply, safe, status] of [
        [responseText(JSON.stringify({ text: learned.text })), false, 200],
        [responseText("not JSON"), true, 200],
        [{ error: "unavailable" }, true, 503],
      ] as const) {
        const external = fixture(reply, safe, status);
        expect(
          yield* LearnerSummary.LearnerSummary.use((service) =>
            service.summarize({
              pool: { objectName: "lower-pool", userId: "owner" },
              lenses: [learned, stated],
            }),
          ).pipe(Effect.provide(external.layer)),
        ).toEqual([stated]);
      }
    }),
  );

  it.effect(
    "keeps explicit rules available without a pool and never exposes learned evidence as fallback",
    () =>
      Effect.gen(function* () {
        const external = fixture({}, true);
        expect(
          yield* LearnerSummary.LearnerSummary.use((service) =>
            service.summarize({ pool: null, lenses: [learned, stated] }),
          ).pipe(Effect.provide(external.layer)),
        ).toEqual([stated]);
        expect(external.calls).toEqual([]);
      }),
  );
});
