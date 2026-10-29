import { isoAt } from "./platform.ts";
export type Deploy3Role = "workload" | "cleanup";

export interface Deploy3Identity {
  readonly runId: string;
  readonly deadlineMs: number;
  readonly deadlineUtc: string;
  readonly role: Deploy3Role;
}

export interface CreateDeploy3NameInput {
  readonly runId: string;
  readonly deadlineMs: number;
  readonly role: Deploy3Role;
}

const NAME = /^sb1070-d3-([a-f0-9]{8})-(\d{10})-(workload|cleanup)$/;
const DEADLINE_TAG = /^sb1070-d3-deadline-(\d{10})$/;
const DEADLINE_TAG_STEM = "sb1070-d3-deadline";

function timestamp(secondsText: string): { deadlineMs: number; deadlineUtc: string } | null {
  if (!/^\d{10}$/.test(secondsText)) return null;
  const seconds = Number(secondsText);
  const deadlineMs = seconds * 1_000;
  if (
    !Number.isSafeInteger(seconds) ||
    String(seconds).padStart(10, "0") !== secondsText ||
    !Number.isSafeInteger(deadlineMs)
  ) {
    return null;
  }
  if (Math.floor(deadlineMs / 1_000) !== seconds) {
    return null;
  }
  return { deadlineMs, deadlineUtc: isoAt(deadlineMs) };
}

/** Parses only the full canonical deploy3 name. A partial prefix is never ownership. */
export function parseDeploy3Name(name: string): Deploy3Identity | null {
  const match = NAME.exec(name);
  if (!match) return null;
  const [, runId, seconds, role] = match;
  const date = timestamp(seconds!);
  if (!date) return null;
  return { runId: runId!, ...date, role: role as Deploy3Role };
}

/**
 * Encodes a millisecond deadline in the name's second-resolution format.
 * Rounding up prevents the encoded deadline from firing before the requested instant.
 */
export function createDeploy3Name({ runId, deadlineMs, role }: CreateDeploy3NameInput): string {
  if (!/^[a-f0-9]{8}$/.test(runId)) throw new TypeError("runId must be 8 lowercase hex characters");
  if (role !== "workload" && role !== "cleanup") throw new TypeError("Invalid deploy3 role");
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) {
    throw new RangeError("deadlineMs must be a non-negative safe integer");
  }
  const seconds = Math.ceil(deadlineMs / 1_000);
  const encoded = String(seconds).padStart(10, "0");
  if (encoded.length !== 10 || !timestamp(encoded)) {
    throw new RangeError("deadlineMs is outside the deploy3 name range");
  }
  return `sb1070-d3-${runId}-${encoded}-${role}`;
}

/**
 * Applies at most one deadline extension tag. Invalid, duplicate, or earlier tags refuse the
 * resource instead of falling back to its name.
 */
export function effectiveDeploy3Deadline(
  name: string,
  tags?: readonly unknown[],
): Deploy3Identity | null {
  const original = parseDeploy3Name(name);
  if (!original) return null;
  if (tags === undefined) return original;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) return null;

  const deadlineTags = tags.filter((tag) => tag.startsWith(DEADLINE_TAG_STEM));
  if (deadlineTags.length === 0) return original;
  if (deadlineTags.length !== 1) return null;

  const match = DEADLINE_TAG.exec(deadlineTags[0]!);
  if (!match) return null;
  const extension = timestamp(match[1]!);
  if (!extension || extension.deadlineMs < original.deadlineMs) return null;
  return { ...original, ...extension };
}
