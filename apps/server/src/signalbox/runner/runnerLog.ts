import type { RunnerItem, RunnerLogLevel } from "@signalbox/runner-protocol/RunnerProtocol";
import type { RunId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { makeProviderFailure } from "../../orchestration-v2/ProviderFailure.ts";

/** Longest line the Runner puts in a turn's diagnostic record. */
const MAX_LOG_MESSAGE_LENGTH = 2_000;

/** What went wrong, without stack frames: the error and each error under it. */
export const causeText = (cause: Cause.Cause<unknown>) =>
  Cause.pretty(cause)
    .split("\n")
    .filter((line) => !/^\s+at /.test(line))
    .join("\n");

/** A line for the diagnostic record of `runId` (null: not about one turn), credentials redacted. */
export const runnerLog = (runId: RunId | null, level: RunnerLogLevel, text: string): RunnerItem => {
  const message = makeProviderFailure({ message: text }).message;
  if (message.length <= MAX_LOG_MESSAGE_LENGTH) return { kind: "log", runId, level, message };
  let end = MAX_LOG_MESSAGE_LENGTH - 1;
  // Never split a surrogate pair.
  const last = message.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { kind: "log", runId, level, message: `${message.slice(0, end)}…` };
};
