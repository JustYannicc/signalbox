import { describe, expect, it } from "vite-plus/test";
import {
  bindClaudeContinuationCompletions,
  claudeContinuationObservations,
  type ClaudeContinuationOwnershipBinding,
} from "@signalbox/provider-claude/ClaudeContinuationBatch";

const block = (task: string, call: string) => ({
  type: "text" as const,
  text: `<system-reminder>\n<task-notification><task-id>${task}</task-id><tool-use-id>${call}</tool-use-id><result>Exact result.\n</result></task-notification>\n</system-reminder>`,
});
const blocks = [
  block("task-a", "call-a"),
  block("task-b", "call-b"),
  { ...block("task-c", "call-c"), cache_control: { type: "ephemeral" } },
];
const notifications = [
  { task_id: "task-a", tool_use_id: "call-a" },
  { task_id: "task-b", tool_use_id: "call-b" },
  { task_id: "task-c", tool_use_id: "call-c" },
];

const observationsFor = (uuid = "first") => {
  const observations = claudeContinuationObservations({
    uuid,
    content: blocks,
    notifications,
  });
  if (observations === undefined) throw new Error("Expected task notification observations.");
  return observations;
};

const bindings: ReadonlyArray<ClaudeContinuationOwnershipBinding> = [
  {
    sdkMessageId: "first",
    blockIndex: 0,
    sourceCallId: "recorded-call-a",
    sourceOccurrenceId: "recorded-occurrence-a",
  },
  {
    sdkMessageId: "first",
    blockIndex: 1,
    sourceCallId: "recorded-call-b",
    sourceOccurrenceId: "recorded-occurrence-b",
  },
  {
    sdkMessageId: "first",
    blockIndex: 2,
    sourceCallId: "recorded-call-c",
    sourceOccurrenceId: "recorded-occurrence-c",
  },
];

describe("Claude continuation batches", () => {
  it("extracts ordered SDK observations without inventing source IDs or changing blocks", () => {
    const observations = observationsFor();
    expect(observations).toEqual([
      {
        sdkMessageId: "first",
        blockIndex: 0,
        observedCallId: "call-a",
        block: blocks[0],
      },
      {
        sdkMessageId: "first",
        blockIndex: 1,
        observedCallId: "call-b",
        block: blocks[1],
      },
      {
        sdkMessageId: "first",
        blockIndex: 2,
        observedCallId: "call-c",
        block: blocks[2],
      },
    ]);
    for (const observation of observations) {
      expect(observation).not.toHaveProperty("sourceCallId");
      expect(observation).not.toHaveProperty("sourceOccurrenceId");
    }
    expect(observationsFor("second")[0]?.sdkMessageId).toBe("second");
  });

  it("creates completions only from explicit source bindings", () => {
    const observations = observationsFor();
    const completions = bindClaudeContinuationCompletions(observations, bindings);

    expect(completions.map((completion) => completion.block)).toEqual(blocks);
    expect(completions.map((completion) => completion.sourceCallId)).toEqual([
      "recorded-call-a",
      "recorded-call-b",
      "recorded-call-c",
    ]);
    expect(completions.map((completion) => completion.sourceOccurrenceId)).toEqual([
      "recorded-occurrence-a",
      "recorded-occurrence-b",
      "recorded-occurrence-c",
    ]);
    expect(completions.map((completion) => completion.observation)).toEqual([
      { sdkMessageId: "first", blockIndex: 0 },
      { sdkMessageId: "first", blockIndex: 1 },
      { sdkMessageId: "first", blockIndex: 2 },
    ]);
    expect(completions[0]?.sourceCallId).not.toBe(observations[0]?.observedCallId);
  });

  it("rejects missing, duplicate, foreign, or schema-invalid bindings", () => {
    const observations = observationsFor();
    expect(() => bindClaudeContinuationCompletions(observations, bindings.slice(0, 2))).toThrow();
    expect(() =>
      bindClaudeContinuationCompletions(observations, [bindings[0]!, bindings[0]!, bindings[2]!]),
    ).toThrow();
    expect(() =>
      bindClaudeContinuationCompletions(observations, [
        bindings[0]!,
        bindings[1]!,
        { ...bindings[2]!, sdkMessageId: "foreign" },
      ]),
    ).toThrow();
    expect(() =>
      bindClaudeContinuationCompletions(observations, [
        { ...bindings[0]!, sourceCallId: " " },
        bindings[1]!,
        bindings[2]!,
      ]),
    ).toThrow();
    expect(() =>
      bindClaudeContinuationCompletions(observations, [
        { ...bindings[0]!, blockIndex: -1 },
        bindings[1]!,
        bindings[2]!,
      ]),
    ).toThrow();
  });

  it("rejects duplicate source pairs and ambiguous observed calls", () => {
    const observations = observationsFor();
    expect(() =>
      bindClaudeContinuationCompletions(observations, [
        bindings[0]!,
        {
          ...bindings[1]!,
          sourceCallId: bindings[0]!.sourceCallId,
          sourceOccurrenceId: bindings[0]!.sourceOccurrenceId,
        },
        bindings[2]!,
      ]),
    ).toThrow();
    for (const input of [
      { uuid: "first", content: blocks, notifications: notifications.slice(0, 2) },
      { uuid: "first", content: blocks, notifications: [...notifications, notifications[0]!] },
      {
        uuid: "first",
        content: blocks,
        notifications: [{ task_id: "task-a", tool_use_id: "other" }],
      },
      { uuid: undefined, content: blocks, notifications },
      {
        uuid: "first",
        content: [...blocks, { type: "text" as const, text: "unowned" }],
        notifications,
      },
    ]) {
      expect(() => claudeContinuationObservations(input)).toThrow();
    }
  });
});
