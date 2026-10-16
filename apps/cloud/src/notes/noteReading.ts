import { type NoteReader as NoteReaderKind, NoteReading } from "@t3tools/contracts/signalboxNotes";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ServedModel } from "../pool/cliProxyApi.ts";

/**
 * What a note's reader asks a model and makes of its answer, kept apart from
 * the call (`NoteReader.ts`) so it's tested without a pool. The reader is
 * deliberately shy: most notes are just notes, and a wrong offer costs the
 * person attention, so anything short of a clear answer is no reading.
 */

export interface ReadingPrompt {
  readonly reader: NoteReaderKind;
  /** The folder whose pad the note is on; null for the top level. */
  readonly folderName: string | null;
  readonly text: string;
  /** Other recent notes on the same pad the reader may see, newest first. */
  readonly context: ReadonlyArray<{ readonly text: string; readonly createdAt: number }>;
  readonly now: number;
}

/** The most other notes a read is given. */
export const CONTEXT_NOTES = 10;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const dayOf = (ms: number) => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(ms));

export const systemPrompt = (prompt: ReadingPrompt) => {
  const pad = prompt.folderName === null ? "their top level" : `the "${prompt.folderName}" folder`;
  const who =
    prompt.reader === "folder"
      ? `the agent of the "${prompt.folderName}" folder, reading a note its team can see`
      : "the person's own assistant, reading a note only they can see";
  return [
    `You are ${who}. The person keeps a notes pad for ${pad} and just wrote the note below: a half-formed thought, not a request. A note carries no obligation, and most notes are just notes.`,
    "",
    "Decide whether the note clearly implies a piece of work an AI agent could do, now or once something happens. Offer it only if it clearly does. If you are unsure, or it's a reminder only a person can act on, a fact to remember, a feeling, or too vague to act on, answer unclear. A wrong offer costs the person's attention, so prefer unclear.",
    "",
    "Answer with one JSON object and nothing else, no prose and no code fences:",
    '{"kind":"offer","meaning":"…","action":"Start a task to …"}',
    '{"kind":"offer","meaning":"…","action":"…","condition":{"kind":"pullRequestMerged","number":456}}',
    '{"kind":"offer","meaning":"…","action":"…","condition":{"kind":"date","on":"YYYY-MM-DD"}}',
    '{"kind":"unclear"}',
    "",
    "- meaning: what the person meant, in one short sentence of your own. Don't repeat their words back.",
    '- action: what you would do if they say OK, in one sentence starting with a verb, like "Start a task to …".',
    '- condition: only when the note itself says the work waits for something: a pull request merging ("after #456 merges") or a day ("on Friday"). Resolve days against today. Leave it out otherwise.',
    "- The other notes on the pad are context. Read only the new note.",
  ].join("\n");
};

export const userPrompt = (prompt: ReadingPrompt) => {
  const today = DateTime.makeUnsafe(prompt.now);
  const weekday = WEEKDAYS[DateTime.toPartsUtc(today).weekDay];
  const others =
    prompt.context.length === 0
      ? ["(none)"]
      : prompt.context
          .slice(0, CONTEXT_NOTES)
          .map((note) => `- ${dayOf(note.createdAt)}: ${note.text.replaceAll("\n", " ")}`);
  return [
    `Today is ${DateTime.formatIsoDateUtc(today)} (${weekday}).`,
    `Pad: ${prompt.folderName === null ? "top level" : `"${prompt.folderName}"`}`,
    "",
    "Other recent notes on this pad, newest first:",
    ...others,
    "",
    "The new note:",
    '"""',
    prompt.text,
    '"""',
  ].join("\n");
};

/** How a model is asked: Anthropic's Messages API or OpenAI's Responses API, as the ModelGateway serves them. */
export type ModelFamily = "anthropic" | "openai";

/** The API a served model is asked through, by whose it is; null for a provider not read with. */
export const familyOf = (model: ServedModel): ModelFamily | null =>
  model.ownedBy === "anthropic" || model.ownedBy === "openai" ? model.ownedBy : null;

/**
 * Small and fast first: reading a note is a short judgment. Never a Fable or
 * Astra model, which are far too expensive for it.
 */
