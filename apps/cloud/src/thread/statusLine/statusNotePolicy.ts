import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { ThreadStatusNote } from "@t3tools/contracts/signalboxStatusLine";
import type { StatusNoteView } from "@signalbox/runner-protocol/StatusLineProtocol";
import * as DateTime from "effect/DateTime";

import type { ServedModel } from "../../pool/cliProxyApi.ts";
import { isHarnessInstance } from "../../models/ModelRouting.ts";
import { activeRun } from "../runLifecycle.ts";
import { isLiveRun } from "../runState.ts";
import type { StatusNoteCursor } from "./statusNoteTables.ts";

/**
 * When the runtime writes a thread's status note for its agent (#670), as
 * pure functions of the thread's runs, its note and the store's cursor. The
 * agent writes the note during every turn (`set_thread_status`); a turn that
 * ended without one covering it gets one written from the turn instead, at
 * least once, from the object's alarm (`ThreadStatusNotes.ts`). Only the
 * latest ended run matters: the note says where the thread is now.
 */

type Projection = OrchestrationV2ThreadProjection;
type Run = OrchestrationV2Run;
/** All the decisions read of a thread. */
type Runs = { readonly runs: ReadonlyArray<Run> };

/** How a run ends when its end changes what the thread's people should know. */
const NEEDS_NOTE: ReadonlySet<Run["status"]> = new Set(["completed", "failed", "interrupted"]);
const ENDED: ReadonlySet<Run["status"]> = new Set([...NEEDS_NOTE, "cancelled", "rolled_back"]);

/** Tries at writing one run's note before the runtime moves on without it. */
export const MAX_NOTE_ATTEMPTS = 4;

/** Wait after the `attempts`th failure: 15 s, then four times longer each time. */
export const noteRetryDelayMs = (attempts: number) => 15_000 * 4 ** (attempts - 1);

const START: StatusNoteCursor = { through: 0, attemptsFor: 0, attempts: 0, nextAt: 0 };

export type StatusNoteStep =
  /** Nothing to do until a run ends. */
  | { readonly _tag: "none" }
  /** Store `cursor` and look again: the run is covered, or not worth a note. */
  | { readonly _tag: "advance"; readonly cursor: StatusNoteCursor }
  /** A failed write backs off until `at`. */
  | { readonly _tag: "wait"; readonly at: number }
  /** Write `run`'s note; `attempt` counts from 1. */
  | { readonly _tag: "write"; readonly run: Run; readonly attempt: number };

export const decideStatusNote = (
  projection: Runs,
  note: ThreadStatusNote | null,
  stored: StatusNoteCursor | null,
  now: number,
): StatusNoteStep => {
  const cursor = stored ?? START;
  const runs = projection.runs.toSorted((left, right) => right.ordinal - left.ordinal);
  const latest = runs.find((run) => ENDED.has(run.status));
  if (latest === undefined || latest.ordinal <= cursor.through) return { _tag: "none" };
  // A newer turn runs: the note its end leaves is the one that counts.
  if (supersedes(projection, latest.id)) return { _tag: "none" };
  const done: StatusNoteCursor = { ...START, through: latest.ordinal };
  if (
    !NEEDS_NOTE.has(latest.status) ||
    // Only harness turns run on a pool that can write it; scripted ones are for tests.
    !isHarnessInstance(latest.providerInstanceId) ||
    note?.runId === latest.id
  ) {
    return { _tag: "advance", cursor: done };
  }
  const attempts = cursor.attemptsFor === latest.ordinal ? cursor.attempts : 0;
  if (attempts >= MAX_NOTE_ATTEMPTS) return { _tag: "advance", cursor: done };
  if (attempts > 0 && now < cursor.nextAt) return { _tag: "wait", at: cursor.nextAt };
  return { _tag: "write", run: latest, attempt: attempts + 1 };
};

/** The cursor after `attempt` at `run`'s note failed at `now`. */
export const afterFailedAttempt = (
  stored: StatusNoteCursor | null,
  run: Run,
  attempt: number,
  now: number,
): StatusNoteCursor => ({
  through: (stored ?? START).through,
  attemptsFor: run.ordinal,
  attempts: attempt,
  nextAt: now + noteRetryDelayMs(attempt),
});

/** The cursor once `run` has its note. */
export const afterWrite = (run: Run): StatusNoteCursor => ({ ...START, through: run.ordinal });

/** The run a note written now belongs to: the live one, else the latest, else none. */
export const noteRunId = (projection: Projection) =>
  (activeRun(projection) ?? projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0])?.id ??
  null;

/** Whether a run newer than `runId`'s is live: a note written for `runId` would be stale. */
export const supersedes = (projection: Runs, runId: string | null) => {
  const ordinal = projection.runs.find((run) => run.id === runId)?.ordinal ?? 0;
  return projection.runs.some((run) => run.ordinal > ordinal && isLiveRun(run));
};

/** What a note changes in the thread's summary, for its `summaryKey`. */
export const noteKey = (note: ThreadStatusNote | null) =>
  note === null
    ? null
    : [
        note.nextStep,
        note.whereItGotTo,
        note.writtenBy,
        note.runId,
        DateTime.toEpochMillis(note.writtenAt),
      ];

export const noteView = (note: ThreadStatusNote): StatusNoteView => ({
  nextStep: note.nextStep,
  whereItGotTo: note.whereItGotTo,
  writtenBy: note.writtenBy,
  writtenAt: DateTime.formatIso(note.writtenAt),
});

/** Anything this big or bigger: never for a note. */
const EXCLUDED_MODELS = /fable|astra/i;
/** Small, quick models, the most preferred first. */
const CHEAP_MODELS = [/haiku/i, /luna/i, /(^|[-_.])(mini|nano)([-_.]|$)/i];

export interface NoteModel {
  readonly model: string;
  /** The API it speaks through the pool: `/v1/messages` or `/v1/responses`. */
  readonly api: "anthropic" | "openai";
}

const apiOf = (model: ServedModel): NoteModel["api"] | null =>
  model.ownedBy === "anthropic" || model.ownedBy === "openai" ? model.ownedBy : null;

/**
 * The model a note is written with: the newest small one the pool serves,
 * else the run's own, never a frontier-class one. Null: nothing fits.
 */
export const pickNoteModel = (
  served: ReadonlyArray<ServedModel>,
  runModel: string,
): NoteModel | null => {
  const usable = served.filter((model) => apiOf(model) !== null && !EXCLUDED_MODELS.test(model.id));
  for (const pattern of CHEAP_MODELS) {
    const [newest] = usable
      .filter((model) => pattern.test(model.id))
      .toSorted((left, right) => (right.created ?? 0) - (left.created ?? 0));
    if (newest !== undefined) return { model: newest.id, api: apiOf(newest)! };
  }
  const own = usable.find((model) => model.id === runModel);
  return own === undefined ? null : { model: own.id, api: apiOf(own)! };
};
