import {
  CLAUDE_STREAM_PREFIX,
  CODEX_STREAM_PREFIX,
} from "@signalbox/runner-protocol/SessionProtocol";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import { POOL_INSTANCE_KINDS } from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";

import type { SessionRows } from "./SessionRows.ts";

/**
 * Whether a thread's store holds the harness session its provider thread
 * names, so a machine can resume it (#465). A harness names its session as
 * soon as it starts, before it writes a row of it; a machine lost that early
 * leaves the thread naming a session no machine can ever load.
 */

/** The prefix to list, and which listed stream is the session's transcript; null for a harness the store does not keep. */
const transcriptOf = (driver: string, nativeId: string) => {
  switch (driver) {
    // `claude/<session id>`; sidecars sit below it.
    case POOL_INSTANCE_KINDS.claude.driver: {
      const stream = `${CLAUDE_STREAM_PREFIX}${nativeId}`;
      return { prefix: stream, matches: (name: string) => name === stream };
    }
    // Its rollout, `codex/<yyyy>/<mm>/<dd>/rollout-<time>-<thread id>.jsonl`.
    case POOL_INSTANCE_KINDS.codex.driver:
      return {
        prefix: CODEX_STREAM_PREFIX,
        matches: (name: string) => name.endsWith(`-${nativeId}.jsonl`),
      };
    default:
      return null;
  }
};

/**
 * Whether there is a session to resume. Without a ref there is none; a ref
 * without an id, or for a harness the store doesn't keep, is trusted.
 */
export const holdsNativeSession = Effect.fn("holdsNativeSession")(function* (
  rows: SessionRows["Service"],
  providerThread: OrchestrationV2ProviderThread,
) {
  const ref = providerThread.nativeThreadRef;
  if (ref === null) return false;
  const transcript = ref.nativeId === null ? null : transcriptOf(ref.driver, ref.nativeId);
  if (transcript === null) return true;
  const streams = yield* rows.streams(transcript.prefix);
  return streams.some(({ stream, count }) => count > 0 && transcript.matches(stream));
});
