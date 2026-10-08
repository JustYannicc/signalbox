/**
 * What `workload.turn.completed` (self-hosted) and `cloud.turn.completed`
 * (Signalbox Cloud) share, so the cost replay (#116) reads both the same way:
 * how ids are hashed, how a turn's outcome, durations and command work are
 * reduced. Keep the two events on these helpers; a copy drifts.
 *
 * @module workloadUsage
 */
import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";

import { COMMAND_CATEGORIES, type CommandCategory } from "./commandCategory.ts";

/** One-way, so events can be grouped by thread, project or user without naming them. */
export const hashWorkloadId = (id: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.digest("SHA-256", new TextEncoder().encode(`signalbox-workload:${id}`)),
    ),
    Effect.map((digest) => Hex.encode(digest).slice(0, 16)),
    Effect.orDie,
  );

export type TurnOutcome = "completed" | "interrupted" | "error";

export const outcomeOf = (status: OrchestrationV2Run["status"]): TurnOutcome =>
  status === "completed" ? "completed" : status === "failed" ? "error" : "interrupted";

/** Turn items that ended, and so count toward a turn's work. */
export const TERMINAL_ITEM_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** Seconds, to a tenth. */
export const seconds = (ms: number) => Math.round(ms / 100) / 10;

export const elapsedMs = (from: DateTime.Utc | null, to: DateTime.Utc | null) =>
  from === null || to === null
    ? 0
    : Math.max(0, DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from));

/** Whole seconds from the previous turn's end to this one's start. */
export const secondsSincePreviousTurn = (previousEndMs: number, startedAtMs: number) =>
  Math.max(0, Math.round((startedAtMs - previousEndMs) / 1000));

export const byCategory = (value: (category: CommandCategory) => number) =>
  Object.fromEntries(COMMAND_CATEGORIES.map((category) => [category, value(category)])) as Record<
    CommandCategory,
    number
  >;
