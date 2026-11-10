import * as Effect from "effect/Effect";

import { IDLE_TIMEOUT_MS } from "../PoolContainer.ts";

export const makeActivity = (input: {
  readonly now: () => number;
  readonly onIdleFrom: (at: number) => void;
}) => {
  const { now, onIdleFrom } = input;
  let inFlight = 0;
  let lastEnded: number | null = null;
  const end = () => {
    inFlight -= 1;
    lastEnded = now();
    if (inFlight === 0) onIdleFrom(lastEnded);
  };
  return {
    track: <E>(send: () => Effect.Effect<Response, E>) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          inFlight += 1;
        });
        let handedOff = false;
        let ended = false;
        const once = () => {
          if (!ended) {
            ended = true;
            end();
          }
        };
        return yield* Effect.ensuring(
          Effect.gen(function* () {
            const response = yield* send();
            if (response.body === null) {
              once();
              handedOff = true;
              return response;
            }
            // Ends on the last chunk, an error, or a reader that gives up.
            const reader = response.body.getReader();
            const body = new ReadableStream<Uint8Array>(
              {
                pull: async (controller) => {
                  try {
                    const { done, value } = await reader.read();
                    if (done) {
                      once();
                      controller.close();
                    } else {
                      controller.enqueue(value);
                    }
                  } catch (error) {
                    once();
                    controller.error(error);
                  }
                },
                cancel: (reason) => {
                  once();
                  return reader.cancel(reason);
                },
              },
              { highWaterMark: 0 },
            );
            const tracked = new Response(body, response);
            handedOff = true;
            return tracked;
          }),
          Effect.sync(() => {
            if (!handedOff) once();
          }),
        );
      }),
    /** When the container may sleep, given nothing new arrives; null while a request is open. */
    sleepAt: () => (inFlight > 0 ? null : lastEnded === null ? 0 : lastEnded + IDLE_TIMEOUT_MS),
  };
};
