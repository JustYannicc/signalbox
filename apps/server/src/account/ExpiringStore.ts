import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/**
 * In-memory, bounded, TTL map for short-lived sign-in state (pending attempts,
 * native handoffs). Losing it on restart is fine: the callback reports
 * `expired` and the user tries again.
 *
 * Every operation reads the clock once and then touches the map in a single
 * synchronous step, so `modify` is atomic across fibers. That is what makes a
 * handoff single use.
 */
export interface ExpiringStore<A> {
  readonly put: (key: string, value: A) => Effect.Effect<void>;
  /** Reads and deletes. Expired entries read as missing. */
  readonly take: (key: string) => Effect.Effect<A | undefined>;
  /**
   * Atomically reads an entry and decides what to keep. `f` receives the live
   * value (or `undefined`) and returns the result plus the value to store back,
   * `undefined` to delete. The original expiry is kept.
   */
  readonly modify: <B>(
    key: string,
    f: (value: A | undefined) => readonly [B, A | undefined],
  ) => Effect.Effect<B>;
}

interface Entry<A> {
  readonly value: A;
  readonly expiresAt: number;
}

export const makeExpiringStore = <A>(options: {
  readonly ttl: Duration.Input;
  readonly maxEntries: number;
}): ExpiringStore<A> => {
  const ttlMillis = Duration.toMillis(options.ttl);
  const entries = new Map<string, Entry<A>>();

  const purgeExpired = (now: number) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  };

  const put = (key: string, value: A) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() => {
        purgeExpired(now);
        // Map iteration is insertion order, so the first key is the oldest.
        while (entries.size >= options.maxEntries) {
          const oldest = entries.keys().next();
          if (oldest.done) break;
          entries.delete(oldest.value);
        }
        entries.set(key, { value, expiresAt: now + ttlMillis });
      }),
    );

  const modify = <B>(key: string, f: (value: A | undefined) => readonly [B, A | undefined]) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() => {
        const entry = entries.get(key);
        const live = entry !== undefined && entry.expiresAt > now ? entry : undefined;
        const [result, next] = f(live?.value);
        if (live !== undefined && next !== undefined) {
          entries.set(key, { value: next, expiresAt: live.expiresAt });
        } else {
          entries.delete(key);
        }
        return result;
      }),
    );

  const take = (key: string) => modify(key, (value) => [value, undefined] as const);

  return { put, take, modify };
};
