import { GIT_VECTORS } from "./gitVectors-r2.mjs";

const TOOL_ARGUMENTS = Object.freeze({
  login: false,
  tty: false,
  yield_time_ms: 1000,
  max_output_tokens: 1000,
});

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freezeDeep(entry);
    Object.freeze(value);
  }
  return value;
}

function toolArguments(command) {
  return {
    cmd: command,
    workdir: "/workspace",
    login: TOOL_ARGUMENTS.login,
    tty: TOOL_ARGUMENTS.tty,
    yield_time_ms: TOOL_ARGUMENTS.yield_time_ms,
    max_output_tokens: TOOL_ARGUMENTS.max_output_tokens,
  };
}

function makeTurn(number) {
  const n = String(number).padStart(2, "0");
  const commandMarker = `turn${number}-command`;
  const fileName = `native-turn-${number}.txt`;
  const fileContent = `native-turn-${number}-content`;
  const patch = `*** Begin Patch\n*** Add File: /workspace/${fileName}\n+${fileContent}\n*** End Patch\n`;
  const callId = (suffix) => `call-sb1070-combined-r4-t${n}-${suffix}`;
  const responseId = (suffix) => `resp-sb1070-combined-r4-t${n}-${suffix}`;
  const messageId = `msg-sb1070-combined-r4-t${n}-final`;
  const gitInstructions =
    number === 2
      ? " First, after restored Git readiness, run git ls-files --stage, then git status --porcelain=v1 twice as separate commands. Edit tracked README.md with apply_patch by appending the line native-turn-2-git-edit after tracked baseline. Run git status --porcelain=v1 once more to detect the edit."
      : "";
  const prompt = `For qualifier turn ${number}, run these operations in order:${gitInstructions} Print the single line ${commandMarker}; create ${fileName} with one line containing ${fileContent}; read that file back. If every operation succeeds, reply exactly: combined-codex-r4-turn-${number}-complete`;
  const finalText = `combined-codex-r4-turn-${number}-complete`;
  const execFirst = toolArguments(`printf '%s\\n' ${commandMarker}`);
  const patchResult = `Success. Updated the following files:\nA /workspace/${fileName}\n`;
  const execRead = toolArguments(`cat ${fileName}`);
  const gitCommand = (suffix, command, expectedOutput, phase) => {
    const args = toolArguments(command);
    return {
      kind: "exec_command",
      responseId: responseId(suffix),
      callId: callId(suffix),
      command,
      arguments: args,
      argumentsJson: JSON.stringify(args),
      expectedOutput,
      phase,
    };
  };
  const gitActions =
    number === 2
      ? [
          gitCommand(
            "git-stage",
            GIT_VECTORS.commands.stage.cmd,
            GIT_VECTORS.commands.stage.output,
            "after-restore-and-readiness",
          ),
          gitCommand(
            "git-status-first",
            GIT_VECTORS.commands.statusFirst.cmd,
            GIT_VECTORS.commands.statusFirst.output,
            "after-stage-before-tracked-edit",
          ),
          gitCommand(
            "git-status-repeated",
            GIT_VECTORS.commands.statusRepeated.cmd,
            GIT_VECTORS.commands.statusRepeated.output,
            "repeated-before-tracked-edit",
          ),
          {
            kind: "apply_patch",
            responseId: responseId("git-edit"),
            callId: callId("git-edit"),
            input: GIT_VECTORS.patch.input,
            expectedOutput: GIT_VECTORS.patch.expectedOutput,
            filePath: "/workspace/README.md",
            phase: "tracked-file-edit",
          },
          gitCommand(
            "git-status-after-edit",
            GIT_VECTORS.commands.statusAfterPatch.cmd,
            GIT_VECTORS.commands.statusAfterPatch.output,
            "after-tracked-edit",
          ),
        ]
      : [];

  return {
    turn: number,
    prompt,
    finalText,
    file: {
      path: `/workspace/${fileName}`,
      name: fileName,
      content: `${fileContent}\n`,
      patch,
      patchOutput: patchResult,
    },
    actions: [
      ...gitActions,
      {
        kind: "exec_command",
        responseId: responseId("exec-marker"),
        callId: callId("exec-marker"),
        command: execFirst.cmd,
        arguments: execFirst,
        argumentsJson: JSON.stringify(execFirst),
        expectedOutput: `${commandMarker}\n`,
      },
      {
        kind: "apply_patch",
        responseId: responseId("apply-patch"),
        callId: callId("apply-patch"),
        input: patch,
        expectedOutput: patchResult,
        filePath: `/workspace/${fileName}`,
      },
      {
        kind: "exec_command",
        responseId: responseId("read-file"),
        callId: callId("read-file"),
        command: execRead.cmd,
        arguments: execRead,
        argumentsJson: JSON.stringify(execRead),
        expectedOutput: `${fileContent}\n`,
      },
      {
        kind: "assistant_final",
        responseId: responseId("final"),
        messageId,
        text: finalText,
      },
    ],
  };
}

