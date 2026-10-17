import { Cause, Effect, Layer, Queue, Stream } from "effect";
import { LunoraClient } from "lunorash/client";
import type { FunctionReference, LunoraClientOptions } from "lunorash/client";
import { api } from "../../lunora/_generated/api.js";
import { CatalogSync } from "../CatalogSync.js";
const error = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));
export const lunoraLayer = (options: LunoraClientOptions) =>
  Layer.effect(
    CatalogSync,
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new LunoraClient(options)),
        (client) => Effect.sync(() => client.close()),
      );
      const observe = <A>(
        reference: FunctionReference<"query", Record<string, string>, A>,
        args: Record<string, string>,
      ) =>
        Stream.callback<A, Error>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              client.subscribe(reference, args, (value) => Queue.offerUnsafe(queue, value), {
                onError: (cause) => Queue.failCauseUnsafe(queue, Cause.fail(error(cause))),
              }),
            ),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        );
      return {
        connection: Stream.callback<string, Error>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              Queue.offerUnsafe(queue, client.connectionStatus());
              return client.onConnectionStatus((status) => Queue.offerUnsafe(queue, status));
            }),
            (off) => Effect.sync(off),
          ),
        ),
        sidebar: observe(api.catalog.sidebar, {}),
        threads: (folder: string) => observe(api.catalog.threads, { folder }),
        update: (key: string, revision: number, folder?: string) =>
          Effect.tryPromise({
            try: () =>
              client.mutation(api.catalog.update, {
                key,
                revision,
                ...(folder === undefined ? {} : { folder }),
              }),
            catch: error,
          }),
      };
    }),
  );
