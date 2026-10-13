/**
 * Usage probes for hub accounts, paced and remembered. Every Limits visit,
 * refresh, and account change re-reads the hub, and providers rate-limit
 * their usage endpoints hard (Claude's answers 429 after a burst). So each
 * account is probed at most once a minute, a 429 backs off for five minutes,
 * and a failed probe shows the last good read for up to a quarter hour
 * instead of blanking the bars.
 *
 * Relies on its caller serializing reads (UsageLimitSources' refresh lock):
 * a probe still running when `expire` is called would write its older read
 * back afterwards.
 *
 * @module usage/hubProbeCache
 */
import type { UsageLimitSourceAccount } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

const PROBE_EVERY_MS = 60_000;
const RATE_LIMITED_BACKOFF_MS = 5 * 60_000;
const KEEP_GOOD_READ_MS = 15 * 60_000;
export const RATE_LIMITED_DETAIL =
  "The provider is rate limiting usage checks. Try again in a few minutes.";

/** The provider answered 429 to a request made through the hub. */
export class HubProviderRateLimited extends Schema.TaggedError<HubProviderRateLimited>()(
  "HubProviderRateLimited",
  { detail: Schema.String },
) {}
export const isHubProviderRateLimited = Schema.is(HubProviderRateLimited);

interface Entry {
  readonly good: { readonly read: UsageLimitSourceAccount; readonly at: number } | undefined;
  readonly nextProbeAt: number;
  readonly rateLimited: boolean;
}

export const makeHubProbeCache = Effect.gen(function* () {
  const entries = yield* Ref.make(new Map<string, Entry>());
  const remember = (key: string, entry: Entry) =>
    Ref.update(entries, (current) => new Map(current).set(key, entry));

  /**
   * `probe`, unless `key` was read within the minute or is backing off from a
   * 429; then the last good read. A failure shows the last good read while it
   * is under a quarter hour old, and fails otherwise.
   */
  const read = <E, R>(
    key: string,
    probe: Effect.Effect<UsageLimitSourceAccount, E, R>,
  ): Effect.Effect<UsageLimitSourceAccount, E | HubProviderRateLimited, R> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const entry = (yield* Ref.get(entries)).get(key);
      const good = entry?.good && now - entry.good.at < KEEP_GOOD_READ_MS ? entry.good : undefined;
      if (entry && now < entry.nextProbeAt) {
        if (good) return good.read;
        if (entry.rateLimited) {
          return yield* new HubProviderRateLimited({ detail: RATE_LIMITED_DETAIL });
        }
      }
      return yield* probe.pipe(
        Effect.flatMap((fresh) =>
          Effect.gen(function* () {
            // Numbers missing from a read that succeeded count as a failed read.
            if (fresh.usageLimits.unavailable?.reason === "probeFailed" && good) {
              yield* remember(key, { good, nextProbeAt: now + PROBE_EVERY_MS, rateLimited: false });
              return good.read;
            }
            yield* remember(key, {
              good: { read: fresh, at: now },
              nextProbeAt: now + PROBE_EVERY_MS,
              rateLimited: false,
            });
            return fresh;
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const rateLimited = isHubProviderRateLimited(error);
            yield* remember(key, {
              good,
              nextProbeAt: now + (rateLimited ? RATE_LIMITED_BACKOFF_MS : PROBE_EVERY_MS),
              rateLimited,
            });
            if (good) return good.read;
            return yield* Effect.fail(error);
          }),
        ),
      );
    });

  /**
   * Makes the next read probe again, after a change such as a redeemed reset or
   * a resumed account. The last good read stays as the fallback.
   */
  const expire = (key: string) =>
    Ref.update(entries, (current) => {
      const entry = current.get(key);
      return entry ? new Map(current).set(key, { ...entry, nextProbeAt: 0 }) : current;
    });

  return { read, expire };
});
