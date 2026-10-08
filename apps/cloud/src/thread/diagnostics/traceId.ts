import type { RunId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";

/**
 * A turn's trace id: 32 hex characters (a W3C trace id), derived from its run
 * id, so the Runner, the ModelGateway and the diagnostic record all name the
 * same turn without asking each other. Run ids already include the thread, so
 * trace ids never collide across threads. The command receipt that started
 * the turn also stores it, so a client's command id leads to the turn.
 *
 * Derived often (every Runner batch hands out work, every model request is
 * authorized), so the isolate remembers recent ones.
 */

const MAX_REMEMBERED = 1_024;
const remembered = new Map<RunId, string>();

export const traceIdOf = (runId: RunId) =>
  Effect.suspend(() => {
    const known = remembered.get(runId);
    if (known !== undefined) return Effect.succeed(known);
    return Crypto.Crypto.pipe(
      Effect.flatMap((crypto) =>
        crypto.digest("SHA-256", new TextEncoder().encode(`signalbox-trace:${runId}`)),
      ),
      Effect.map((digest) => {
        const traceId = Hex.encode(digest).slice(0, 32);
        if (remembered.size >= MAX_REMEMBERED) remembered.clear();
        remembered.set(runId, traceId);
        return traceId;
      }),
      Effect.orDie,
    );
  });
