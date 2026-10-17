import {
  isOrchestrationV2WorkActive,
  OrchestrationV2CommandOutputError,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2SubscribeCommandOutputInput,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type RunId,
  type TurnItemId,
} from "@t3tools/contracts";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  TERMINAL_OUTPUT_TAIL_CHARS,
  terminalOutputResumeText,
} from "@t3tools/shared/terminalOutput";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isLiveRun } from "../runLifecycle.ts";

export const MAX_COMMAND_OUTPUT_TAILS = 64;

export interface CommandOutputKey {
  readonly itemId: TurnItemId;
  readonly runId: RunId;
}

export interface CommandOutputDelta extends CommandOutputKey {
  readonly chunk: string;
}

export interface RetainedCommandOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly hasChunks?: boolean;
}

export type CommandItem = Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>;

export function commandFor(
  projection: OrchestrationV2ThreadProjection,
  input: OrchestrationV2SubscribeCommandOutputInput,
) {
  const item = projection.turnItems.find((candidate) => candidate.id === input.itemId);
  const run = projection.runs.find((candidate) => candidate.id === item?.runId);
  return projection.thread.id === input.threadId &&
    item?.type === "command_execution" &&
    item.threadId === input.threadId &&
    run !== undefined &&
    run.threadId === input.threadId
    ? { item, run }
    : new OrchestrationV2CommandOutputError({
        threadId: input.threadId,
        message: "No such command in this thread.",
      });
}

const decodeLegacy = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ stdout: Schema.String, stderr: Schema.String, interrupted: Schema.Boolean }),
  ),
);

function legacyOutput(output: string) {
  if (!output.trimStart().startsWith('{"stdout"')) return output;
  const parsed = decodeLegacy(output);
  if (Option.isNone(parsed)) return output;
  const stdout = parsed.value.stdout.trim().length > 0 ? parsed.value.stdout : "";
  const stderr = parsed.value.stderr.trim().length > 0 ? parsed.value.stderr : "";
  return stdout.length > 0 && stderr.length > 0 && !stdout.endsWith("\n")
    ? `${stdout}\n${stderr}`
    : stdout + stderr;
}

export function appendRetainedOutput(
  previous: RetainedCommandOutput | null,
  chunk: string,
): RetainedCommandOutput {
  // Resume text includes the cursor and unfinished escape. Do not normalize it
  // before appending, or a restart changes what the next raw chunk means.
  const restored = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, previous?.text ?? "");
  const next = appendTerminalOutput(restored, chunk);
  return {
    text: terminalOutputResumeText(next),
    hasChunks: true,
    truncated: previous === null || previous.truncated || next.truncated,
  };
}

export function persistedOutput(output: string): RetainedCommandOutput {
  const decoded = legacyOutput(output);
  const limit = TERMINAL_OUTPUT_TAIL_CHARS * 4;
  let source = decoded;
  if (source.length > limit) {
    source = source.slice(-limit);
    const newline = source.indexOf("\n");
    if (newline !== -1 && newline + 1 < source.length) source = source.slice(newline + 1);
  }
  const state = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, source);
  return {
    text: terminalOutputResumeText(state),
    truncated: state.truncated || source.length !== decoded.length,
  };
}

export function commandOutputFrame(
  target: Exclude<ReturnType<typeof commandFor>, OrchestrationV2CommandOutputError>,
  retained: RetainedCommandOutput | null,
  sequence: number,
): OrchestrationV2CommandOutputFrame {
  const activeItem = isOrchestrationV2WorkActive(target.item.status);
  const running = isLiveRun(target.run) && activeItem;
  const output =
    target.item.output !== undefined &&
    (!activeItem || retained === null || retained.hasChunks === false)
      ? persistedOutput(target.item.output)
      : retained;
  return {
    kind: "replace",
    sequence,
    // Missing legacy/evicted tails cannot claim to be complete, even on failure.
    text: output?.text ?? "",
    truncated: output?.truncated ?? true,
    running,
  };
}
