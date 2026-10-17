import { describe, expect, it } from "@effect/vitest";
import { initLogger, type WideEvent } from "evlog";
import { toSentryErrorEvent, toSentryLog } from "evlog/sentry";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Evlog from "./Evlog.ts";
import { redactContent } from "./content.ts";

class RejectedInput extends Schema.TaggedError<RejectedInput>()("RejectedInput", {
  cause: Schema.Defect(),
}) {}

describe("error content at the drain", () => {
  it.effect("keeps rejected input out of Sentry logs and issues", () => {
    const events: Array<WideEvent> = [];
    const canary = "canary-private-rejected-prompt";
    initLogger({
      silent: true,
      redact: { transform: redactContent },
      drain: ({ event }) => {
        events.push(event);
      },
    });
    return Effect.gen(function* () {
      yield* Effect.logError("cloud request failed", Cause.pretty(Cause.die(new Error(canary))));
      return yield* Effect.fail(new RejectedInput({ cause: new Error(canary) }));
    }).pipe(
      Evlog.withUnit("request.failure"),
      Effect.provide(Evlog.layer),
      Effect.exit,
      Effect.map(() => {
        expect(events).toHaveLength(1);
        const event = events[0]!;
        expect(event.level).toBe("error");
        expect(event.action).toBe("request.failure");
        const config = { dsn: "https://public@example.com/1" };
        const outgoing = JSON.stringify({
          event,
          log: toSentryLog(event, config),
          issue: toSentryErrorEvent(event, config),
        });
        expect(outgoing).not.toContain(canary);
      }),
    );
  });
});
