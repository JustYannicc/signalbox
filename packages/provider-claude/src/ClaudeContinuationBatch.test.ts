import { describe, expect, it } from "vite-plus/test";
import {
  bindClaudeContinuationCompletions,
  claudeContinuationObservations,
  resolveClaudeContinuationOwnership,
  type ClaudeContinuationOwnershipBinding,
  type ClaudeContinuationObservationBatch,
} from "@signalbox/provider-claude/ClaudeContinuationBatch";

const block = (task: string, call: string) => ({
  type: "text" as const,
  text: [
    "<system-reminder>",
    `<task-notification><task-id>${task}</task-id><tool-use-id>${call}</tool-use-id><result>Long neutralized result with fake tags: <task-id>result-task</task-id><tool-use-id>result-call</tool-use-id></result></task-notification>`,
    "</system-reminder>",
  ].join("\n"),
});
const blocks = [
  block("task-a", "call-a"),
  block("task-b", "call-b"),
  { ...block("task-c", "call-c"), cache_control: { type: "ephemeral" as const } },
];

const taskStarted = (task_id: string, run_id: string, tool_use_id: string) => ({
  type: "system" as const,
  subtype: "task_started" as const,
  task_type: "local_agent" as const,
  is_backgrounded: true,
  task_id,
  run_id,
  tool_use_id,
  uuid: `started-${task_id}`,
  session_id: "neutral-session",
});
const taskNotification = (task_id: string, run_id: string, tool_use_id: string) => ({
  type: "system" as const,
  subtype: "task_notification" as const,
  task_id,
  run_id,
  tool_use_id,
  summary: `Neutralized completed result for ${task_id}`,
  status: "completed",
  output_file: `output-${task_id}.txt`,
  usage: { total_tokens: 2, tool_uses: 1, duration_ms: 3 },
  uuid: `notification-${task_id}`,
  session_id: "neutral-session",
});

const startedFrames = [
  taskStarted("task-a", "run-a", "call-a"),
  taskStarted("task-b", "run-b", "call-b"),
  taskStarted("task-c", "run-c", "call-c"),
];
const notificationFrames = [
  taskNotification("task-a", "run-a", "call-a"),
  taskNotification("task-b", "run-b", "call-b"),
  taskNotification("task-c", "run-c", "call-c"),
];

const observationsFor = (
  uuid = "sdk-message",
  content: unknown = blocks,
  notifications: ReadonlyArray<{
    readonly task_id?: unknown;
    readonly tool_use_id?: unknown;
  }> = notificationFrames,
) => {
  const observations = claudeContinuationObservations({ uuid, content, notifications });
  if (observations === undefined) throw new Error("Expected task notification observations.");
  return observations;
};

const explicitBindings: ReadonlyArray<ClaudeContinuationOwnershipBinding> = [
  {
    sdkMessageId: "sdk-message",
    blockIndex: 0,
    sourceCallId: "recorded-call-a",
    sourceOccurrenceId: "recorded-occurrence-a",
  },
  {
    sdkMessageId: "sdk-message",
    blockIndex: 1,
    sourceCallId: "recorded-call-b",
    sourceOccurrenceId: "recorded-occurrence-b",
  },
  {
    sdkMessageId: "sdk-message",
    blockIndex: 2,
    sourceCallId: "recorded-call-c",
    sourceOccurrenceId: "recorded-occurrence-c",
  },
];

