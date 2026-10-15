import * as Effect from "effect/Effect";

/**
 * Spans for a user object's operations, with who did it and what it touched
 * (#284): ids only, never a name, instruction or message. A span's duration
 * is the operation's latency. `person`: the object's owner, null before they
 * first sign in.
 */
export const makeTraced =
  <E, R>(person: Effect.Effect<string | null, E, R>) =>
  (name: string, attributes: Readonly<Record<string, string | number | null | undefined>>) =>
  <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
    Effect.flatMap(person.pipe(Effect.orElseSucceed(() => null)), (id) =>
      effect.pipe(
        Effect.withSpan(name, {
          attributes: Object.fromEntries(
            Object.entries({ "person.id": id, ...attributes }).filter(
              ([, value]) => value !== null && value !== undefined,
            ),
          ),
        }),
      ),
    );
