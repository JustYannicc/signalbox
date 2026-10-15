/**
 * The spike's Worker: everything goes to one person's AutomationHost.
 *
 *   GET  /                       status: runs, executions, asks, messages, alarm
 *   POST /runs                   { automation, input, trigger? } starts a run
 *   POST /asks/:id/answer        { choice, values? } answers a needs-you
 *   POST /events                 { event, ...fields } a Signalbox event (pr.*, turn.*, …)
 *   POST /threads/:id/turn       { text, pullRequest? } an agent's turn ended
 *   ANY  /hooks/:id              a callback link was called
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";

import AutomationHost from "./AutomationHost.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    name: "signalbox-spike-349",
    compatibility: { date: "2026-10-01", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const hosts = yield* AutomationHost;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        return yield* hosts.getByName("yannic").fetch(request);
      }),
    };
  }),
) {}
