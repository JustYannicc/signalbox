// @effect-diagnostics globalFetch:off - this is the final external HTTP boundary, inside the thread object rather than the agent's container.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadStore } from "../ThreadStore.ts";

export type EgressDispatchAnswer =
  | { readonly _tag: "stale" }
  | { readonly _tag: "sent"; readonly response: Response };

const failed = () =>
  new Response("Signalbox could not dispatch this request safely.\n", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "x-signalbox-refused": "secret" },
  });

/** Starts a send under the registration transaction lock; network I/O finishes outside it. */
export const makeEgressDispatch = (
  options: { readonly send?: (request: Request) => Promise<Response> } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ThreadStore;
    const send = options.send ?? ((request: Request) => fetch(request));
    return (request: Request, revision: number): Effect.Effect<EgressDispatchAnswer> =>
      Effect.gen(function* () {
        const started = yield* Effect.gen(function* () {
          const current = yield* store.secretValues;
          if (current.revision !== revision) return { _tag: "stale" } as const;
          return yield* Effect.sync(() => {
            try {
              // Do not await: a slow destination must not block secret rotation.
              return { _tag: "started", response: send(request).catch(failed) } as const;
            } catch {
              // Client errors may contain the filled URL. Keep them out of logs and RPC errors.
              return { _tag: "started", response: Promise.resolve(failed()) } as const;
            }
          });
        }).pipe(
          sql.withTransaction,
          Effect.catchCause(() => Effect.succeed({ _tag: "failed" } as const)),
        );
        if (started._tag === "stale") return started;
        return {
          _tag: "sent",
          response:
            started._tag === "failed" ? failed() : yield* Effect.promise(() => started.response),
        };
      });
  });
