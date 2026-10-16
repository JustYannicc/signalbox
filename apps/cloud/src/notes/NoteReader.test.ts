import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ServedModel } from "../pool/cliProxyApi.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import * as NoteReader from "./NoteReader.ts";
import { pickModel, readingOf, replyText, userPrompt } from "./noteReading.ts";

// 2026-10-16, a Friday.
const NOW = Date.UTC(2026, 9, 16, 9);

const claude = (id: string) => ({ id, ownedBy: "anthropic", created: null });
const gpt = (id: string) => ({ id, ownedBy: "openai", created: null });
const other = (id: string) => ({ id, ownedBy: "google", created: null });

describe("pickModel", () => {
  it("prefers small, fast models and never picks Fable or Astra", () => {
    const pick = (served: Parameters<typeof pickModel>[0]) => pickModel(served)?.id ?? null;
    expect(
      pick([
        claude("claude-opus-5-5"),
        gpt("gpt-6-luna"),
        claude("claude-haiku-4-5"),
        claude("claude-haiku-5-5"),
      ]),
    ).toBe("claude-haiku-5-5");
    expect(pick([claude("claude-opus-5-5"), gpt("gpt-6.1-sol"), gpt("gpt-6-luna")])).toBe(
      "gpt-6-luna",
    );
    expect(pick([claude("claude-opus-5-5"), gpt("gpt-5-mini"), other("gemini-2.5-pro")])).toBe(
      "gpt-5-mini",
    );
    expect(pick([gpt("gpt-6.1-sol"), claude("claude-opus-5-5"), claude("claude-sonnet-5-5")])).toBe(
      "claude-sonnet-5-5",
    );
    expect(
      pick([claude("claude-fable-5-1"), gpt("gpt-6-astra"), other("gemini-2.5-pro")]),
    ).toBeNull();
  });

  it("asks a model through the API of whose it is, not what its name looks like", () => {
    expect(pickModel([gpt("claude-haiku-5-5")])).toEqual({
      id: "claude-haiku-5-5",
      family: "openai",
    });
    expect(pickModel([other("gpt-5-mini")])).toBeNull();
  });
});

describe("readingOf", () => {
  it("holds the model's answer to the contract, and makes nothing of anything else", () => {
    expect(
      readingOf(
        "folder",
        'Sure:\n```json\n{"kind":"offer","meaning":" Ship the fix. ","action":"Start a task to ship it.","condition":{"kind":"pullRequestMerged","number":456}}\n```',
      ),
    ).toEqual(
      Option.some({
        _tag: "offer",
        reader: "folder",
        meaning: "Ship the fix.",
        action: "Start a task to ship it.",
        condition: { _tag: "pullRequestMerged", number: 456 },
        dismissed: false,
      }),
    );
    expect(readingOf("assistant", '{"kind":"unclear"}')).toEqual(
      Option.some({ _tag: "unclear", reader: "assistant" }),
    );
    expect(
      readingOf(
        "assistant",
        '{"kind":"offer","meaning":"x","action":"y","condition":{"kind":"date","on":"Friday"}}',
      ),
    ).toEqual(Option.none());
    expect(readingOf("assistant", '{"kind":"offer","meaning":"","action":"y"}')).toEqual(
      Option.none(),
    );
    expect(readingOf("assistant", "I think you meant to call the bank.")).toEqual(Option.none());
  });
});

describe("replyText", () => {
  it("reads the text of both APIs' replies", () => {
    expect(
      replyText("anthropic", {
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toEqual(Option.some("ab"));
    expect(
      replyText("openai", {
        output: [
          { type: "reasoning", summary: [] },
          { type: "message", content: [{ type: "output_text", text: "c" }] },
        ],
      }),
    ).toEqual(Option.some("c"));
    expect(replyText("openai", { error: "nope" })).toEqual(Option.none());
  });
});

describe("userPrompt", () => {
  it("gives the date and weekday, the pad and the other notes, newest first", () => {
    const prompt = userPrompt({
      reader: "folder",
      folderName: "Payments",
      text: "after #456 merges, switch issuers",
      context: [{ text: "rotate\nkeys", createdAt: Date.UTC(2026, 9, 14) }],
      now: NOW,
    });
    expect(prompt).toContain("Today is 2026-10-16 (Friday).");
    expect(prompt).toContain('Pad: "Payments"');
    expect(prompt).toContain("- 2026-10-14: rotate keys");
    expect(prompt).toContain('"""\nafter #456 merges, switch issuers\n"""');
  });
});

/** A pool serving `models`, its model route answering `reply` and recording what it was sent. */
const fakePool = (models: ReadonlyArray<ServedModel>, reply: unknown) => {
  const sent: Array<{ readonly path: string; readonly body: unknown }> = [];
  const directory = PoolDirectory.PoolDirectory.of({
    forPool: () =>
      // Only `models` is asked of the pool here.
      ({
        models: () =>
          Effect.succeed({
            checkedAt: 1,
            models,
          }),
      }) as unknown as PoolDirectory.PoolHandle,
  });
  const route: PoolDirectory.PoolModelApi = {
    forwardModel: async (_actor, path, request) => {
      sent.push({ path, body: await request.json() });
      return { _tag: "forwarded", response: Response.json(reply), upstreamMs: 1 };
    },
  };
  return {
    sent,
    layer: NoteReader.layer(() => route).pipe(
      Layer.provide(Layer.succeed(PoolDirectory.PoolDirectory, directory)),
    ),
  };
};

const request: NoteReader.ReadRequest = {
  reader: "assistant",
  folderName: null,
  text: "renew the domain before it lapses",
  context: [],
  now: NOW,
  pool: { objectName: "user_1:personal", userId: "user_1" },
};

describe("NoteReader", () => {
  it.effect("asks the pool's smallest model through its route, and reads its answer", () => {
    const pool = fakePool([claude("claude-opus-5-5"), claude("claude-haiku-5-5")], {
      content: [
        {
          type: "text",
          text: '{"kind":"offer","meaning":"The domain expires soon.","action":"Start a task to renew it."}',
        },
      ],
    });
    return Effect.gen(function* () {
      const reading = yield* NoteReader.NoteReader.use((reader) => reader.read(request));
      expect(reading).toEqual(
        Option.some({
          _tag: "offer",
          reader: "assistant",
          meaning: "The domain expires soon.",
          action: "Start a task to renew it.",
          dismissed: false,
        }),
      );
      expect(pool.sent).toHaveLength(1);
      expect(pool.sent[0]).toMatchObject({
        path: "/v1/messages",
        body: { model: "claude-haiku-5-5", messages: [{ role: "user" }] },
      });
    }).pipe(Effect.provide(pool.layer));
  });

  it.effect("reads nothing without a pool or a model it may use", () => {
    const pool = fakePool([claude("claude-fable-5-1")], {});
    return Effect.gen(function* () {
      const read = (input: NoteReader.ReadRequest) =>
        NoteReader.NoteReader.use((reader) => reader.read(input));
      expect(yield* read({ ...request, pool: null })).toEqual(Option.none());
      expect(yield* read(request)).toEqual(Option.none());
      expect(pool.sent).toEqual([]);
    }).pipe(Effect.provide(pool.layer));
  });
});
