import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as KindClassifier from "./KindClassifier.ts";

/** A provider that answers `reply` (or never, for null), recording what it was sent. */
const fakeProvider = (reply: (() => Response) | null) => {
  const sent: Array<{ url: string; authorization: string | undefined; body: any }> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const bytes = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
      sent.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(new TextDecoder().decode(bytes)),
      });
      if (reply === null) return yield* Effect.never;
      return HttpClientResponse.fromWeb(request, reply());
    }),
  );
  return { sent, http: Layer.succeed(HttpClient.HttpClient, client) };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const jev = { provider: "jev", apiKey: Redacted.make("ts_key") } as const;
const openai = { provider: "openai", apiKey: Redacted.make("sk_key") } as const;

const classify = (
  settings: KindClassifier.KindClassifierSettings,
  http: Layer.Layer<HttpClient.HttpClient>,
  question: KindClassifier.KindQuestion = { title: "Fix login", firstMessage: "The button 500s" },
) =>
  KindClassifier.KindClassifier.use((classifier) => classifier.classify(question)).pipe(
    Effect.provide(KindClassifier.layer(settings).pipe(Layer.provide(http))),
  );

describe("KindClassifier", () => {
  it.effect("asks Jev the benchmark's question and reads its choice", () =>
    Effect.gen(function* () {
      const provider = fakeProvider(() =>
        json({
          model: "jev-2026-09",
          answers: { kind: { choice: "chat", confidence: 0.91 } },
          usage: { input_tokens: 212 },
        }),
      );
      const long = "é".repeat(5000);
      const kind = yield* classify(jev, provider.http, { title: "Hmm", firstMessage: long });
      expect(kind).toEqual(Option.some("chat"));
      const [request] = provider.sent;
      expect(request?.url).toBe(KindClassifier.JEV_URL);
      expect(request?.authorization).toBe("Bearer ts_key");
      expect(request?.body.model).toBe("jev-latest");
      expect(request?.body.state).toEqual({ title: "Hmm", firstMessage: "é".repeat(4000) });
      expect(request?.body.questions.kind.type).toBe("choice");
      expect(request?.body.questions.kind.instructions).toMatch(/^A person started a thread/);
      expect(Object.keys(request?.body.questions.kind.criteria)).toEqual(["task", "chat"]);
    }),
  );

  it.effect("asks OpenAI's Decisions API, and a refusal is no answer", () =>
    Effect.gen(function* () {
      const answering = fakeProvider(() =>
        json({
          model: "gpt-6-luna",
          answers: [{ type: "choice", choice: "task", confidence: 0.8 }],
          usage: { input_tokens: 190 },
        }),
      );
      expect(yield* classify(openai, answering.http)).toEqual(Option.some("task"));
      const [request] = answering.sent;
      expect(request?.url).toBe(KindClassifier.OPENAI_DECISIONS_URL);
      expect(request?.authorization).toBe("Bearer sk_key");
      expect(request?.body.model).toBe("gpt-6-luna");
      expect(JSON.parse(request?.body.input)).toEqual({
        title: "Fix login",
        firstMessage: "The button 500s",
      });
      expect(request?.body.questions[0].name).toBe("kind");
      expect(request?.body.questions[0].choices.map((choice: any) => choice.value)).toEqual([
        "task",
        "chat",
      ]);

      const refusing = fakeProvider(() =>
        json({ model: "gpt-6-luna", answers: [{ type: "refusal" }], usage: { input_tokens: 5 } }),
      );
      expect(yield* classify(openai, refusing.http)).toEqual(Option.none());
    }),
  );

  it.effect("answers none when the provider fails or says something else", () =>
    Effect.gen(function* () {
      const down = fakeProvider(() => json({ error: "overloaded" }, 503));
      expect(yield* classify(jev, down.http)).toEqual(Option.none());
      const odd = fakeProvider(() =>
        json({ model: "jev", answers: { kind: { choice: "maybe" } }, usage: { input_tokens: 1 } }),
      );
      expect(yield* classify(jev, odd.http)).toEqual(Option.none());
    }),
  );

  it.effect("gives up after a second and a half", () =>
    Effect.gen(function* () {
      const silent = fakeProvider(null);
      const fiber = yield* Effect.forkChild(classify(openai, silent.http));
      yield* TestClock.adjust(1499);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(1);
      expect(yield* Fiber.join(fiber)).toEqual(Option.none());
    }),
  );

  it("picks the provider the env names, else whichever key is set, Jev first", () => {
    const pick = (env: KindClassifier.KindClassifierEnv) =>
      KindClassifier.settingsFromEnv(env)?.provider ?? null;
    expect(pick({})).toBeNull();
    expect(pick({ TYPESAFE_API_KEY: "", OPENAI_API_KEY: "" })).toBeNull();
    expect(pick({ OPENAI_API_KEY: "sk" })).toBe("openai");
    expect(pick({ OPENAI_API_KEY: "sk", TYPESAFE_API_KEY: "ts" })).toBe("jev");
    expect(
      pick({ THREAD_KIND_CLASSIFIER: "openai", OPENAI_API_KEY: "sk", TYPESAFE_API_KEY: "ts" }),
    ).toBe("openai");
    // Named but without its key: nothing to ask.
    expect(pick({ THREAD_KIND_CLASSIFIER: "jev", OPENAI_API_KEY: "sk" })).toBeNull();
  });
});