export const EXPECTATIONS = freezeDeep({
  schema: "signalbox.1070.combined-codex-r3-model-expectations/v1",
  contract: {
    path: "signalbox-1396/combined-codex-acceptance-r6",
    version: "r6",
    requiredChecks: ["C1", "C3", "C5", "C7", "C8"],
    modelScope: "C3 native transcript, builtin tool and terminal expectations only",
  },
  lifecycle: {
    nativeSessionId:
      "one actual runtime-issued UUID, passed to bindNativeSession; never generated here",
    completedTurns: [1, 2, 3],
    replacementCount: 1,
    replacementAfterCompletedTurn: 1,
    turnIncarnations: [
      "root-supplied process identity A",
      "root-supplied process identity B",
      "same identity B",
    ],
    turn1Replay: false,
    startupEmptyInput: {
      maximum: 2,
      maximumPerIncarnation: 1,
      required: false,
      beforeNativeSessionBindOrFirstPrompt: true,
      retainedInFullModelJournal: true,
    },
  },
  noToolsGatewayCalls: true,
  gitVectors: {
    hostTruth: "host-truth-r2.json",
    seedManifest: "seed-manifest.json",
    commandActionIds: [
      "git-stage",
      "git-status-first",
      "git-status-repeated",
      "git-status-after-edit",
    ].map((suffix) => `call-sb1070-combined-r4-t02-${suffix}`),
    editActionId: "call-sb1070-combined-r4-t02-git-edit",
    readAccounting:
      "Root measures actual public loader reads around first and repeated status, then verifies the changed tracked file remains detectable; this model only pins native command outputs.",
  },
  turns: [makeTurn(1), makeTurn(2), makeTurn(3)],
  responsesPerTurn: {
    sseFrame: "event: <type>\ndata: <compact JSON>\n\n",
    created: {
      type: "response.created",
      response: { id: "the response ID listed for this action" },
    },
    outputItemDone: {
      type: "response.output_item.done",
      item: "the exact frozen function_call, custom_tool_call, or assistant message item from the turn action",
    },
    completed: {
      type: "response.completed",
      response: {
        id: "same response ID",
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
    order: ["response.created", "response.output_item.done", "response.completed"],
    startupOrder: ["response.created", "response.completed"],
  },
  startupResponseEvents: ["response.created", "response.completed"],
  nativeTerminalAssertions: [1, 2, 3].map((turn) => ({
    turn,
    exactlyOnce: true,
    mustFollow: "the turn's fixed assistant final marker and persisted native completion receipt",
    eventKind:
      "root maps the pinned runtime's native terminal event; this fixture does not invent its name",
    requestId:
      "runtime-assigned; terminal ID must relate to that turn's root-captured accepted-input ID; preserve both verbatim",
    nativeSessionId: "same actual UUID for all turns and the one replacement",
  })),
  volatileFieldRules: [
    "Preserve all raw model request and SSE response bytes with SHA-256 and UTF-8 byte length; do not truncate.",
    "Do not create native event request IDs. Keep actual runtime IDs in root records and compare relations only.",
    "Command Chunk ID, wall time and original token count are runtime-produced; retain raw envelopes and decoded values. Patch envelopes require the source-defined exit/time/output headers and exact body including trailing newline, and retain their raw timing value separately. Assert exact decoded output, completed status, exit code 0, unique nonempty chunk IDs, and no error flag.",
    "Do not normalize prompts, tool names, call IDs, arguments, output content, errors, event count or order.",
  ],
});
