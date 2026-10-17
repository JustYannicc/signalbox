import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import {
  STATUS_NEXT_STEP_MAX_LENGTH,
  STATUS_WHERE_IT_GOT_TO_MAX_LENGTH,
  ThreadStatusNoteInput,
  type ThreadStatusNote,
} from "@t3tools/contracts/signalboxStatusLine";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * What the runtime asks a small model when a turn ended without its agent
 * writing the thread's status note (`statusNotePolicy.ts`), and how its
 * answer becomes a note. Pure, so tests read the exact prompt.
 */

/** Characters of each message the model reads: enough for the gist, cheap to send. */
const MESSAGE_CHARS = 3_000;

export const NOTE_SYSTEM = [
  "You write the status line of a work thread, for someone who has never seen it: a new teammate, or its owner a week from now.",
  'Answer with JSON only: {"nextStep": "...", "whereItGotTo": "..."}.',
  `nextStep: one line, at most ${STATUS_NEXT_STEP_MAX_LENGTH} characters: what has to happen next, and who does it ("You: ..." for the person, "Agent: ..." for the agent).`,
  `whereItGotTo: one or two plain sentences, at most ${STATUS_WHERE_IT_GOT_TO_MAX_LENGTH} characters: what was done and where the work stands.`,
  "Plain language. No jargon, no file paths, ids or shorthand from inside the thread. Never invent progress the messages don't show.",
].join("\n");

const ENDINGS: Partial<Record<OrchestrationV2Run["status"], string>> = {
  completed: "The turn finished normally.",
  failed: "The turn failed before it finished.",
  interrupted: "The turn was stopped before it finished.",
};

const cut = (text: string) =>
  text.length <= MESSAGE_CHARS ? text : `${text.slice(0, MESSAGE_CHARS)}…`;

/** The user message and the agent's last reply of `run`, as the thread holds them. */
const messagesOf = (projection: OrchestrationV2ThreadProjection, run: OrchestrationV2Run) => {
  const asked = projection.messages.find((message) => message.id === run.userMessageId);
  const replies = projection.messages.filter(
    (message) => message.runId === run.id && message.role === "assistant" && message.text !== "",
  );
  return { asked: asked?.text ?? "", answered: replies.at(-1)?.text ?? "" };
};

/** The user turn of the request: the thread, the run and the note before it. */
export const notePrompt = (
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
  previous: ThreadStatusNote | null,
): string => {
  const { asked, answered } = messagesOf(projection, run);
  return [
    `Thread title: ${projection.thread.title}`,
    `How the turn ended: ${ENDINGS[run.status] ?? "It ended."}`,
    previous === null
      ? "Previous status line: none."
      : `Previous status line:\nNext step: ${previous.nextStep}\nWhere it got to: ${previous.whereItGotTo}`,
    `The person asked:\n${cut(asked) || "(nothing written)"}`,
    `The agent's last reply:\n${cut(answered) || "(no reply)"}`,
  ].join("\n\n");
};

const RawNote = Schema.fromJsonString(
  Schema.Struct({ nextStep: Schema.String, whereItGotTo: Schema.String }),
);
const decodeRaw = Schema.decodeUnknownOption(RawNote);
const decodeInput = Schema.decodeUnknownOption(ThreadStatusNoteInput);

/** `text` on one line, cut to `max` characters with an ellipsis. */
const fit = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

/** The model's answer as a note's input; null when it isn't one. Tolerates a fenced block around the JSON. */
export const parseNote = (answer: string): ThreadStatusNoteInput | null => {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const raw = decodeRaw(answer.slice(start, end + 1));
  if (Option.isNone(raw)) return null;
  return Option.getOrNull(
    decodeInput({
      nextStep: fit(raw.value.nextStep, STATUS_NEXT_STEP_MAX_LENGTH),
      whereItGotTo: fit(raw.value.whereItGotTo, STATUS_WHERE_IT_GOT_TO_MAX_LENGTH),
    }),
  );
};
