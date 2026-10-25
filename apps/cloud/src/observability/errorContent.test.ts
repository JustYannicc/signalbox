import { describe, expect, it } from "@effect/vitest";
import { initLogger, type WideEvent } from "evlog";
import { toSentryErrorEvent, toSentryLog } from "evlog/sentry";
import { withEvlog } from "evlog/workers";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Evlog from "./Evlog.ts";
import { redactContent } from "./content.ts";

class RejectedInput extends Schema.TaggedError<RejectedInput>()("RejectedInput", {
  cause: Schema.Defect(),
}) {}

describe("error content at the drain", () => {
  it.each(
    [
      "/api/hooks",
      "/api//hooks",
      "/api/Hooks",
      "/api/%68ooks",
      "/api/hoo%E2%84%AAs",
      "/api//HOO%E2%84%AAS",
    ].flatMap((prefix) => [false, true].map((fails) => ({ prefix, fails }))),
  )(
    "keeps hook credentials out of $prefix request events (failure: $fails)",
    async ({ prefix, fails }) => {
      const events: Array<WideEvent> = [];
      const pending: Array<Promise<unknown>> = [];
      const canary = "hook_canary_private_trigger";
      initLogger({ silent: true });
      const worker = withEvlog(
        async () => {
          if (fails) throw new Error("Hook failed");
          return new Response(null, { status: 202 });
        },
        {
          redact: { transform: redactContent },
          drain: ({ event }) => {
            events.push(event);
          },
        },
      );
      await worker
        .fetch(
          new Request(`https://example.com${prefix}/user_1/hook_1/${canary}`),
          {},
          {
            waitUntil: (promise) => {
              pending.push(promise);
            },
          },
        )
        .catch(() => undefined);
      await Promise.all(pending);
      expect(events).toHaveLength(1);
      const event = events[0]!;
      const config = { dsn: "https://public@example.com/1" };
      expect(
        JSON.stringify({
          event,
          log: toSentryLog(event, config),
          issue: toSentryErrorEvent(event, config),
        }),
      ).not.toContain(canary);
      expect(event.path).toBe("/api/hooks/:userId/:hookId/[REDACTED]");
      expect(event.method).toBe("GET");
      expect(event.status).toBe(fails ? 500 : 202);
    },
  );

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
