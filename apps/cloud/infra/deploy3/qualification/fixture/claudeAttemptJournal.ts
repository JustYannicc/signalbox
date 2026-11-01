import type { ClaudeIncomingRequestBodyLifecycle } from "./claudeBodyOwnership.ts";
import { assert } from "./common.ts";
import {
  CLAUDE_REQUEST_ATTEMPTS_KEY,
  CLAUDE_REQUEST_ATTEMPTS_PREFIX,
  claudeRequestAttemptKey,
  emptyClaudeRequestAttemptCounters,
  finishClaudeRequestAttempt,
  startClaudeRequestAttempt,
  type ClaudeAttemptResources,
  type ClaudeRpcSnapshot,
  type ClaudeRequestAttemptCounters,
  type ClaudeRequestAttemptMarker,
  type ClaudeRequestAttemptOutcome,
  type ClaudeRequestAttemptStage,
} from "./claudeAttemptCounters.ts";

/** Owns durable request-attempt markers and their aggregate counters. */
export class ClaudeAttemptJournal {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  async start(
    incomingRequestBodyLifecycle: ClaudeIncomingRequestBodyLifecycle,
    rpcStart: ClaudeRpcSnapshot,
  ) {
    return await this.#storage.transaction(async (tx) => {
      const counters =
        (await tx.get<ClaudeRequestAttemptCounters>(CLAUDE_REQUEST_ATTEMPTS_KEY)) ??
        emptyClaudeRequestAttemptCounters();
      const started = startClaudeRequestAttempt(counters, incomingRequestBodyLifecycle, rpcStart);
      await tx.put(CLAUDE_REQUEST_ATTEMPTS_KEY, started.counters);
      await tx.put(`export/${CLAUDE_REQUEST_ATTEMPTS_KEY}`, started.counters);
      await tx.put(claudeRequestAttemptKey(started.marker.ordinal), started.marker);
      await tx.put(`export/${claudeRequestAttemptKey(started.marker.ordinal)}`, started.marker);
      return started.marker;
    });
  }

  async finish(
    attempt: ClaudeRequestAttemptMarker,
    outcome: ClaudeRequestAttemptOutcome,
    resources: ClaudeAttemptResources,
    rpcEnd: ClaudeRpcSnapshot,
    failedAt?: ClaudeRequestAttemptStage,
  ) {
    await this.#storage.transaction(async (tx) => {
      const marker = await tx.get<ClaudeRequestAttemptMarker>(
        claudeRequestAttemptKey(attempt.ordinal),
      );
      assert(marker?.state === "started", "Claude request attempt is missing its start marker");
      const counters =
        (await tx.get<ClaudeRequestAttemptCounters>(CLAUDE_REQUEST_ATTEMPTS_KEY)) ??
        emptyClaudeRequestAttemptCounters();
      const finished = finishClaudeRequestAttempt(
        counters,
        marker,
        outcome,
        resources,
        rpcEnd,
        failedAt,
      );
      await tx.put(CLAUDE_REQUEST_ATTEMPTS_KEY, finished.counters);
      await tx.put(`export/${CLAUDE_REQUEST_ATTEMPTS_KEY}`, finished.counters);
      await tx.put(claudeRequestAttemptKey(attempt.ordinal), finished.marker);
      await tx.put(`export/${claudeRequestAttemptKey(attempt.ordinal)}`, finished.marker);
    });
  }

  async counters() {
    return (
      (await this.#storage.get<ClaudeRequestAttemptCounters>(CLAUDE_REQUEST_ATTEMPTS_KEY)) ??
      emptyClaudeRequestAttemptCounters()
    );
  }

  async attempts() {
    return [
      ...(
        await this.#storage.list<ClaudeRequestAttemptMarker>({
          prefix: CLAUDE_REQUEST_ATTEMPTS_PREFIX,
        })
      ).values(),
    ];
  }
}
