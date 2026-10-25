import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

// React Native has no global crypto; these keys identify retries, not credentials.
const nextCommandId = Effect.map(
  Effect.all([Random.next, Random.next]),
  ([high, low]) => `tw-${high.toString(36).slice(2)}${low.toString(36).slice(2)}`,
);

export function withTerminalCommandId<TInput, A, E, R>(
  method: string,
  input: TInput,
  send: (input: TInput) => Effect.Effect<A, E, R>,
) {
  if (
    method !== WS_METHODS.terminalWrite ||
    (typeof input === "object" &&
      input !== null &&
      "commandId" in input &&
      input.commandId !== undefined)
  )
    return send(input);

  // Allocate once per constructed request so retrying the effect never types twice.
  let keyed: TInput | undefined;
  return Effect.suspend(() =>
    keyed !== undefined
      ? send(keyed)
      : Effect.flatMap(nextCommandId, (commandId) => {
          keyed = { ...input, commandId };
          return send(keyed);
        }),
  );
}