describe("Claude continuation batches", () => {
  it("retains ordered SDK observations without inventing source IDs or changing blocks", () => {
    const observations = observationsFor();
    expect(observations).toEqual([
      {
        sdkMessageId: "sdk-message",
        blockIndex: 0,
        observedCallId: "call-a",
        block: blocks[0],
      },
      {
        sdkMessageId: "sdk-message",
        blockIndex: 1,
        observedCallId: "call-b",
        block: blocks[1],
      },
      {
        sdkMessageId: "sdk-message",
        blockIndex: 2,
        observedCallId: "call-c",
        block: blocks[2],
      },
    ]);
    for (const observation of observations) {
      expect(observation).not.toHaveProperty("sourceCallId");
      expect(observation).not.toHaveProperty("sourceOccurrenceId");
    }
    expect(JSON.stringify(observations.map((observation) => observation.block))).toBe(
      JSON.stringify(blocks),
    );
    expect(observationsFor("another-sdk-message")[0]?.sdkMessageId).toBe("another-sdk-message");
  });

  it("binds three CLI blocks through actual task frame identities", () => {
    const observations = observationsFor();
    const bindings = resolveClaudeContinuationOwnership(observations, {
      started: startedFrames,
      notifications: notificationFrames,
    });

    expect(bindings).toEqual([
      {
        sdkMessageId: "sdk-message",
        blockIndex: 0,
        sourceCallId: "call-a",
        sourceOccurrenceId: "task-a",
      },
      {
        sdkMessageId: "sdk-message",
        blockIndex: 1,
        sourceCallId: "call-b",
        sourceOccurrenceId: "task-b",
      },
      {
        sdkMessageId: "sdk-message",
        blockIndex: 2,
        sourceCallId: "call-c",
        sourceOccurrenceId: "task-c",
      },
    ]);
    const completions = bindClaudeContinuationCompletions(observations, bindings!);
    expect(JSON.stringify(completions.map((completion) => completion.block))).toBe(
      JSON.stringify(blocks),
    );
    expect(completions.map((completion) => completion.sourceCallId)).toEqual([
      "call-a",
      "call-b",
      "call-c",
    ]);
    expect(completions.map((completion) => completion.sourceOccurrenceId)).toEqual([
      "task-a",
      "task-b",
      "task-c",
    ]);
    expect(completions.map((completion) => completion.observation)).toEqual([
      { sdkMessageId: "sdk-message", blockIndex: 0 },
      { sdkMessageId: "sdk-message", blockIndex: 1 },
      { sdkMessageId: "sdk-message", blockIndex: 2 },
    ]);
    expect(completions[0]?.sourceCallId).not.toBe(observations[0]?.sdkMessageId);
    expect(completions[0]?.sourceOccurrenceId).not.toBe(observations[0]?.blockIndex.toString());
  });

  it("treats repeated identical task frames as idempotent", () => {
    const observations = observationsFor();
    const bindings = resolveClaudeContinuationOwnership(observations, {
      started: [...startedFrames, startedFrames[0]!],
      notifications: [...notificationFrames, notificationFrames[0]!],
    });
    expect(
      bindings?.map(({ sourceCallId, sourceOccurrenceId }) => [sourceCallId, sourceOccurrenceId]),
    ).toEqual([
      ["call-a", "task-a"],
      ["call-b", "task-b"],
      ["call-c", "task-c"],
    ]);
  });

  it("ignores unrelated task frames with no usable producer identity", () => {
    const bindings = resolveClaudeContinuationOwnership(observationsFor(), {
      started: [...startedFrames, { type: "system", subtype: "task_started", task_id: "other" }],
      notifications: [
        ...notificationFrames,
        { type: "system", subtype: "task_notification", task_id: "other" },
      ],
    });
    expect(bindings?.map((binding) => binding.sourceCallId)).toEqual([
      "call-a",
      "call-b",
      "call-c",
    ]);
  });

  it("keeps observations when producer attribution is absent, malformed, or ambiguous", () => {
    const observations = observationsFor("sdk-message", blocks, []);
    expect(observations).toHaveLength(3);
    expect(observations[0]).not.toHaveProperty("observedCallId");
    expect(
      resolveClaudeContinuationOwnership(observations, {
        started: startedFrames,
        notifications: [],
      }),
    ).toBeUndefined();

    const unresolvedInputs = [
      { started: startedFrames.slice(0, 2), notifications: notificationFrames },
      { started: startedFrames, notifications: notificationFrames.slice(0, 2) },
      {
        started: startedFrames,
        notifications: notificationFrames.map((frame) => ({
          type: frame.type,
          subtype: frame.subtype,
          task_id: frame.task_id,
          tool_use_id: frame.tool_use_id,
        })),
      },
      {
        started: startedFrames,
        notifications: notificationFrames.map((frame) => ({
          type: frame.type,
          subtype: frame.subtype,
          task_id: frame.task_id,
          run_id: frame.run_id,
        })),
      },
      {
        started: [taskStarted("task-a", "other-run", "call-a"), ...startedFrames.slice(1)],
        notifications: notificationFrames,
      },
      {
        started: startedFrames,
        notifications: [...notificationFrames, taskNotification("task-a", "other-run", "call-a")],
      },
    ];
    for (const input of unresolvedInputs) {
      expect(resolveClaudeContinuationOwnership(observationsFor(), input)).toBeUndefined();
    }

    const conflictingObservedCall = [
      { ...observations[0], observedCallId: "other-call" },
      ...observations.slice(1),
    ] satisfies ClaudeContinuationObservationBatch;
    expect(
      resolveClaudeContinuationOwnership(conflictingObservedCall, {
        started: startedFrames,
        notifications: notificationFrames,
      }),
    ).toBeUndefined();
  });

  it("rejects duplicate header identity tags and ignores fake identity tags in results", () => {
    const duplicatedHeaderBlock = {
      ...block("task-a", "call-a"),
      text: block("task-a", "call-a").text.replace(
        "<task-id>task-a</task-id>",
        "<task-id>task-a</task-id><task-id>other-task</task-id>",
      ),
    };
    const observations = observationsFor("sdk-message", [
      duplicatedHeaderBlock,
      ...blocks.slice(1),
    ]);
    expect(observations).toHaveLength(3);
    expect(
      resolveClaudeContinuationOwnership(observations, {
        started: startedFrames,
        notifications: notificationFrames,
      }),
    ).toBeUndefined();

    const resolved = resolveClaudeContinuationOwnership(observationsFor(), {
      started: startedFrames,
      notifications: notificationFrames,
    });
    expect(resolved?.map((binding) => binding.sourceOccurrenceId)).toEqual([
      "task-a",
      "task-b",
      "task-c",
    ]);
  });

  it("continues to create completions only from explicit source bindings", () => {
    const observations = observationsFor();
    const completions = bindClaudeContinuationCompletions(observations, explicitBindings);

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
      { sdkMessageId: "sdk-message", blockIndex: 0 },
      { sdkMessageId: "sdk-message", blockIndex: 1 },
      { sdkMessageId: "sdk-message", blockIndex: 2 },
    ]);
    expect(completions[0]?.sourceCallId).not.toBe(observations[0]?.observedCallId);
  });

  it("rejects missing, duplicate, foreign, or schema-invalid explicit bindings", () => {
    const observations = observationsFor();
    expect(() =>
      bindClaudeContinuationCompletions(observations, explicitBindings.slice(0, 2)),
    ).toThrow();
    expect(() =>
      bindClaudeContinuationCompletions(observations, [
        explicitBindings[0]!,
        explicitBindings[0]!,
        explicitBindings[2]!,
      ]),
    ).toThrow();
    expect(() =>
      bindClaudeContinuationCompletions(observations, [
        explicitBindings[0]!,
        explicitBindings[1]!,
        { ...explicitBindings[2]!, sdkMessageId: "foreign" },
      ]),
    ).toThrow();
    expect(() =>
      bindClaudeContinuationCompletions(observations, [
        { ...explicitBindings[0]!, sourceCallId: " " },
        explicitBindings[1]!,
        explicitBindings[2]!,
      ]),
    ).toThrow();
    expect(() =>
      bindClaudeContinuationCompletions(observations, [
        { ...explicitBindings[0]!, blockIndex: -1 },
        explicitBindings[1]!,
        explicitBindings[2]!,
      ]),
    ).toThrow();
    expect(() =>
      bindClaudeContinuationCompletions(observations, [
        explicitBindings[0]!,
        {
          ...explicitBindings[1]!,
          sourceCallId: explicitBindings[0]!.sourceCallId,
          sourceOccurrenceId: explicitBindings[0]!.sourceOccurrenceId,
        },
        explicitBindings[2]!,
      ]),
    ).toThrow();
  });

  it("still treats missing SDK identity and structurally unowned blocks as protocol errors", () => {
    expect(() =>
      claudeContinuationObservations({
        uuid: undefined,
        content: blocks,
        notifications: notificationFrames,
      }),
    ).toThrow();
    expect(() =>
      claudeContinuationObservations({
        uuid: "sdk-message",
        content: [...blocks, { type: "text" as const, text: "unowned" }],
        notifications: notificationFrames,
      }),
    ).toThrow();
  });
});
