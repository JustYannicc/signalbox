import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { ellipsize } from "@t3tools/shared/String";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";

/** What the normalizer hands the trigger runtime for each public event. */
export type Actor = "person" | "agent" | "system";
export type EventFields = Readonly<Record<string, unknown>>;

/** How reading a thread's records can fail. */
export type ReadError = Effect.Error<
  ReturnType<ThreadManagementService["Service"]["getThreadRecords"]>
>;

/** What building an event may read. `shell` is read at most once per domain event; null when gone. */
export interface EventReads {
  readonly shell: Effect.Effect<OrchestrationV2ThreadShell | null>;
  readonly threads: ThreadManagementService["Service"];
}

export interface Candidate {
  readonly name: string;
  /** Stable per occurrence: repeats of the same domain fact get the same id. */
  readonly id: string;
  /** Who caused it, for events whose trigger can filter by `from`. */
  readonly actor?: Actor;
  /** Known from the event itself, else read from the thread. */
  readonly projectId?: string;
  /** A message automations sent, which never triggers by default. */
  readonly automationMessage?: boolean;
  /** Fields on top of the envelope; null drops the event. */
  readonly build: (reads: EventReads) => Effect.Effect<EventFields | null, ReadError>;
}

const LONG_TEXT = 20_000;
export const SHORT_TEXT = 4_000;
export const RAW_STRING = 2_000;

export const cap = (text: string | null | undefined, max = LONG_TEXT) =>
  text === null || text === undefined ? null : ellipsize(text, max);
export const iso = (at: DateTime.Utc | null | undefined) => (at ? DateTime.formatIso(at) : null);
export const actorOf = (createdBy: "user" | "agent" | "system"): Actor =>
  createdBy === "user" ? "person" : createdBy;
/** Fields known from the event itself, built only when someone listens. */
export const fixed = (fields: () => EventFields) => () => Effect.sync(fields);

export const TERMINAL_ITEMS: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
