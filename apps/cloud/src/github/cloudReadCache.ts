import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { GitHubError } from "./GitHubApi.ts";

/** Per-user reads share in-flight calls; authorization happens before looking here. */
export const makeReadCache = () => {
  const invalidators: Array<(scope?: string) => void> = [];
  const limited = new Map<string, { readonly until: number; readonly error: GitHubError }>();

  const memoize = <I, A>(
    read: (input: I) => Effect.Effect<A, GitHubError>,
    keyOf: (input: I) => { readonly key: string; readonly scope: string; readonly token: string },
    ttl = 15_000,
  ) => {
    const entries = new Map<
      string,
      { readonly scope: string; readonly read: Effect.Effect<A, GitHubError> }
    >();
    invalidators.push((scope) => {
      for (const [key, value] of entries) {
        if (scope === undefined || scope === value.scope) entries.delete(key);
      }
    });
    return (input: I) =>
      Effect.gen(function* () {
        const { key, scope, token } = keyOf(input);
        const now = yield* Clock.currentTimeMillis;
        const blocked = limited.get(token);
        if (blocked !== undefined && blocked.until > now) return yield* blocked.error;
        limited.delete(token);
        let entry = entries.get(key);
        if (entry === undefined) {
          const shared = yield* read(input).pipe(
            Effect.tapError((error) =>
              Effect.gen(function* () {
                if (error.retryAt === undefined) return;
                const at = yield* Clock.currentTimeMillis;
                if (limited.size >= 8) limited.delete(limited.keys().next().value!);
                limited.set(token, { until: Math.max(at, error.retryAt), error });
              }),
            ),
            Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? ttl : 0)),
          );
          if (entries.size >= 64) entries.delete(entries.keys().next().value!);
          entry = { scope, read: shared };
          entries.set(key, entry);
        }
        return yield* entry.read;
      });
  };
  return {
    memoize,
    invalidate: (scope?: string) =>
      Effect.sync(() => {
        for (const invalidate of invalidators) invalidate(scope);
      }),
  };
};
