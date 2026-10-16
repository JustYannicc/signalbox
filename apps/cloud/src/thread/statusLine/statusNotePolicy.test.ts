import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadStatusNote } from "@t3tools/contracts/signalboxStatusLine";
import * as DateTime from "effect/DateTime";

import { SCRIPTED_INSTANCE_ID } from "../scriptedProvider.ts";
import {
  afterFailedAttempt,
  afterWrite,
  decideStatusNote,
  MAX_NOTE_ATTEMPTS,
  noteRetryDelayMs,
  pickNoteModel,
} from "./statusNotePolicy.ts";
import { parseNote } from "./statusNotePrompt.ts";

/**
 * When the runtime writes a thread's status note for a turn that ended
 * without one (#670), which model it asks, and how its answer becomes a note.
 */

const threadId = ThreadId.make("thread-status");
const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 16, 9));
const CLAUDE = ProviderInstanceId.make("claude_hub");

const run = (
  ordinal: number,
  status: OrchestrationV2Run["status"],
  instance = CLAUDE,
): OrchestrationV2Run => ({
  id: RunId.make(`run-${ordinal}`),
  threadId,
  ordinal,
  providerInstanceId: instance,
  modelSelection: { instanceId: instance, model: "claude-opus-5-5" },
  providerThreadId: null,
  userMessageId: MessageId.make(`message-${ordinal}`),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: at,
  startedAt: at,
  completedAt: status === "running" || status === "queued" ? null : at,
  checkpointId: null,
  contextHandoffId: null,
});

const noteFor = (runId: string | null): ThreadStatusNote => ({
  nextStep: "You: say if it can go out.",
  whereItGotTo: "The draft is written.",
  writtenAt: at,
  writtenBy: "agent",
  runId: runId === null ? null : RunId.make(runId),
});

const NOW = 1_000_000;
const start = { through: 0, attemptsFor: 0, attempts: 0, nextAt: 0 };

describe("runtime status notes", () => {
  it("writes the latest ended turn's note when the agent left it out", () => {
    const runs = [run(1, "completed"), run(2, "failed")];
    expect(decideStatusNote({ runs }, noteFor("run-1"), start, NOW)).toEqual({
      _tag: "write",
      run: runs[1],
      attempt: 1,
    });
    // Interrupted turns get one too.
    expect(decideStatusNote({ runs: [run(1, "interrupted")] }, null, null, NOW)).toMatchObject({
      _tag: "write",
      attempt: 1,
    });
  });

  it("moves past turns the agent covered, and ones not worth a note", () => {
    expect(decideStatusNote({ runs: [run(1, "completed")] }, noteFor("run-1"), start, NOW)).toEqual(
      { _tag: "advance", cursor: afterWrite(run(1, "completed")) },
    );
    expect(decideStatusNote({ runs: [run(1, "cancelled")] }, null, start, NOW)).toEqual({
      _tag: "advance",
      cursor: { ...start, through: 1 },
    });
    // Scripted turns run on no pool.
    expect(
      decideStatusNote(
        { runs: [run(1, "completed", ProviderInstanceId.make(SCRIPTED_INSTANCE_ID))] },
        null,
        start,
        NOW,
      ),
    ).toMatchObject({ _tag: "advance" });
    // Already through it.
    expect(
      decideStatusNote({ runs: [run(1, "completed")] }, null, { ...start, through: 1 }, NOW),
    ).toEqual({ _tag: "none" });
  });

  it("waits while a newer turn runs, and for none at all", () => {
    expect(
      decideStatusNote({ runs: [run(1, "completed"), run(2, "running")] }, null, start, NOW),
    ).toEqual({ _tag: "none" });
    expect(decideStatusNote({ runs: [run(1, "running")] }, null, start, NOW)).toEqual({
      _tag: "none",
    });
    // A held queued turn doesn't hold the ended one's note.
    expect(
      decideStatusNote({ runs: [run(1, "completed"), run(2, "queued")] }, null, start, NOW),
    ).toMatchObject({ _tag: "write", attempt: 1 });
  });

  it("retries with a backoff, then gives up and moves on", () => {
    const runs = [run(1, "completed")];
    let cursor = afterFailedAttempt(start, runs[0]!, 1, NOW);
    expect(cursor.nextAt).toBe(NOW + noteRetryDelayMs(1));
    expect(decideStatusNote({ runs }, null, cursor, NOW)).toEqual({
      _tag: "wait",
      at: cursor.nextAt,
    });
    expect(decideStatusNote({ runs }, null, cursor, cursor.nextAt)).toMatchObject({
      _tag: "write",
      attempt: 2,
    });
    for (let attempt = 2; attempt <= MAX_NOTE_ATTEMPTS; attempt++) {
      cursor = afterFailedAttempt(cursor, runs[0]!, attempt, NOW);
    }
    expect(decideStatusNote({ runs }, null, cursor, NOW)).toEqual({
      _tag: "advance",
      cursor: { ...start, through: 1 },
    });
    // A newer turn's end starts its own count.
    const later = [...runs, run(2, "completed")];
    expect(decideStatusNote({ runs: later }, null, cursor, NOW)).toMatchObject({
      _tag: "write",
      run: { id: "run-2" },
      attempt: 1,
    });
  });
});

describe("the note's model", () => {
  const served = (id: string, ownedBy: string, created: number | null = null) => ({
    id,
    ownedBy,
    created,
  });

  it("takes the newest small model the pool serves, never a frontier one", () => {
    expect(
      pickNoteModel(
        [
          served("claude-opus-5-5", "anthropic"),
          served("claude-haiku-4-5", "anthropic", 1),
          served("claude-haiku-5", "anthropic", 2),
          served("gpt-6-luna", "openai"),
        ],
        "claude-opus-5-5",
      ),
    ).toEqual({ model: "claude-haiku-5", api: "anthropic" });
    expect(
      pickNoteModel([served("gpt-6-astra", "openai"), served("gpt-6-luna", "openai")], "x"),
    ).toEqual({ model: "gpt-6-luna", api: "openai" });
    expect(pickNoteModel([served("gpt-5-mini", "openai")], "x")).toEqual({
      model: "gpt-5-mini",
      api: "openai",
    });
    // Gemini speaks neither API the pool forwards here.
    expect(pickNoteModel([served("gemini-3-flash", "google")], "x")).toBeNull();
  });

  it("falls back to the run's own model, unless it's frontier-class", () => {
    expect(pickNoteModel([served("claude-opus-5-5", "anthropic")], "claude-opus-5-5")).toEqual({
      model: "claude-opus-5-5",
      api: "anthropic",
    });
    expect(pickNoteModel([served("claude-fable-1", "anthropic")], "claude-fable-1")).toBeNull();
  });
});

describe("the model's answer", () => {
  it("becomes a note: one line each, cut to the limits", () => {
    expect(
      parseNote(
        '```json\n{"nextStep": "You:\\n  check   the totals.", "whereItGotTo": "Done."}\n```',
      ),
    ).toEqual({ nextStep: "You: check the totals.", whereItGotTo: "Done." });
    const long = parseNote(JSON.stringify({ nextStep: "a".repeat(500), whereItGotTo: "b" }));
    expect(long?.nextStep).toHaveLength(160);
    expect(long?.nextStep.endsWith("…")).toBe(true);
  });

  it("is refused when it isn't one", () => {
    expect(parseNote("Sure! Here's the status.")).toBeNull();
    expect(parseNote('{"nextStep": " ", "whereItGotTo": "x"}')).toBeNull();
    expect(parseNote('{"next": "x"}')).toBeNull();
  });
});