const PREFERENCE: ReadonlyArray<(id: string) => boolean> = [
  (id) => id.startsWith("claude-haiku-"),
  (id) => /^gpt-.*-luna/.test(id),
  (id) => /(^|[-_.])mini([-_.]|$)/.test(id),
  (id) => id.startsWith("claude-sonnet-5-5"),
  (id) => id.startsWith("claude-opus-5-5"),
  (id) => id.startsWith("gpt-6.1-sol"),
];

/**
 * The model to read with from those a pool serves, newest first within a
 * tier, and the API it's asked through; null when none fits.
 */
export const pickModel = (
  served: ReadonlyArray<ServedModel>,
): { readonly id: string; readonly family: ModelFamily } | null => {
  const usable = served
    .flatMap((model) => {
      const family = familyOf(model);
      return family === null || /fable|astra/i.test(model.id) ? [] : [{ id: model.id, family }];
    })
    .toSorted((left, right) => right.id.localeCompare(left.id));
  for (const matches of PREFERENCE) {
    const found = usable.find((model) => matches(model.id));
    if (found !== undefined) return found;
  }
  return null;
};

const MAX_TOKENS = 600;

/** The request for `family`'s API: path and JSON body, non-streaming. */
export const requestFor = (family: ModelFamily, model: string, prompt: ReadingPrompt) =>
  family === "anthropic"
    ? {
        path: "/v1/messages",
        headers: { "anthropic-version": "2023-06-01" },
        body: {
          model,
          max_tokens: MAX_TOKENS,
          system: systemPrompt(prompt),
          messages: [{ role: "user", content: userPrompt(prompt) }],
        },
      }
    : {
        path: "/v1/responses",
        headers: {},
        body: {
          model,
          instructions: systemPrompt(prompt),
          input: userPrompt(prompt),
          max_output_tokens: MAX_TOKENS,
        },
      };

const AnthropicReply = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
});
const OpenAIReply = Schema.Struct({
  output: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      content: Schema.optional(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      ),
    }),
  ),
});
const decodeAnthropic = Schema.decodeUnknownOption(AnthropicReply);
const decodeOpenAI = Schema.decodeUnknownOption(OpenAIReply);

/** The model's text from `family`'s reply body, or none. */
export const replyText = (family: ModelFamily, json: unknown): Option.Option<string> =>
  family === "anthropic"
    ? Option.map(decodeAnthropic(json), (reply) =>
        reply.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join(""),
      )
    : Option.map(decodeOpenAI(json), (reply) =>
        reply.output
          .flatMap((item) => (item.type === "message" ? (item.content ?? []) : []))
          .flatMap((part) => (part.type === "output_text" ? [part.text ?? ""] : []))
          .join(""),
      );

const Answer = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("offer"),
    meaning: Schema.String,
    action: Schema.String,
    condition: Schema.optional(
      Schema.NullOr(
        Schema.Union([
          Schema.Struct({ kind: Schema.Literal("pullRequestMerged"), number: Schema.Number }),
          Schema.Struct({ kind: Schema.Literal("date"), on: Schema.String }),
        ]),
      ),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("unclear") }),
]);
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer));
const decodeReading = Schema.decodeUnknownOption(NoteReading);

/**
 * What the model's text says, as a reading by `reader`: the first JSON object
 * in it, held to the contract. Anything else is none.
 */
export const readingOf = (reader: NoteReaderKind, text: string): Option.Option<NoteReading> => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) return Option.none();
  return Option.flatMap(decodeAnswer(text.slice(start, end + 1)), (answer) =>
    decodeReading(
      answer.kind === "unclear"
        ? { _tag: "unclear", reader }
        : {
            _tag: "offer",
            reader,
            meaning: answer.meaning.trim(),
            action: answer.action.trim(),
            ...(answer.condition == null
              ? {}
              : {
                  condition:
                    answer.condition.kind === "date"
                      ? { _tag: "date", on: answer.condition.on }
                      : { _tag: "pullRequestMerged", number: answer.condition.number },
                }),
            dismissed: false,
          },
    ),
  );
};
