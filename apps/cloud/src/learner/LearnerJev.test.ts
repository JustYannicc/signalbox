import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as LearnerJev from "./LearnerJev.ts";

const RequestBody = Schema.Struct({
  model: Schema.String,
  state: Schema.Unknown,
  questions: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RequestBody));
const provider = (reply: (() => Response) | null) => {
  const sent: Array<{
    url: string;
    authorization: string | undefined;
    body: typeof RequestBody.Type;
  }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      if (request.body._tag === "Uint8Array") {
        sent.push({
          url: request.url,
          authorization: request.headers.authorization,
          body: decodeRequest(new TextDecoder().decode(request.body.body)),
        });
      }
      return reply === null
        ? Effect.never
        : Effect.succeed(HttpClientResponse.fromWeb(request, reply()));
    }),
  );
  return {
    sent,
    layer: LearnerJev.layer({ apiKey: Redacted.make("test-key") }).pipe(Layer.provide(http)),
  };
};

const pair = {
  input: "Can we ship?",
  draft: "Ship after checks pass.",
  action: "Ship after checks pass.",
};
const candidate = {
  id: "lens-a",
  text: "Ship after checks pass.",
  reason: "Keep deploys reversible.",
};
const response = (answers: unknown) => Response.json({ model: "jev-latest", answers });

describe("learner Jev boundary", () => {
  it.effect("requires a high-probability safe abstraction before sharing learned text", () =>
    Effect.gen(function* () {
      for (const [probability, expected] of [
        [0.95, true],
        [0.5, false],
        [2, false],
      ] as const) {
        const external = provider(() => response({ safe: { type: "noul", noul: probability } }));
        expect(
          yield* LearnerJev.LearnerJev.use((judge) =>
            judge.summarySafe({
              original: "Alice chose to wait for checks on release 123.",
              summary: "When releasing, wait for checks.",
            }),
          ).pipe(Effect.provide(external.layer)),
        ).toBe(expected);
      }
    }),
  );
  it.effect("sends the paired decision to Jev and reads its typed classification", () =>
    Effect.gen(function* () {
      const external = provider(() =>
        response({ decision: { type: "choice", choice: "confirmed", confidence: 0.92 } }),
      );
      const result = yield* LearnerJev.LearnerJev.use((judge) => judge.classifyPair(pair)).pipe(
        Effect.provide(external.layer),
      );
      expect(result).toEqual(Option.some("confirmed"));
      expect(external.sent).toHaveLength(1);
      expect(external.sent[0]).toMatchObject({
        url: LearnerJev.JEV_URL,
        authorization: "Bearer test-key",
        body: { model: "jev-latest", state: pair },
      });
      expect(external.sent[0]?.body.questions.decision).toMatchObject({
        type: "choice",
        criteria: { confirmed: expect.any(String), ambiguous: expect.any(String) },
      });
    }),
  );

  it.effect("batches relevance judgments and keeps candidate ids in the response", () =>
    Effect.gen(function* () {
      const external = provider(() =>
        response({
          lens_0: { type: "noul", noul: 0.95 },
          lens_1: { type: "noul", noul: 0.02 },
        }),
      );
      const result = yield* LearnerJev.LearnerJev.use((judge) =>
        judge.relevance({
          task: "Ship this release",
          candidates: [candidate, { ...candidate, id: "lens-b", text: "Use short emails." }],
        }),
      ).pipe(Effect.provide(external.layer));
      expect(result).toEqual([
        { lensId: "lens-a", probability: 0.95 },
        { lensId: "lens-b", probability: 0.02 },
      ]);
      expect(external.sent).toHaveLength(1);
      expect(Object.keys(external.sent[0]!.body.questions)).toEqual(["lens_0", "lens_1"]);
    }),
  );

  it.effect("refuses unknown choices, invalid probabilities and unavailable services", () =>
    Effect.gen(function* () {
      for (const reply of [
        () => Response.json({ error: "unavailable" }, { status: 503 }),
        () => response({ decision: { type: "choice", choice: "invented", confidence: 0.99 } }),
        () => response({ decision: { type: "choice", choice: "confirmed", confidence: 2 } }),
        () => new Response("not json"),
      ]) {
        expect(
          yield* LearnerJev.LearnerJev.use((judge) => judge.classifyPair(pair)).pipe(
            Effect.provide(provider(reply).layer),
          ),
        ).toEqual(Option.none());
      }
      expect(
        yield* LearnerJev.LearnerJev.use((judge) =>
          judge.relevance({ task: "ship", candidates: [candidate] }),
        ).pipe(
          Effect.provide(provider(() => response({ lens_0: { type: "noul", noul: 2 } })).layer),
        ),
      ).toEqual([]);
      expect(
        yield* LearnerJev.LearnerJev.use((judge) =>
          judge.matchDraft({
            action: pair.action,
            candidates: [{ eventId: "draft-a", input: pair.input, draft: pair.draft }],
          }),
        ).pipe(
          Effect.provide(
            provider(() =>
              response({ match: { type: "choice", choice: "unknown-draft", confidence: 0.99 } }),
            ).layer,
          ),
        ),
      ).toEqual(Option.none());
    }),
  );

  it.effect("returns no judgment after the request deadline", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        LearnerJev.LearnerJev.use((judge) => judge.classifyPair(pair)).pipe(
          Effect.provide(provider(null).layer),
        ),
      );
      yield* TestClock.adjust(2500);
      expect(yield* Fiber.join(fiber)).toEqual(Option.none());
    }),
  );

  it.effect("requires clear coverage and preserves contradictions or uncertainty", () =>
    Effect.gen(function* () {
      for (const [choice, expected] of [
        ["clear", Option.some("clear")],
        ["contradiction", Option.some("contradiction")],
        ["unclear", Option.none()],
      ] as const) {
        const external = provider(() =>
          response({ coverage: { type: "choice", choice, confidence: 0.92 } }),
        );
        expect(
          yield* LearnerJev.LearnerJev.use((judge) =>
            judge.coverage({
              task: "Can we ship?",
              lens: candidate,
              otherLenses: [],
              precedents: [pair],
            }),
          ).pipe(Effect.provide(external.layer)),
        ).toEqual(expected);
        expect(external.sent[0]?.body.state).toMatchObject({
          task: "Can we ship?",
          precedents: [pair],
        });
      }
    }),
  );
});
