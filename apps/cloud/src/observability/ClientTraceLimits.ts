import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class ClientTraceLimits extends Context.Service<
  ClientTraceLimits,
  {
    readonly allow: (personId: string) => Effect.Effect<boolean>;
  }
>()("@signalbox/cloud/observability/ClientTraceLimits") {}

/** Cloudflare counts across isolates in the serving location. A missing binding rejects intake. */
export const layer = (binding: Pick<RateLimit, "limit"> | undefined, environment = "development") =>
  Layer.succeed(ClientTraceLimits, {
    allow: (personId) =>
      binding === undefined
        ? Effect.succeed(false)
        : Effect.tryPromise({
            try: () => binding.limit({ key: `${environment}:${personId}` }),
            catch: () => undefined,
          }).pipe(Effect.match({ onFailure: () => false, onSuccess: ({ success }) => success })),
  });
