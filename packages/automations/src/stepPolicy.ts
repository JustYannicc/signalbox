import type { WorkflowStepVerb } from "@t3tools/contracts";

import { asRecord } from "./json.ts";

/**
 * How long a step may take and how often it is tried, from its options and
 * the defaults per verb. Pure, so the engine and tests agree on the numbers.
 */

const DURATION_MS = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
} as const;

/** `{ minutes: 5, seconds: 30 }` in ms; units add up. Null when it names no positive amount. */
export function durationMs(value: unknown): number | null {
  const units = asRecord(value);
  let total = 0;
  for (const [unit, ms] of Object.entries(DURATION_MS)) {
    const amount = units[unit];
    if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) total += amount * ms;
  }
  return total > 0 ? total : null;
}

/** "2 hours", "90 seconds": for messages about a duration. */
export function describeDuration(ms: number): string {
  for (const [unit, size] of Object.entries(DURATION_MS).toReversed()) {
    if (ms >= size && ms % size === 0) {
      const amount = ms / size;
      return `${amount} ${amount === 1 ? unit.slice(0, -1) : unit}`;
    }
  }
  return `${Math.round(ms / 1_000)} seconds`;
}

/** The options object of a step call, wherever the verb takes it. */
export function stepOptions(verb: WorkflowStepVerb, args: ReadonlyArray<unknown>) {
  return asRecord(verb === "call" ? args[2] : args[0]);
}

const DEFAULT_TIMEOUT_MS: Partial<Record<WorkflowStepVerb, number>> = {
  http: 60_000,
  agent: 2 * DURATION_MS.hours,
  llm: 10 * DURATION_MS.minutes,
  judge: 10 * DURATION_MS.minutes,
  extract: 10 * DURATION_MS.minutes,
};

/** The step's `timeout`, else its verb's default. Null means it may wait forever (`ask` by default). */
export function stepTimeoutMs(verb: WorkflowStepVerb, args: ReadonlyArray<unknown>): number | null {
  if (!(verb in DEFAULT_TIMEOUT_MS) && verb !== "ask") return null;
  return durationMs(stepOptions(verb, args).timeout) ?? DEFAULT_TIMEOUT_MS[verb] ?? null;
}

export interface RetryPolicy {
  readonly attempts: number;
  readonly backoff: "exponential" | "fixed";
}

/**
 * http and call retry network failures, 5xx and 429 three times; judge and
 * extract retry an answer they can't read once. `retry: { attempts: 1 }` turns
 * it off. Other verbs never retry: they either can't fail transiently or
 * shouldn't run twice.
 */
const DEFAULT_ATTEMPTS: Partial<Record<WorkflowStepVerb, number>> = {
  http: 3,
  call: 3,
  judge: 2,
  extract: 2,
  llm: 1,
};
const MAX_ATTEMPTS = 10;

/** Whether a verb's steps can be tried again, so a parked retry restarts them. */
export const retries = (verb: WorkflowStepVerb) => DEFAULT_ATTEMPTS[verb] !== undefined;

export function retryPolicy(verb: WorkflowStepVerb, args: ReadonlyArray<unknown>): RetryPolicy {
  const fallback = DEFAULT_ATTEMPTS[verb];
  if (fallback === undefined) return { attempts: 1, backoff: "fixed" };
  const retry = asRecord(stepOptions(verb, args).retry);
  const attempts =
    typeof retry.attempts === "number" && Number.isInteger(retry.attempts) && retry.attempts >= 1
      ? Math.min(retry.attempts, MAX_ATTEMPTS)
      : fallback;
  return { attempts, backoff: retry.backoff === "fixed" ? "fixed" : "exponential" };
}

const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 5 * DURATION_MS.minutes;

/** How long to wait before attempt `attempt + 1`, honoring a server's Retry-After. */
export function retryDelayMs(
  policy: RetryPolicy,
  attempt: number,
  retryAfterMs?: number | undefined,
): number {
  const backoff =
    policy.backoff === "fixed" ? BASE_DELAY_MS : BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(MAX_DELAY_MS, Math.max(backoff, retryAfterMs ?? 0));
}

/** Seconds or an HTTP date from a Retry-After header, in ms from `now`. */
export function retryAfterMs(header: string | undefined, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * The cause of an AutomationError that may go away by itself: the network,
 * a timeout, a 5xx or 429. Steps with retries left try again later.
 */
export class TransientFailure extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, options?: { cause?: unknown; retryAfterMs?: number | undefined }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TransientFailure";
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/** Every error in a `cause` chain, outermost first. */
export function* causeChain(error: unknown): Generator<unknown> {
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 10; depth++) {
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

/** The transient failure behind `error`, if any, wherever it sits in the cause chain. */
export function transientCause(error: unknown): TransientFailure | undefined {
  for (const cause of causeChain(error)) if (cause instanceof TransientFailure) return cause;
  return undefined;
}
