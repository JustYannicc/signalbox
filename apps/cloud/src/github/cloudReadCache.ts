import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { GitHubError } from "./GitHubApi.ts";

const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Per-user reads share in-flight calls; authorization happens before looking here. */
export const makeReadCache = () => {
  const invalidators: Array<(scope?: string) => void> = [];
  const limited = new Map<string, { readonly until: number; readonly error: GitHubError }>();
  const retained = new Map<symbol, { readonly bytes: number; readonly evict: () => void }>();
  let retainedBytes = 0;
  const release = (id: symbol) => {
    const previous = retained.get(id);
    if (previous === undefined) return;
    retainedBytes -= previous.bytes;
    retained.delete(id);
  };

  const memoize = <I, A>(
    read: (input: I) => Effect.Effect<A, GitHubError>,
    keyOf: (input: I) => { readonly key: string; readonly scope: string; readonly token: string },
    ttl = 15_000,
  ) => {
    const entries = new Map<
      string,
      {
        readonly id: symbol;
        readonly scope: string;
        readonly read: Effect.Effect<A, GitHubError>;
        readonly evict: () => void;
      }
    >();
    invalidators.push((scope) => {
      for (const value of entries.values()) {
        if (scope === undefined || scope === value.scope) value.evict();
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
          const id = Symbol();
          const evict = () => {
            if (entries.get(key)?.id === id) entries.delete(key);
            release(id);
          };
          const shared = yield* read(input).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                if (entries.get(key)?.id !== id) return;
                release(id);
                // Budget all readers together, including UTF-16 strings and per-entry overhead.
                // Large results still reach shared callers without being retained by the cache.
                let bytes = Infinity;
                try {
                  bytes = encodeJson(value).length * 2 + key.length * 2 + 1024;
                } catch {
                  // A value that cannot be sized is still a successful read, just uncached.
                }
                if (bytes > MAX_RETAINED_BYTES) return evict();
                for (const oldest of retained.values()) {
                  if (retainedBytes + bytes <= MAX_RETAINED_BYTES) break;
                  oldest.evict();
                }
                retained.set(id, { bytes, evict });
                retainedBytes += bytes;
              }),
            ),
            Effect.tapError((error) =>
              Effect.gen(function* () {
                evict();
                if (error.retryAt === undefined) return;
                const at = yield* Clock.currentTimeMillis;
                if (limited.size >= 8) limited.delete(limited.keys().next().value!);
                limited.set(token, { until: Math.max(at, error.retryAt), error });
              }),
            ),
            Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? ttl : 0)),
          );
          if (entries.size >= 64) entries.values().next().value!.evict();
          entry = { id, scope, read: shared, evict };
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
